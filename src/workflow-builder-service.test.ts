import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { createWorkflowBuilderService, type WorkflowInput } from './workflow-builder-service.js';
import type { WorkflowService } from './workflow-service.js';
import type { WorkflowDefinition } from 'cambot-workflows';

// ── Test helpers ─────────────────────────────────────────────────────

function makeMinimalInput(overrides: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    id: 'test-workflow',
    name: 'Test Workflow',
    description: 'A test workflow',
    version: '1.0',
    policy: {
      maxCostUsd: 1.0,
      maxTokens: 50000,
      maxOutputSizeBytes: 262144,
      piiAction: 'redact',
      secretPatterns: [],
      network: { allowed_domains: [], block_paywalled: false },
    },
    steps: [
      {
        id: 'step-1',
        type: 'tool',
        name: 'Health Check',
        config: { tool: 'url-health-check', input: 'https://example.com' },
      },
    ],
    ...overrides,
  };
}

function createMockWorkflowService(): WorkflowService & { _definitions: Map<string, WorkflowDefinition> } {
  const definitions = new Map<string, WorkflowDefinition>();
  const activeRuns = new Set<string>();

  return {
    _definitions: definitions,
    reloadDefinitions(): void {
      // In real service this reloads from disk. For tests we just mark it called.
    },
    listWorkflows(): WorkflowDefinition[] {
      return [...definitions.values()];
    },
    getWorkflow(id: string): WorkflowDefinition | undefined {
      return definitions.get(id);
    },
    hasActiveRun(workflowId: string): boolean {
      return activeRuns.has(workflowId);
    },
    async runWorkflow(_workflowId: string): Promise<string> {
      return 'run-test';
    },
    async resumeWorkflow(_runId: string, _workflowId: string): Promise<string> {
      return 'run-test';
    },
    getRunStatus(_runId: string) {
      return null;
    },
    listRuns(_workflowId?: string, _limit?: number) {
      return [];
    },
    pauseRun(_runId: string): void {},
    cancelRun(_runId: string): void {},
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('WorkflowBuilderService', () => {
  let tmpDir: string;
  let mockService: ReturnType<typeof createMockWorkflowService>;
  let toolRegistry: Map<string, unknown>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wfb-test-'));
    mockService = createMockWorkflowService();
    toolRegistry = new Map([
      ['url-health-check', {}],
      ['heartbeat-channel-check', {}],
    ]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createService() {
    return createWorkflowBuilderService({
      workflowsDir: tmpDir,
      workflowService: mockService,
      toolRegistry,
    });
  }

  describe('createWorkflow', () => {
    it('creates a valid workflow YAML file', () => {
      const service = createService();
      const input = makeMinimalInput();
      const result = service.createWorkflow(input);

      expect(result.success).toBe(true);
      expect(result.workflowId).toBe('test-workflow');
      expect(result.hash).toBeDefined();
      expect(result.hash!.length).toBe(64); // SHA-256 hex

      // Check file was written
      const yamlPath = path.join(tmpDir, 'test-workflow.yaml');
      expect(fs.existsSync(yamlPath)).toBe(true);

      const content = fs.readFileSync(yamlPath, 'utf-8');
      expect(content).toContain('test-workflow');
      expect(content).toContain('Test Workflow');
    });

    it('rejects duplicate workflow IDs', () => {
      const service = createService();
      const input = makeMinimalInput();

      // Simulate an existing workflow by adding to the mock
      mockService._definitions.set('test-workflow', {} as WorkflowDefinition);

      const result = service.createWorkflow(input);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('validateWorkflow', () => {
    it('validates a correct workflow', () => {
      const service = createService();
      const input = makeMinimalInput();
      const result = service.validateWorkflow(input);

      expect(result.success).toBe(true);
      expect(result.hash).toBeDefined();
    });

    it('returns violations for invalid workflows', () => {
      const service = createService();
      const input = makeMinimalInput({
        steps: [
          {
            id: 'a',
            type: 'tool',
            name: 'A',
            config: { tool: 'test' },
            after: ['b'],
          },
          {
            id: 'b',
            type: 'tool',
            name: 'B',
            config: { tool: 'test' },
            after: ['a'],
          },
        ],
      });
      const result = service.validateWorkflow(input);

      expect(result.success).toBe(false);
      expect(result.violations).toBeDefined();
      expect(result.violations!.length).toBeGreaterThan(0);
    });
  });

  describe('updateWorkflow', () => {
    it('updates an existing workflow', () => {
      const service = createService();

      // Create a fake existing workflow
      const original = makeMinimalInput();
      mockService._definitions.set('test-workflow', {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'Original',
        version: '1.0',
        hash: 'fake',
        policy: original.policy,
        steps: original.steps as any,
      });
      fs.writeFileSync(path.join(tmpDir, 'test-workflow.yaml'), 'placeholder');

      const updated = makeMinimalInput({ description: 'Updated description' });
      const result = service.updateWorkflow('test-workflow', updated);

      expect(result.success).toBe(true);
      expect(result.workflowId).toBe('test-workflow');
    });

    it('rejects updates to non-existent workflows', () => {
      const service = createService();
      const input = makeMinimalInput();
      const result = service.updateWorkflow('nonexistent', input);

      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });
  });

  describe('deleteWorkflow', () => {
    it('deletes an existing workflow', () => {
      const service = createService();

      mockService._definitions.set('test-workflow', {} as WorkflowDefinition);
      const yamlPath = path.join(tmpDir, 'test-workflow.yaml');
      fs.writeFileSync(yamlPath, 'placeholder');

      const result = service.deleteWorkflow('test-workflow');
      expect(result.success).toBe(true);
      expect(fs.existsSync(yamlPath)).toBe(false);
    });

    it('rejects deletion of non-existent workflows', () => {
      const service = createService();
      const result = service.deleteWorkflow('nonexistent');
      expect(result.success).toBe(false);
    });
  });

  describe('cloneWorkflow', () => {
    it('clones an existing workflow', () => {
      const service = createService();

      // Create a source workflow in the mock
      const source = makeMinimalInput();
      mockService._definitions.set('source-wf', {
        id: 'source-wf',
        name: 'Source Workflow',
        description: 'Original',
        version: '1.0',
        hash: 'fake',
        policy: source.policy,
        steps: source.steps as any,
      });

      const result = service.cloneWorkflow('source-wf', 'cloned-wf', 'Cloned Workflow');

      expect(result.success).toBe(true);
      expect(result.workflowId).toBe('cloned-wf');

      const clonedPath = path.join(tmpDir, 'cloned-wf.yaml');
      expect(fs.existsSync(clonedPath)).toBe(true);
    });

    it('rejects cloning from non-existent source', () => {
      const service = createService();
      const result = service.cloneWorkflow('nonexistent', 'new-wf');
      expect(result.success).toBe(false);
    });
  });

  describe('getSchema', () => {
    it('returns step types and available tools', () => {
      const service = createService();
      const schema = service.getSchema();

      expect(schema.stepTypes.length).toBeGreaterThan(0);
      expect(schema.stepTypes.map(s => s.type)).toContain('agent');
      expect(schema.stepTypes.map(s => s.type)).toContain('tool');
      expect(schema.stepTypes.map(s => s.type)).toContain('gate');

      expect(schema.gateOperators).toContain('eq');
      expect(schema.gateOperators).toContain('contains');

      expect(schema.availableTools).toContain('url-health-check');
      expect(schema.availableTools).toContain('heartbeat-channel-check');
    });
  });

  describe('getWorkflowDetail', () => {
    it('returns the workflow definition', () => {
      const service = createService();
      const def = { id: 'test', name: 'Test' } as WorkflowDefinition;
      mockService._definitions.set('test', def);

      expect(service.getWorkflowDetail('test')).toBe(def);
    });

    it('returns undefined for non-existent workflow', () => {
      const service = createService();
      expect(service.getWorkflowDetail('nonexistent')).toBeUndefined();
    });
  });
});
