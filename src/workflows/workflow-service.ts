/**
 * Workflow Service for CamBot-Agent
 *
 * Bridges cambot-workflows runtime engine into the agent host process.
 * Workflows run on the host (not in containers) so they can be long-running.
 * Agent steps spawn a container using the existing Agent SDK + OAuth auth.
 */
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { createEventBus, createBackupService, loadConfig } from 'cambot-core';
import type { EventBus } from 'cambot-core';
import { execSync } from 'child_process';
import { statSync, readdirSync, unlinkSync, existsSync } from 'fs';
import {
  loadWorkflow,
  createWorkflowRunStore,
  createWorkflowStepRunStore,
  createWorkflowRunner,
  createPolicyEngine,
  createDefaultToolRegistry,
  renderTemplate,
  createContainerCleanupTool,
  createMcpHealthTool,
  createChannelCheckTool,
  createDiskSpaceTool,
  createWalCheckpointTool,
  createStuckWorkflowsTool,
  createIpcCleanupTool,
  createStaleTasksTool,
  createMessageBacklogTool,
  createCostSummaryTool,
  createChainVerifyTool,
  // Maintenance tools
  createNightlyBackupTool,
  createDecayUpdateTool,
  createTelemetryPruneTool,
  createFullBackupTool,
  createQualityPurgeTool,
  createOrphanCleanupTool,
  createFtsCheckTool,
  createSqliteOptimizeTool,
  createHardDeleteTool,
  createMessageArchiveTool,
  createDedupRunTool,
} from 'cambot-workflows';
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunner,
  StepOutput,
  StepCallbackResult,
  MessageComposeFn,
  StepTypeDeps,
  MutableToolRegistry,
  WorkflowRunStore,
  WorkflowStepRunStore,
  ChannelProbe,
} from 'cambot-workflows';

import { DATA_DIR } from '../config/config.js';
import type { ContainerInput } from '../container/runner.js';
import { getDatabase } from '../db/index.js';
import { createAgentRepository } from '../db/agent-repository.js';
import { logger } from '../logger.js';
import type { MessageBus } from '../types.js';
import { OutboundMessage } from '../bus/index.js';

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Strip markdown code fences from LLM responses.
 * Handles ```json ... ```, ```...```, and plain text.
 * @internal Exported for testing.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1].trim() : trimmed;
}

// ── Public interface ─────────────────────────────────────────────────

export interface WorkflowService {
  reloadDefinitions(): void;
  listWorkflows(): WorkflowDefinition[];
  getWorkflow(id: string): WorkflowDefinition | undefined;
  hasActiveRun(workflowId: string): boolean;
  runWorkflow(workflowId: string): Promise<string>;
  resumeWorkflow(runId: string, workflowId: string): Promise<string>;
  getRunStatus(runId: string): WorkflowRun | null;
  listRuns(workflowId?: string, limit?: number): WorkflowRun[];
  pauseRun(runId: string): void;
  cancelRun(runId: string): void;
}

/**
 * Input for the agent container callback.
 * When customAgent is present, the container forks to the custom-agent-runner
 * using the specified provider (OpenAI, XAI, etc.) instead of Claude.
 */
export interface AgentStepInput {
  prompt: string;
  customAgent?: ContainerInput['customAgent'];
}

/**
 * Result from a container-based agent run.
 * Includes the text response and optional telemetry for cost tracking.
 */
export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AgentContainerResult {
  text: string;
  totalCostUsd?: number;
  tokensIn?: number;
  tokensOut?: number;
  modelUsage?: Record<string, ModelUsageEntry>;
}

/**
 * Callback that runs a prompt through a container-based agent.
 * Returns the agent's text response and optional telemetry. Spawns a real container using
 * the existing OAuth token + Agent SDK (or a custom provider when customAgent is set).
 */
export type RunAgentContainerFn = (input: AgentStepInput) => Promise<AgentContainerResult>;

export interface WorkflowServiceDeps {
  db: Database.Database;
  runAgentContainer: RunAgentContainerFn;
  messageBus: MessageBus;
  /** Optional: provides channel connectivity info for heartbeat checks. */
  getChannels?: () => ChannelProbe[];
  /** Admin JID — used to resolve `channel: main` in workflow message steps. */
  adminJid?: string;
  /** Optional: callback to record step-level costs to the core telemetry system. */
  onStepCost?: (cost: { provider: string; model: string; tokensIn: number; tokensOut: number; costUsd: number; taskLabel: string }) => void;
}

