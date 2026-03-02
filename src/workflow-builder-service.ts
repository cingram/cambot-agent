/**
 * Workflow Builder Service
 *
 * Host-side CRUD for workflow definitions. Converts structured objects
 * from the agent into validated YAML files with computed hashes.
 *
 * Follows the factory function pattern used by WorkflowService and
 * CustomAgentService.
 */
import fs from 'fs';
import path from 'path';
import { stringify } from 'yaml';
import { loadWorkflow, computeWorkflowHash } from 'cambot-workflows';
import type { WorkflowDefinition, WorkflowStepDef, GateOperator } from 'cambot-workflows';

import type { WorkflowService } from './workflow-service.js';
import { logger } from './logger.js';

// ── Types ────────────────────────────────────────────────────────────

export interface WorkflowInput {
  id: string;
  name: string;
  description: string;
  version?: string;
  schedule?: { cron: string; timezone?: string };
  policy: {
    maxCostUsd: number;
    maxTokens: number;
    maxOutputSizeBytes: number;
    piiAction: 'block' | 'redact';
    secretPatterns: string[];
    network: { allowed_domains: string[]; block_paywalled: boolean };
  };
  steps: Array<{
    id: string;
    type: string;
    name: string;
    config: Record<string, unknown>;
    after?: string[];
    retries?: number;
    timeout?: number;
  }>;
}

export interface WorkflowBuildResult {
  success: boolean;
  workflowId?: string;
  hash?: string;
  violations?: string[];
  error?: string;
}

export interface WorkflowSchemaInfo {
  stepTypes: Array<{
    type: string;
    description: string;
    requiredConfig: string[];
    optionalConfig: string[];
  }>;
  gateOperators: string[];
  availableTools: string[];
}

export interface WorkflowBuilderService {
  createWorkflow(input: WorkflowInput): WorkflowBuildResult;
  updateWorkflow(workflowId: string, input: WorkflowInput): WorkflowBuildResult;
  deleteWorkflow(workflowId: string): WorkflowBuildResult;
  validateWorkflow(input: WorkflowInput): WorkflowBuildResult;
  cloneWorkflow(sourceId: string, newId: string, newName?: string): WorkflowBuildResult;
  getWorkflowDetail(workflowId: string): WorkflowDefinition | undefined;
  getSchema(): WorkflowSchemaInfo;
}

export interface WorkflowBuilderDeps {
  workflowsDir: string;
  workflowService: WorkflowService;
  toolRegistry: ReadonlyMap<string, unknown>;
}

// ── Factory ──────────────────────────────────────────────────────────

