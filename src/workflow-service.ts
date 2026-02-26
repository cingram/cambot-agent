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
import {
  loadWorkflow,
  createWorkflowRunStore,
  createWorkflowStepRunStore,
  createWorkflowRunner,
  createPolicyEngine,
  createAgentHandler,
  createToolHandler,
  createMemoryHandler,
  createMessageHandler,
  createGateHandler,
} from 'cambot-workflows';
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowRunner,
  StepHandler,
  StepOutput,
  WorkflowRunStore,
  WorkflowStepRunStore,
} from 'cambot-workflows';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ── Public interface ─────────────────────────────────────────────────

export interface WorkflowService {
  reloadDefinitions(): void;
  listWorkflows(): WorkflowDefinition[];
  getWorkflow(id: string): WorkflowDefinition | undefined;
  runWorkflow(workflowId: string): Promise<string>;
  resumeWorkflow(runId: string, workflowId: string): Promise<string>;
  getRunStatus(runId: string): WorkflowRun | null;
  listRuns(workflowId?: string, limit?: number): WorkflowRun[];
  pauseRun(runId: string): void;
  cancelRun(runId: string): void;
}

/**
 * Callback that runs a prompt through a container-based agent.
 * Returns the agent's text response. Spawns a real container using
 * the existing OAuth token + Agent SDK.
 */
export type RunAgentContainerFn = (prompt: string) => Promise<string>;

export interface WorkflowServiceDeps {
  db: Database.Database;
  runAgentContainer: RunAgentContainerFn;
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

    logger.info(
      { promptLength: prompt.length },
      'Workflow agent step: spawning container',
    );

    const startTime = Date.now();
    const result = await deps.runAgentContainer(prompt);
    const durationMs = Date.now() - startTime;

    logger.info(
      { durationMs, resultLength: result.length },
      'Workflow agent step completed',
    );

    // Token counts aren't available from the Agent SDK container path.
    // Cost tracking relies on the container's own telemetry.
    return {
      data: result,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      metadata: { durationMs },
    };
  }

  // Step handler registry
  const handlers = new Map<string, StepHandler>();
  handlers.set('agent', createAgentHandler(runAgentPrompt));
  handlers.set('tool', createToolHandler(async (config, _prev) => {
    logger.info({ tool: config.tool }, 'Workflow tool step (stub)');
    return { data: { status: 'ok', tool: config.tool }, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }));
  handlers.set('memory', createMemoryHandler(async (query, _config) => {
    logger.info({ query }, 'Workflow memory step (stub)');
    return { data: { results: [] }, tokensIn: 0, tokensOut: 0, costUsd: 0 };
  }));
  handlers.set('message', createMessageHandler());
  handlers.set('gate', createGateHandler());

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