// ── Heartbeat tool registration ──────────────────────────────────────

function execAsync(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    try {
      const stdout = execSync(cmd, { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] });
      resolve({ stdout, stderr: '' });
    } catch (err: any) {
      if (err.stdout || err.stderr) {
        resolve({ stdout: err.stdout ?? '', stderr: err.stderr ?? '' });
      } else {
        reject(err);
      }
    }
  });
}

function getDirSizeRecursive(dirPath: string): number {
  const resolved = path.resolve(dirPath);
  if (!existsSync(resolved)) return 0;
  let total = 0;
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    const full = path.join(resolved, entry.name);
    if (entry.isFile()) {
      total += statSync(full).size;
    } else if (entry.isDirectory()) {
      total += getDirSizeRecursive(full);
    }
  }
  return total;
}

function listJsonFiles(dir: string): Array<{ path: string; mtimeMs: number }> {
  const resolved = path.resolve(dir);
  if (!existsSync(resolved)) return [];
  const results: Array<{ path: string; mtimeMs: number }> = [];
  for (const entry of readdirSync(resolved, { withFileTypes: true })) {
    const full = path.join(resolved, entry.name);
    if (entry.isFile() && entry.name.endsWith('.json')) {
      results.push({ path: full, mtimeMs: statSync(full).mtimeMs });
    } else if (entry.isDirectory()) {
      results.push(...listJsonFiles(full));
    }
  }
  return results;
}

function hasCostLedgerTable(db: Database.Database): boolean {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='cost_ledger'",
  ).get() as { name: string } | undefined;
  return !!row;
}

function registerHeartbeatTools(
  registry: MutableToolRegistry,
  deps: WorkflowServiceDeps,
): void {
  registry.set('heartbeat-container-cleanup', createContainerCleanupTool({
    exec: execAsync,
  }));

  registry.set('heartbeat-mcp-health', createMcpHealthTool({
    fetchFn: globalThis.fetch,
  }));

  registry.set('heartbeat-channel-check', createChannelCheckTool({
    getChannels: deps.getChannels ?? (() => []),
  }));

  registry.set('heartbeat-disk-space', createDiskSpaceTool({
    getDirSize: async (dirPath: string) => getDirSizeRecursive(dirPath),
  }));

  registry.set('heartbeat-wal-checkpoint', createWalCheckpointTool({
    getDb: () => deps.db,
  }));

  registry.set('heartbeat-stuck-workflows', createStuckWorkflowsTool({
    getDb: () => deps.db,
  }));

  registry.set('heartbeat-ipc-cleanup', createIpcCleanupTool({
    listFiles: async (dir: string) => listJsonFiles(dir),
    deleteFile: async (filePath: string) => unlinkSync(filePath),
    dirExists: async (dir: string) => existsSync(path.resolve(dir)),
  }));

  registry.set('heartbeat-stale-tasks', createStaleTasksTool({
    getDb: () => deps.db,
  }));

  registry.set('heartbeat-message-backlog', createMessageBacklogTool({
    getDb: () => deps.db,
  }));

  registry.set('heartbeat-cost-summary', createCostSummaryTool({
    getDb: () => deps.db,
    hasCostLedger: hasCostLedgerTable(deps.db),
  }));

  registry.set('heartbeat-chain-verify', createChainVerifyTool({
    getDb: () => deps.db,
  }));
}

// ── Maintenance tool registration ─────────────────────────────────────

