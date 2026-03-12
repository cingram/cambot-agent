import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMessageBus } from '../bus/message-bus.js';
import { WorkflowAgentRequest } from '../bus/events/workflow-agent-request.js';
import { WorkflowAgentResponse } from '../bus/events/workflow-agent-response.js';
import { createWorkflowAgentHandler } from './workflow-agent-handler.js';
import type { AgentRepository } from '../db/agent-repository.js';
import type { ContainerSpawner } from '../agents/persistent-agent-spawner.js';
import type { RegisteredAgent } from '../types.js';

function createMockAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent',
    folder: 'test-agent',
    channels: [],
    mcpServers: [],
    capabilities: [],
    concurrency: 2,
    timeoutMs: 60_000,
    isMain: false,
    system: false,
    systemPrompt: null,
    soul: null,
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    secretKeys: [],
    tools: [],
    skills: [],
    temperature: null,
    maxTokens: null,
    baseUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as RegisteredAgent;
}

function createMockSpawner(result?: Partial<{ status: string; content: string; durationMs: number }>): ContainerSpawner {
  return {
    spawn: vi.fn().mockResolvedValue({
      status: 'success',
      content: 'Agent response text',
      durationMs: 500,
      ...result,
    }),
  };
}

function createMockAgentRepo(agent?: RegisteredAgent): AgentRepository {
  return {
    ensureTable: vi.fn(),
    getAll: vi.fn().mockReturnValue(agent ? [agent] : []),
    getById: vi.fn().mockImplementation((id: string) => (agent && agent.id === id ? agent : undefined)),
    getByFolder: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    getByChannel: vi.fn().mockReturnValue([]),
    buildRoutingTable: vi.fn().mockReturnValue(new Map()),
  } as unknown as AgentRepository;
}

