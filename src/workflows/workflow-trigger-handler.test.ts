import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMessageBus } from '../bus/message-bus.js';
import { WorkflowTrigger } from '../bus/events/workflow-trigger.js';
import { createWorkflowTriggerHandler } from './workflow-trigger-handler.js';
import type { WorkflowService } from './workflow-service.js';

function createMockWorkflowService(overrides: Partial<WorkflowService> = {}): WorkflowService {
  return {
    reloadDefinitions: vi.fn(),
    listWorkflows: vi.fn().mockReturnValue([]),
    getWorkflow: vi.fn().mockReturnValue({ id: 'wf1', name: 'Test' }),
    hasActiveRun: vi.fn().mockReturnValue(false),
    runWorkflow: vi.fn().mockResolvedValue('run-123'),
    resumeWorkflow: vi.fn().mockResolvedValue('run-123'),
    getRunStatus: vi.fn().mockReturnValue(null),
    listRuns: vi.fn().mockReturnValue([]),
    pauseRun: vi.fn(),
    cancelRun: vi.fn(),
    ...overrides,
  };
}

describe('WorkflowTriggerHandler', () => {
  let bus: ReturnType<typeof createMessageBus>;

  beforeEach(() => {
    bus = createMessageBus();
  });

  it('calls runWorkflow on valid trigger', async () => {
    const service = createMockWorkflowService();
    const handler = createWorkflowTriggerHandler({
      messageBus: bus,
      getWorkflowService: () => service,
    });

    await bus.emit(new WorkflowTrigger('test-agent', 'wf1'));

    expect(service.getWorkflow).toHaveBeenCalledWith('wf1');
    expect(service.hasActiveRun).toHaveBeenCalledWith('wf1');
    expect(service.runWorkflow).toHaveBeenCalledWith('wf1');

    handler.destroy();
  });

  it('skips unknown workflow', async () => {
    const service = createMockWorkflowService({
      getWorkflow: vi.fn().mockReturnValue(undefined),
    });
    const handler = createWorkflowTriggerHandler({
      messageBus: bus,
      getWorkflowService: () => service,
    });

    await bus.emit(new WorkflowTrigger('test-agent', 'nonexistent'));

    expect(service.runWorkflow).not.toHaveBeenCalled();

    handler.destroy();
  });

  it('skips when active run exists', async () => {
    const service = createMockWorkflowService({
      hasActiveRun: vi.fn().mockReturnValue(true),
    });
    const handler = createWorkflowTriggerHandler({
      messageBus: bus,
      getWorkflowService: () => service,
    });

    await bus.emit(new WorkflowTrigger('test-agent', 'wf1'));

    expect(service.runWorkflow).not.toHaveBeenCalled();

    handler.destroy();
  });

  it('skips when workflow service is null', async () => {
    const handler = createWorkflowTriggerHandler({
      messageBus: bus,
      getWorkflowService: () => null,
    });

    // Should not throw
    await bus.emit(new WorkflowTrigger('test-agent', 'wf1'));

    handler.destroy();
  });

  it('handles runWorkflow failure gracefully', async () => {
    const service = createMockWorkflowService({
      runWorkflow: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const handler = createWorkflowTriggerHandler({
      messageBus: bus,
      getWorkflowService: () => service,
    });

    // Should not throw
    await bus.emit(new WorkflowTrigger('test-agent', 'wf1'));

    expect(service.runWorkflow).toHaveBeenCalled();

    handler.destroy();
  });

  it('unsubscribes on destroy', async () => {
    const service = createMockWorkflowService();
    const handler = createWorkflowTriggerHandler({
      messageBus: bus,
      getWorkflowService: () => service,
    });

    handler.destroy();

    await bus.emit(new WorkflowTrigger('test-agent', 'wf1'));
    expect(service.runWorkflow).not.toHaveBeenCalled();
  });
});