function registerMaintenanceTools(
  registry: MutableToolRegistry,
  deps: WorkflowServiceDeps,
): void {
  const getDb = () => deps.db;
  const config = loadConfig({
    registerHook() { /* no-op */ },
    registerTool() { /* no-op */ },
  });
  const backupService = createBackupService(config, null);

  // Nightly
  registry.set('maintenance-nightly-backup', createNightlyBackupTool({ getDb, backupService }));
  registry.set('maintenance-decay-update', createDecayUpdateTool({ getDb }));
  registry.set('maintenance-telemetry-prune', createTelemetryPruneTool({ getDb }));

  // Weekly
  registry.set('maintenance-full-backup', createFullBackupTool({ getDb, backupService }));
  registry.set('maintenance-quality-purge', createQualityPurgeTool({ getDb }));
  registry.set('maintenance-orphan-cleanup', createOrphanCleanupTool({ getDb }));
  registry.set('maintenance-fts-check', createFtsCheckTool({ getDb }));

  // Monthly
  registry.set('maintenance-sqlite-optimize', createSqliteOptimizeTool({ getDb }));
  registry.set('maintenance-hard-delete', createHardDeleteTool({ getDb }));
  registry.set('maintenance-message-archive', createMessageArchiveTool({
    getDb,
    archiveDir: path.join(DATA_DIR, 'archives'),
  }));
  registry.set('maintenance-dedup-run', createDedupRunTool({
    getDb,
    geminiApiKey: process.env.GEMINI_API_KEY ?? '',
  }));
}

// ── Factory ──────────────────────────────────────────────────────────

