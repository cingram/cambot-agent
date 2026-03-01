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
import { createEventBus } from 'cambot-core';
import type { EventBus } from 'cambot-core';
import { execSync } from 'child_process';
import { statSync, readdirSync, unlinkSync, existsSync } from 'fs';
import {
  loadWorkflow,
  createWorkflowRunStore,
  createWorkflowStepRunStore,
  createWorkflowRunner,
  createPolicyEngine,
  createAgentHandler,
  createToolDispatcher,
  createDefaultToolRegistry,
  createMemoryHandler,
  createMessageHandler,
  createGateHandler,
  createParallelHandler,
  createSyncHandler,
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
} from 'cambot-workflows';
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunner,
  StepHandler,
  StepOutput,
  WorkflowRunStore,
  WorkflowStepRunStore,
  ChannelProbe,
} from 'cambot-workflows';

import { DATA_DIR } from './config.js';
import type { ContainerInput } from './container-runner.js';
import { getCustomAgent } from './db.js';
import { logger } from './logger.js';
import type { MessageBus } from './types.js';

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
 * Callback that runs a prompt through a container-based agent.
 * Returns the agent's text response. Spawns a real container using
 * the existing OAuth token + Agent SDK (or a custom provider when customAgent is set).
 */
export type RunAgentContainerFn = (input: AgentStepInput) => Promise<string>;

export interface WorkflowServiceDeps {
  db: Database.Database;
  runAgentContainer: RunAgentContainerFn;
  messageBus: MessageBus;
  /** Optional: provides channel connectivity info for heartbeat checks. */
  getChannels?: () => ChannelProbe[];
  /** Admin JID — used to resolve `channel: main` in workflow message steps. */
  adminJid?: string;
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
  registry: Map<string, any>,
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

// ── Factory ──────────────────────────────────────────────────────────

export function createWorkflowService(deps: WorkflowServiceDeps): WorkflowService {
  const { db } = deps;
  const workflowsDir = path.join(DATA_DIR, 'workflows');
  fs.mkdirSync(workflowsDir, { recursive: true });

  // Lightweight event bus — no DB persistence for workflow events
  const eventBus: EventBus = createEventBus(null);

  // Log-only stubs (no cambot-core schema in agent DB)
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
      const row = getCustomAgent(agentId);
      if (!row) {
        logger.warn({ agentId }, 'Custom agent not found, falling back to default');
        // If there's no inline provider either, fall back to default
        if (!inlineProvider) return undefined;
      } else {
        base = {
          agentId: row.id,
          provider: row.provider as 'openai' | 'xai' | 'anthropic' | 'google',
          model: row.model,
          baseUrl: row.base_url ?? undefined,
          apiKeyEnvVar: row.api_key_env_var,
          systemPrompt: row.system_prompt,
          tools: JSON.parse(row.tools) as string[],
          maxTokens: row.max_tokens ?? undefined,
          temperature: row.temperature ?? undefined,
          maxIterations: row.max_iterations,
          timeoutMs: row.timeout_ms,
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
  ): Promise<StepOutput> {
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
    const result = await deps.runAgentContainer({ prompt, customAgent });
    const durationMs = Date.now() - startTime;

    logger.info(
      { durationMs, resultLength: result.length },
      'Workflow agent step completed',
    );

    // Agent steps are typically prompted to return JSON. Parse it so
    // downstream gate steps can access fields (e.g. data.has_alerts).
    // Falls back to raw string if the response isn't valid JSON.
    let parsedData: unknown = result;
    try {
      parsedData = JSON.parse(stripCodeFences(result));
    } catch {
      // Keep as raw string
    }

    // Token counts aren't available from the Agent SDK container path.
    // Cost tracking relies on the container's own telemetry.
    return {
      data: parsedData,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      metadata: { durationMs, customAgent: customAgent?.agentId },
    };
  }

  // Step handler registry
  const toolRegistry = createDefaultToolRegistry();
  registerHeartbeatTools(toolRegistry as Map<string, any>, deps);
  const handlers = new Map<string, StepHandler>();
  handlers.set('agent', createAgentHandler(runAgentPrompt));
  handlers.set('tool', createToolDispatcher(toolRegistry));
  handlers.set('memory', createMemoryHandler(async (query, _config) => {
    logger.info({ query }, 'Workflow memory step (stub)');
    return { data: { results: [] }, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }));
  const baseMessageHandler = createMessageHandler(async (prompt, model) => {
    logger.info({ model, promptLength: prompt.length }, 'Message AI compose: starting');
    const customAgent = resolveCustomAgent(model ? { provider: 'anthropic', model } : {});
    const result = await deps.runAgentContainer({ prompt, customAgent });
    logger.info({ resultLength: result.length }, 'Message AI compose: complete');
    return { data: result, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  });

  // Wrap the message handler to emit outbound delivery via the bus
  const messageHandlerWithBus: StepHandler = async (ctx) => {
    const output = await baseMessageHandler(ctx);
    if (output.data && output.metadata) {
      const meta = output.metadata as Record<string, unknown>;
      const channel = meta.channel as string | undefined;
      if (channel) {
        let jid: string;
        if (channel === 'file') {
          jid = `file:${meta.filePath as string}`;
        } else if (channel === 'main' && deps.adminJid) {
          jid = deps.adminJid;
        } else if (channel === 'main') {
          logger.warn('Workflow message targets channel "main" but adminJid is not configured — message will be dropped');
          jid = `${channel}:default`;
        } else {
          jid = `${channel}:default`;
        }
        const text = typeof output.data === 'string'
          ? output.data
          : JSON.stringify(output.data);
        deps.messageBus.emitAsync({
          type: 'message.outbound',
          source: 'workflow',
          timestamp: new Date().toISOString(),
          data: { jid, text, source: 'workflow' },
        }).catch((err) => {
          logger.error({ err, channel }, 'Workflow message bus delivery failed');
        });
      }
    }
    return output;
  };

  handlers.set('message', messageHandlerWithBus);
  handlers.set('gate', createGateHandler());
  handlers.set('parallel', createParallelHandler());
  handlers.set('sync', createSyncHandler());

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
        handlers,
      );
      runners.set(workflow.id, runner);
    }
    return runner;
  }

  return {
    reloadDefinitions(): void {
      definitions = new Map();
      runners.clear();

      if (!fs.existsSync(workflowsDir)) return;

      const files = fs.readdirSync(workflowsDir).filter(f =>
        f.endsWith('.yaml') || f.endsWith('.yml'),
      );

      for (const file of files) {
        try {
          const yamlContent = fs.readFileSync(path.join(workflowsDir, file), 'utf-8');
          const workflow = loadWorkflow(yamlContent);
          definitions.set(workflow.id, workflow);
          logger.info({ workflowId: workflow.id, name: workflow.name }, 'Workflow loaded');
        } catch (err) {
          logger.error({ file, err }, 'Failed to load workflow definition');
        }
      }

      logger.info({ count: definitions.size }, 'Workflow definitions loaded');
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