export function createWorkflowBuilderService(deps: WorkflowBuilderDeps): WorkflowBuilderService {
  const { workflowsDir, workflowService, toolRegistry } = deps;

  fs.mkdirSync(workflowsDir, { recursive: true });

  /**
   * Convert a structured workflow input into YAML with a computed hash.
   * Returns the YAML string ready to write to disk.
   */
  function buildYaml(input: WorkflowInput): string {
    const obj: Record<string, unknown> = {
      id: input.id,
      name: input.name,
      description: input.description,
      version: input.version || '1.0',
      hash: '', // placeholder — computed below
    };

    if (input.schedule) {
      obj.schedule = input.schedule;
    }

    obj.policy = input.policy;
    obj.steps = input.steps;

    // First pass: serialize without hash to compute it
    const yamlNoHash = stringify(obj);
    const hash = computeWorkflowHash(yamlNoHash);

    // Second pass: include the computed hash
    obj.hash = hash;
    return stringify(obj);
  }

  /**
   * Validate a YAML string by loading it through the full validation pipeline.
   * Returns violations if any, or null on success.
   */
  function validateYaml(yamlContent: string): string[] | null {
    try {
      loadWorkflow(yamlContent);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [message];
    }
  }

  /**
   * Atomically write a workflow YAML file and reload definitions.
   */
  function writeAndReload(workflowId: string, yamlContent: string): void {
    const filePath = path.join(workflowsDir, `${workflowId}.yaml`);
    const tempPath = `${filePath}.tmp`;

    fs.writeFileSync(tempPath, yamlContent, 'utf-8');
    fs.renameSync(tempPath, filePath);

    workflowService.reloadDefinitions();
    logger.info({ workflowId }, 'Workflow definition written and reloaded');
  }

  return {
    createWorkflow(input: WorkflowInput): WorkflowBuildResult {
      // Check for existing
      const existing = workflowService.getWorkflow(input.id);
      if (existing) {
        return {
          success: false,
          error: `Workflow "${input.id}" already exists. Use update instead.`,
        };
      }

      const yaml = buildYaml(input);
      const violations = validateYaml(yaml);
      if (violations) {
        return { success: false, violations };
      }

      writeAndReload(input.id, yaml);

      return {
        success: true,
        workflowId: input.id,
        hash: computeWorkflowHash(yaml),
      };
    },

    updateWorkflow(workflowId: string, input: WorkflowInput): WorkflowBuildResult {
      const existing = workflowService.getWorkflow(workflowId);
      if (!existing) {
        return {
          success: false,
          error: `Workflow "${workflowId}" not found.`,
        };
      }

      if (workflowService.hasActiveRun(workflowId)) {
        return {
          success: false,
          error: `Workflow "${workflowId}" has an active run. Pause or cancel it first.`,
        };
      }

      // Override ID to match the target
      input.id = workflowId;

      const yaml = buildYaml(input);
      const violations = validateYaml(yaml);
      if (violations) {
        return { success: false, violations };
      }

      // Remove old file if ID changed in the input
      const oldPath = path.join(workflowsDir, `${workflowId}.yaml`);
      if (fs.existsSync(oldPath)) {
        fs.unlinkSync(oldPath);
      }

      writeAndReload(workflowId, yaml);

      return {
        success: true,
        workflowId,
        hash: computeWorkflowHash(yaml),
      };
    },

    deleteWorkflow(workflowId: string): WorkflowBuildResult {
      const existing = workflowService.getWorkflow(workflowId);
      if (!existing) {
        return {
          success: false,
          error: `Workflow "${workflowId}" not found.`,
        };
      }

      if (workflowService.hasActiveRun(workflowId)) {
        return {
          success: false,
          error: `Workflow "${workflowId}" has an active run. Cancel it first.`,
        };
      }

      const filePath = path.join(workflowsDir, `${workflowId}.yaml`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      workflowService.reloadDefinitions();
      logger.info({ workflowId }, 'Workflow deleted');

      return { success: true, workflowId };
    },

    validateWorkflow(input: WorkflowInput): WorkflowBuildResult {
      const yaml = buildYaml(input);
      const violations = validateYaml(yaml);

      if (violations) {
        return { success: false, violations };
      }

      return {
        success: true,
        workflowId: input.id,
        hash: computeWorkflowHash(yaml),
      };
    },

    cloneWorkflow(sourceId: string, newId: string, newName?: string): WorkflowBuildResult {
      const source = workflowService.getWorkflow(sourceId);
      if (!source) {
        return {
          success: false,
          error: `Source workflow "${sourceId}" not found.`,
        };
      }

      // Check target doesn't exist
      const existing = workflowService.getWorkflow(newId);
      if (existing) {
        return {
          success: false,
          error: `Workflow "${newId}" already exists.`,
        };
      }

      const input: WorkflowInput = {
        id: newId,
        name: newName || `${source.name} (copy)`,
        description: source.description,
        version: '1.0',
        schedule: source.schedule,
        policy: source.policy,
        steps: source.steps.map(s => ({
          id: s.id,
          type: s.type,
          name: s.name,
          config: s.config,
          after: s.after,
          retries: s.retries,
          timeout: s.timeout,
        })),
      };

      return this.createWorkflow(input);
    },

    getWorkflowDetail(workflowId: string): WorkflowDefinition | undefined {
      return workflowService.getWorkflow(workflowId);
    },

    getSchema(): WorkflowSchemaInfo {
      const gateOperators: GateOperator[] = [
        'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists',
      ];

      return {
        stepTypes: [
          {
            type: 'agent',
            description: 'Runs a prompt through a Claude or custom agent container',
            requiredConfig: ['prompt'],
            optionalConfig: ['model', 'provider', 'agentId', 'baseUrl', 'systemPrompt', 'tools', 'maxTokens', 'temperature'],
          },
          {
            type: 'tool',
            description: 'Executes a registered workflow tool (heartbeat, maintenance, etc.)',
            requiredConfig: ['tool'],
            optionalConfig: ['input'],
          },
          {
            type: 'memory',
            description: 'Queries the memory system for relevant facts',
            requiredConfig: ['query'],
            optionalConfig: [],
          },
          {
            type: 'message',
            description: 'Composes and sends a message via AI to a channel',
            requiredConfig: ['instruction', 'channel'],
            optionalConfig: ['model', 'filePath', 'subject'],
          },
          {
            type: 'gate',
            description: 'Conditional branch — evaluates a condition on a previous step output',
            requiredConfig: ['conditions'],
            optionalConfig: [],
          },
          {
            type: 'parallel',
            description: 'Marker for steps that run concurrently (use after[] to define fork point)',
            requiredConfig: [],
            optionalConfig: [],
          },
          {
            type: 'sync',
            description: 'Wait for parallel branches to complete before continuing',
            requiredConfig: [],
            optionalConfig: [],
          },
        ],
        gateOperators: gateOperators as string[],
        availableTools: [...toolRegistry.keys()],
      };
    },
  };
}