export function createWorkflowService(deps: WorkflowServiceDeps): WorkflowService {
  const { db } = deps;
  const agentRepo = createAgentRepository(getDatabase());
  const workflowsDir = path.join(DATA_DIR, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  // Lightweight event bus — no DB persistence for workflow events
  const eventBus: EventBus = createEventBus(null);

  // Cost bridge — forwards workflow step costs to the core telemetry system
  const costLedger = {
    upsert(_db: Database.Database, input: {
      date: string; provider: string; model: string;
      tokensIn: number; tokensOut: number; costUsd: number;
      callCount: number; taskLabel?: string;
    }): void {
      logger.debug(
        { provider: input.provider, model: input.model, cost: input.costUsd },
        'Workflow cost recorded',
      );
      if (deps.onStepCost && input.costUsd > 0) {
        deps.onStepCost({
          provider: input.provider,
          model: input.model,
          tokensIn: input.tokensIn,
          tokensOut: input.tokensOut,
          costUsd: input.costUsd,
          taskLabel: input.taskLabel ?? 'workflow',
        });
      }
    },
  };

  const securityEvents = {
    insert(_db: Database.Database, input: {
      severity: string; eventType: string; source: string;
      description: string; details?: Record<string, unknown>;
    }): unknown {
      logger.warn(
        { severity: input.severity, eventType: input.eventType },
        `Workflow security event: ${input.description}`,
      );
      return null;
    },
  };

  // Stores (stateless — pass db on each call)
  const runStore: WorkflowRunStore = createWorkflowRunStore();
  const stepStore: WorkflowStepRunStore = createWorkflowStepRunStore();

  // ── Agent step: spawns a container via the Agent SDK ───────────────

  /** Default env var name for each provider's API key. */
  const DEFAULT_API_KEY_ENV: Record<string, string> = {
    openai: 'OPENAI_API_KEY',
    xai: 'XAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_API_KEY',
  };

  /**
   * Resolve a customAgent payload from step config.
   *
   * Three modes:
   * 1. agentId only → look up custom_agents table, use its provider config
   * 2. Inline provider fields (provider, model) → build directly
   * 3. agentId + inline overrides → start from DB row, overlay overrides
   * 4. Neither → return undefined (default Claude container)
   *
   * apiKeyEnvVar is optional — defaults to the standard env var for the provider.
   */
  function resolveCustomAgent(
    config: Record<string, unknown>,
  ): ContainerInput['customAgent'] | undefined {
    const agentId = config.agentId as string | undefined;
    const inlineProvider = config.provider as string | undefined;

    // Mode 4: no custom agent config — default Claude behavior
    if (!agentId && !inlineProvider) return undefined;

    // Start from DB row if agentId is present
    let base: ContainerInput['customAgent'] | undefined;
    if (agentId) {
      const row = agentRepo.getById(agentId);
      if (!row) {
        logger.warn({ agentId }, 'Agent not found in registered_agents, falling back to default');
        // If there's no inline provider either, fall back to default
        if (!inlineProvider) return undefined;
      } else {
        base = {
          agentId: row.id,
          provider: row.provider as 'openai' | 'xai' | 'anthropic' | 'google',
          model: row.model,
          baseUrl: row.baseUrl ?? undefined,
          apiKeyEnvVar: row.secretKeys[0] ?? '',
          systemPrompt: row.systemPrompt ?? '',
          tools: row.tools,
          maxTokens: row.maxTokens ?? undefined,
          temperature: row.temperature ?? undefined,
          maxIterations: 10,
          timeoutMs: row.timeoutMs,
        };
      }
    }

    // Mode 2: pure inline config (no agentId or agentId not found)
    if (!base) {
      const provider = inlineProvider as 'openai' | 'xai' | 'anthropic' | 'google';
      return {
        agentId: agentId ?? `inline-${Date.now()}`,
        provider,
        model: String(config.model ?? ''),
        baseUrl: config.baseUrl as string | undefined,
        apiKeyEnvVar: String(config.apiKeyEnvVar || DEFAULT_API_KEY_ENV[provider] || ''),
        systemPrompt: String(config.systemPrompt ?? ''),
        tools: (config.tools as string[]) ?? [],
        maxTokens: config.maxTokens as number | undefined,
        temperature: config.temperature as number | undefined,
        maxIterations: (config.maxIterations as number) ?? 10,
        timeoutMs: (config.timeoutMs as number) ?? 120_000,
      };
    }

    // Mode 3: agentId + inline overrides
    if (inlineProvider) base.provider = inlineProvider as typeof base.provider;
    if (config.model) base.model = String(config.model);
    if (config.baseUrl !== undefined) base.baseUrl = config.baseUrl as string | undefined;
    if (config.apiKeyEnvVar) base.apiKeyEnvVar = String(config.apiKeyEnvVar);
    if (config.systemPrompt) base.systemPrompt = String(config.systemPrompt);
    if (config.temperature !== undefined) base.temperature = config.temperature as number;
    if (config.maxTokens !== undefined) base.maxTokens = config.maxTokens as number;

    return base;
  }

  async function runAgentPrompt(
    config: Record<string, unknown>,
    previousOutputs: Record<string, unknown>,
  ): Promise<StepCallbackResult> {
    // Build the prompt from step config + previous outputs
    let prompt = String(config.prompt ?? '');
    if (Object.keys(previousOutputs).length > 0) {
      prompt += '\n\n<previous_step_outputs>\n';
      for (const [stepId, data] of Object.entries(previousOutputs)) {
        const serialized = typeof data === 'string' ? data : JSON.stringify(data);
        prompt += `[${stepId}]: ${serialized}\n`;
      }
      prompt += '</previous_step_outputs>';
    }

    // If model is specified but no provider/agentId, default to Anthropic
    // so the container uses the correct (cheaper) model instead of the default.
    const resolveConfig = { ...config };
    if (resolveConfig.model && !resolveConfig.provider && !resolveConfig.agentId) {
      resolveConfig.provider = 'anthropic';
    }

    // Resolve custom agent (if agentId or inline provider fields are present)
    const customAgent = resolveCustomAgent(resolveConfig);

    logger.info(
      {
        promptLength: prompt.length,
        customAgent: customAgent ? { agentId: customAgent.agentId, provider: customAgent.provider, model: customAgent.model } : undefined,
      },
      'Workflow agent step: spawning container',
    );

    const startTime = Date.now();
    const containerResult = await deps.runAgentContainer({ prompt, customAgent });
    const durationMs = Date.now() - startTime;

    logger.info(
      { durationMs, resultLength: containerResult.text.length, costUsd: containerResult.totalCostUsd },
      'Workflow agent step completed',
    );

    // Agent steps are typically prompted to return JSON. Parse it so
    // downstream gate steps can access fields (e.g. data.has_alerts).
    // Falls back to raw string if the response isn't valid JSON.
    let parsedData: unknown = containerResult.text;
    try {
      parsedData = JSON.parse(stripCodeFences(containerResult.text));
    } catch {
      // Keep as raw string
    }

    return {
      data: parsedData,
      tokensIn: containerResult.tokensIn ?? 0,
      tokensOut: containerResult.tokensOut ?? 0,
      costUsd: containerResult.totalCostUsd ?? 0,
      metadata: { durationMs, customAgent: customAgent?.agentId, modelUsage: containerResult.modelUsage },
    };
  }

  // Tool registry
  const toolRegistry = createDefaultToolRegistry();
  registerHeartbeatTools(toolRegistry, deps);
  registerMaintenanceTools(toolRegistry, deps);

  // AI compose function for message steps
  const composeFn: MessageComposeFn = async (prompt, model) => {
    logger.info({ model, promptLength: prompt.length }, 'Message AI compose: starting');
    const customAgent = resolveCustomAgent(model ? { provider: 'anthropic', model } : {});
    const containerResult = await deps.runAgentContainer({ prompt, customAgent });
    logger.info({
      resultLength: containerResult.text.length,
      cost_usd: containerResult.totalCostUsd,
      tokens_in: containerResult.tokensIn,
      tokens_out: containerResult.tokensOut,
      model,
    }, 'Message AI compose: complete');
    return {
      data: containerResult.text,
      tokensIn: containerResult.tokensIn ?? 0,
      tokensOut: containerResult.tokensOut ?? 0,
      costUsd: containerResult.totalCostUsd ?? 0,
      metadata: { modelUsage: containerResult.modelUsage },
    };
  };

  // Step type dependencies for workflow step execution
  const factoryDeps: StepTypeDeps = {
    eventBus,
    agentFn: runAgentPrompt,
    toolRegistry,
    composeFn,
    searchFn: async (query, _config) => {
      logger.info({ query }, 'Workflow memory step (stub)');
      return { data: { results: [] }, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    },
  };

  // Deliver completed message steps via the message bus
  function deliverMessage(
    channel: string,
    text: string,
    config: Record<string, unknown>,
    workflowId: string,
  ): void {
    let jid: string;
    if (channel === 'file') {
      const rawPath = (config.filePath as string) ?? `output/${workflowId}-{{date}}.md`;
      const resolvedPath = renderTemplate(rawPath, {}, { workflowId });
      jid = `file:${resolvedPath}`;
    } else if (channel === 'imessage') {
      const recipient = config.recipient as string | undefined;
      if (recipient) {
        jid = `im:${recipient}`;
      } else {
        logger.warn('Workflow message targets channel "imessage" but no recipient configured — message will be dropped');
        jid = 'im:unknown';
      }
    } else if (channel === 'main' && deps.adminJid) {
      jid = deps.adminJid;
    } else if (channel === 'main') {
      logger.warn('Workflow message targets channel "main" but adminJid is not configured — message will be dropped');
      jid = `${channel}:default`;
    } else {
      jid = `${channel}:default`;
    }
    deps.messageBus.emit(new OutboundMessage('workflow', jid, text)).catch((err) => {
      logger.error({ err, channel }, 'Workflow message bus delivery failed');
    });
  }

  eventBus.on('*', (event) => {
    if (event.type !== 'workflow.step.completed') return;
    const data = event.data as Record<string, unknown>;
    if (data.stepType !== 'message') return;

    const output = data.output as Record<string, unknown> | undefined;
    if (!output) return;

    const channel = typeof output.channel === 'string' ? output.channel : undefined;
    if (!channel) return;

    const content = typeof output.content === 'string' ? output.content : '';
    const workflowId = data.workflowId as string;

    deliverMessage(channel, content, output, workflowId);
  });

  // In-memory workflow definition cache
  let definitions = new Map<string, WorkflowDefinition>();

  // Per-workflow runner cache (each workflow has its own policy engine + runner)
  const runners = new Map<string, WorkflowRunner>();

  function getOrCreateRunner(workflow: WorkflowDefinition): WorkflowRunner {
    let runner = runners.get(workflow.id);
    if (!runner) {
      const policy = createPolicyEngine(workflow.policy);
      runner = createWorkflowRunner(
        { db, eventBus, costLedger, securityEvents },
        { runs: runStore, steps: stepStore },
        policy,
        factoryDeps,
      );
      runners.set(workflow.id, runner);
    }
    return runner;
  }

  /** Cached file mtimes from last successful reload, keyed by filename. */
  let lastMtimes = new Map<string, number>();

  /** Reverse map: filename → workflow ID (for deletion tracking). */
  let fileToId = new Map<string, string>();

  return {
    reloadDefinitions(): void {
      if (!fs.existsSync(workflowsDir)) {
        if (definitions.size > 0) {
          definitions = new Map();
          runners.clear();
          lastMtimes = new Map();
          fileToId = new Map();
          logger.info({ count: 0 }, 'Workflow definitions loaded');
        }
        return;
      }

      const currentFiles = new Set(
        fs.readdirSync(workflowsDir).filter(f =>
          f.endsWith('.yaml') || f.endsWith('.yml'),
        ),
      );

      // Detect deleted files
      const deletedFiles = [...lastMtimes.keys()].filter(f => !currentFiles.has(f));
      for (const file of deletedFiles) {
        const id = fileToId.get(file);
        if (id) {
          definitions.delete(id);
          runners.delete(id);
          logger.info({ workflowId: id, file }, 'Workflow removed');
        }
        lastMtimes.delete(file);
        fileToId.delete(file);
      }

      // Process new and changed files
      let changed = deletedFiles.length > 0;
      for (const file of currentFiles) {
        const filePath = path.join(workflowsDir, file);
        const mtime = fs.statSync(filePath).mtimeMs;

        if (lastMtimes.get(file) === mtime) continue; // Unchanged

        try {
          const yamlContent = fs.readFileSync(filePath, 'utf-8');
          const workflow = loadWorkflow(yamlContent);

          // If this file previously mapped to a different workflow ID, clean up
          const prevId = fileToId.get(file);
          if (prevId && prevId !== workflow.id) {
            definitions.delete(prevId);
            runners.delete(prevId);
          }

          definitions.set(workflow.id, workflow);
          runners.delete(workflow.id); // Invalidate cached runner for changed definition
          lastMtimes.set(file, mtime);
          fileToId.set(file, workflow.id);
          changed = true;
          logger.info({ workflowId: workflow.id, name: workflow.name }, 'Workflow loaded');
        } catch (err) {
          logger.error({ file, err }, 'Failed to load workflow definition');
        }
      }

      if (changed) {
        logger.info({ count: definitions.size }, 'Workflow definitions loaded');
      }
    },

    listWorkflows(): WorkflowDefinition[] {
      return [...definitions.values()];
    },

    getWorkflow(id: string): WorkflowDefinition | undefined {
      return definitions.get(id);
    },

    hasActiveRun(workflowId: string): boolean {
      const recent = runStore.listByWorkflow(db, workflowId, 10);
      return recent.some(r => r.status === 'running' || r.status === 'pending');
    },

    async runWorkflow(workflowId: string): Promise<string> {
      const workflow = definitions.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow not found: ${workflowId}`);
      }

      const runner = getOrCreateRunner(workflow);
      return runner.run(workflow);
    },

    async resumeWorkflow(runId: string, workflowId: string): Promise<string> {
      const workflow = definitions.get(workflowId);
      if (!workflow) {
        throw new Error(`Workflow not found: ${workflowId}`);
      }

      const runner = getOrCreateRunner(workflow);
      return runner.run(workflow, { resumeRunId: runId });
    },

    getRunStatus(runId: string): WorkflowRun | null {
      return runStore.getByRunId(db, runId);
    },

    listRuns(workflowId?: string, limit = 20): WorkflowRun[] {
      if (workflowId) {
        return runStore.listByWorkflow(db, workflowId, limit);
      }
      // All recent runs across all workflows
      const allRuns: WorkflowRun[] = [];
      for (const wf of definitions.values()) {
        allRuns.push(...runStore.listByWorkflow(db, wf.id, limit));
      }
      return allRuns
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit);
    },

    pauseRun(runId: string): void {
      const run = runStore.getByRunId(db, runId);
      if (!run) {
        throw new Error(`Workflow run not found: ${runId}`);
      }
      if (run.status !== 'running' && run.status !== 'pending') {
        throw new Error(`Cannot pause run in status: ${run.status}`);
      }
      runStore.updateStatus(db, runId, 'paused');
      logger.info({ runId }, 'Workflow run paused');
    },

    cancelRun(runId: string): void {
      const run = runStore.getByRunId(db, runId);
      if (!run) {
        throw new Error(`Workflow run not found: ${runId}`);
      }
      if (run.status === 'completed' || run.status === 'failed') {
        throw new Error(`Cannot cancel run in terminal status: ${run.status}`);
      }
      runStore.updateStatus(db, runId, 'failed', 'Cancelled by user');
      logger.info({ runId }, 'Workflow run cancelled');
    },
  };
}
