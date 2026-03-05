import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowDefinition } from 'cambot-workflows';

import type { WorkflowService } from './workflow-service.js';
import {
  _getNextRunTimes,
  _resetWorkflowSchedulerForTests,
  startWorkflowSchedulerLoop,
  syncScheduledWorkflows,
} from './workflow-scheduler.js';

function makeWorkflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'test-wf',
    name: 'Test Workflow',
    description: 'A test workflow',
    version: '1.0.0',
    hash: 'abc123',
    policy: {
      maxCostUsd: 1,
      maxTokens: 1000,
      maxOutputSizeBytes: 10000,
      piiAction: 'block',
      secretPatterns: [],
      network: { allowed_domains: [], block_paywalled: false },
    },
    steps: [],
    ...overrides,
  };
}

function createMockWorkflowService(
  workflows: WorkflowDefinition[],
  overrides: Partial<WorkflowService> = {},
): WorkflowService {
  const defs = new Map(workflows.map(w => [w.id, w]));
  return {
    reloadDefinitions: vi.fn(),
    listWorkflows: vi.fn(() => [...defs.values()]),
    getWorkflow: vi.fn((id: string) => defs.get(id)),
    hasActiveRun: vi.fn(() => false),
    runWorkflow: vi.fn(async () => 'run-123'),
    resumeWorkflow: vi.fn(async () => 'run-123'),
    getRunStatus: vi.fn(() => null),
    listRuns: vi.fn(() => []),
    pauseRun: vi.fn(),
    cancelRun: vi.fn(),
    ...overrides,
  };
}

describe('workflow scheduler', () => {
  beforeEach(() => {
    _resetWorkflowSchedulerForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('triggers a scheduled workflow when cron time is due', async () => {
    const wf = makeWorkflow({
      id: 'daily-research',
      schedule: { cron: '* * * * *' }, // every minute
    });

    const service = createMockWorkflowService([wf]);
    startWorkflowSchedulerLoop({ workflowService: service });

    // First tick runs the loop immediately — cron next-run is ~1 min in the future
    await vi.advanceTimersByTimeAsync(10);
    expect(service.runWorkflow).not.toHaveBeenCalled();

    // Advance past the next-run time (60s + poll interval margin)
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.runWorkflow).toHaveBeenCalledWith('daily-research');
  });

  it('skips workflows that are already running', async () => {
    const wf = makeWorkflow({
      id: 'busy-wf',
      schedule: { cron: '* * * * *' },
    });

    const service = createMockWorkflowService([wf], {
      hasActiveRun: vi.fn(() => true),
    });

    startWorkflowSchedulerLoop({ workflowService: service });

    // Advance well past the next cron fire
    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.hasActiveRun).toHaveBeenCalledWith('busy-wf');
    expect(service.runWorkflow).not.toHaveBeenCalled();
  });

  it('does not trigger workflows without a schedule', async () => {
    const wf = makeWorkflow({ id: 'no-schedule' });

    const service = createMockWorkflowService([wf]);
    startWorkflowSchedulerLoop({ workflowService: service });

    await vi.advanceTimersByTimeAsync(120_000);
    expect(service.runWorkflow).not.toHaveBeenCalled();
    expect(_getNextRunTimes().size).toBe(0);
  });

  it('removes entries for workflows that lose their schedule', () => {
    const wf = makeWorkflow({
      id: 'temp-scheduled',
      schedule: { cron: '0 9 * * *' },
    });

    const service = createMockWorkflowService([wf]);
    syncScheduledWorkflows({ workflowService: service });
    expect(_getNextRunTimes().has('temp-scheduled')).toBe(true);

    // Simulate the workflow losing its schedule
    const wfNoSchedule = makeWorkflow({ id: 'temp-scheduled' });
    const updatedService = createMockWorkflowService([wfNoSchedule]);
    syncScheduledWorkflows({ workflowService: updatedService });
    expect(_getNextRunTimes().has('temp-scheduled')).toBe(false);
  });
});