describe('WorkflowAgentHandler', () => {
  let bus: ReturnType<typeof createMessageBus>;
  const correlationId = 'corr-123';

  beforeEach(() => {
    bus = createMessageBus();
  });

  it('spawns agent and emits success response with matching correlationId', async () => {
    const agent = createMockAgent();
    const spawner = createMockSpawner();
    const repo = createMockAgentRepo(agent);

    const handler = createWorkflowAgentHandler({ messageBus: bus, agentRepo: repo, spawner });

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1',
      prompt: 'Hello agent',
      runId: 'run-1',
      stepId: 'step-1',
      correlationId,
    }));

    expect(spawner.spawn).toHaveBeenCalledWith(agent, 'Hello agent', 'workflow:run-1', 60_000);
    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe('success');
    expect(responses[0].text).toBe('Agent response text');
    expect(responses[0].correlationId).toBe(correlationId);
    expect(responses[0].runId).toBe('run-1');
    expect(responses[0].stepId).toBe('step-1');

    handler.destroy();
  });

  it('emits error response when agent not found', async () => {
    const repo = createMockAgentRepo(); // no agents
    const spawner = createMockSpawner();

    const handler = createWorkflowAgentHandler({ messageBus: bus, agentRepo: repo, spawner });

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'nonexistent',
      prompt: 'Hello',
      runId: 'run-1',
      stepId: 'step-1',
      correlationId,
    }));

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe('error');
    expect(responses[0].text).toContain('not found');
    expect(responses[0].correlationId).toBe(correlationId);

    handler.destroy();
  });

  it('emits error response when spawner throws', async () => {
    const agent = createMockAgent();
    const spawner: ContainerSpawner = {
      spawn: vi.fn().mockRejectedValue(new Error('Container crashed')),
    };
    const repo = createMockAgentRepo(agent);

    const handler = createWorkflowAgentHandler({ messageBus: bus, agentRepo: repo, spawner });

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1',
      prompt: 'Hello',
      runId: 'run-1',
      stepId: 'step-1',
      correlationId,
    }));

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe('error');
    expect(responses[0].text).toContain('Container crashed');

    handler.destroy();
  });

  it('opens circuit breaker after repeated failures', async () => {
    const agent = createMockAgent({ concurrency: 5 });
    const spawner: ContainerSpawner = {
      spawn: vi.fn().mockResolvedValue({ status: 'error', content: 'fail', durationMs: 100 }),
    };
    const repo = createMockAgentRepo(agent);

    const handler = createWorkflowAgentHandler({
      messageBus: bus,
      agentRepo: repo,
      spawner,
      failureThreshold: 2,
      cooldownMs: 100_000,
    });

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    // Trigger failures to open circuit
    for (let i = 0; i < 2; i++) {
      await bus.emit(new WorkflowAgentRequest('test', {
        agentId: 'agent-1',
        prompt: 'Hello',
        runId: `run-${i}`,
        stepId: 'step-1',
        correlationId: `corr-${i}`,
      }));
    }

    // Next request should be rejected by circuit breaker
    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1',
      prompt: 'Hello',
      runId: 'run-rejected',
      stepId: 'step-1',
      correlationId: 'corr-rejected',
    }));

    const lastResponse = responses[responses.length - 1];
    expect(lastResponse.status).toBe('error');
    expect(lastResponse.text).toContain('Circuit open');

    handler.destroy();
  });

  it('rejects when bulkhead is full', async () => {
    const agent = createMockAgent({ concurrency: 1 });
    // Spawner that hangs (never resolves)
    let resolveSpawn: () => void;
    const spawner: ContainerSpawner = {
      spawn: vi.fn().mockImplementation(() =>
        new Promise<{ status: string; content: string; durationMs: number }>((resolve) => {
          resolveSpawn = () => resolve({ status: 'success', content: 'ok', durationMs: 100 });
        }),
      ),
    };
    const repo = createMockAgentRepo(agent);

    const handler = createWorkflowAgentHandler({ messageBus: bus, agentRepo: repo, spawner });

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    // First request — takes up the one slot
    const firstPromise = bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1',
      prompt: 'First',
      runId: 'run-1',
      stepId: 'step-1',
      correlationId: 'corr-1',
    }));

    // Second request — should be rejected by bulkhead
    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1',
      prompt: 'Second',
      runId: 'run-2',
      stepId: 'step-2',
      correlationId: 'corr-2',
    }));

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe('error');
    expect(responses[0].text).toContain('Bulkhead full');

    // Resolve first to clean up
    resolveSpawn!();
    await firstPromise;

    handler.destroy();
  });

  it('emits error response when spawner returns error status', async () => {
    const agent = createMockAgent();
    const spawner = createMockSpawner({ status: 'error', content: 'Agent returned error' });
    const repo = createMockAgentRepo(agent);

    const handler = createWorkflowAgentHandler({ messageBus: bus, agentRepo: repo, spawner });

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1',
      prompt: 'Hello',
      runId: 'run-1',
      stepId: 'step-1',
      correlationId,
    }));

    expect(responses).toHaveLength(1);
    expect(responses[0].status).toBe('error');
    expect(responses[0].text).toBe('Agent returned error');
    expect(responses[0].durationMs).toBeGreaterThanOrEqual(0);

    handler.destroy();
  });

  it('recovers circuit breaker from half-open to closed on success', async () => {
    const agent = createMockAgent({ concurrency: 5 });
    let spawnResult = { status: 'error' as const, content: 'fail', durationMs: 100 };
    const spawner: ContainerSpawner = {
      spawn: vi.fn().mockImplementation(() => Promise.resolve({ ...spawnResult })),
    };
    const repo = createMockAgentRepo(agent);

    const handler = createWorkflowAgentHandler({
      messageBus: bus,
      agentRepo: repo,
      spawner,
      failureThreshold: 2,
      cooldownMs: 50, // Short cooldown for test
    });

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    // Trigger failures to open circuit
    for (let i = 0; i < 2; i++) {
      await bus.emit(new WorkflowAgentRequest('test', {
        agentId: 'agent-1', prompt: 'fail', runId: `run-${i}`, stepId: 'step-1',
        correlationId: `corr-fail-${i}`,
      }));
    }

    // Verify circuit is open
    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1', prompt: 'rejected', runId: 'run-open', stepId: 'step-1',
      correlationId: 'corr-open',
    }));
    expect(responses[responses.length - 1].text).toContain('Circuit open');

    // Wait for cooldown to transition to half-open
    await new Promise(resolve => setTimeout(resolve, 80));

    // Switch spawner to success and send a request (half-open allows it)
    spawnResult = { status: 'success' as any, content: 'recovered', durationMs: 50 };
    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1', prompt: 'recovery', runId: 'run-recover', stepId: 'step-1',
      correlationId: 'corr-recover',
    }));

    const recoveryResponse = responses[responses.length - 1];
    expect(recoveryResponse.status).toBe('success');
    expect(recoveryResponse.text).toBe('recovered');

    // Circuit should be closed now — another request should work
    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1', prompt: 'after-recovery', runId: 'run-after', stepId: 'step-1',
      correlationId: 'corr-after',
    }));
    expect(responses[responses.length - 1].status).toBe('success');

    handler.destroy();
  });

  it('unsubscribes on destroy', async () => {
    const agent = createMockAgent();
    const spawner = createMockSpawner();
    const repo = createMockAgentRepo(agent);

    const handler = createWorkflowAgentHandler({ messageBus: bus, agentRepo: repo, spawner });
    handler.destroy();

    const responses: WorkflowAgentResponse[] = [];
    bus.on(WorkflowAgentResponse, (e) => { responses.push(e); });

    await bus.emit(new WorkflowAgentRequest('test', {
      agentId: 'agent-1',
      prompt: 'Hello',
      runId: 'run-1',
      stepId: 'step-1',
      correlationId,
    }));

    expect(spawner.spawn).not.toHaveBeenCalled();
    expect(responses).toHaveLength(0);
  });
});
