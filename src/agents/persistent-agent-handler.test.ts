import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createPersistentAgentHandler } from './persistent-agent-handler.js';
import type { AgentRepository } from '../db/agent-repository.js';
import type { ContainerSpawner, AgentExecutionResult } from './persistent-agent-spawner.js';
import { MessageBus, InboundMessage, OutboundMessage } from '../bus/index.js';
import type { NewMessage, RegisteredAgent } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content: 'Hello',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeInboundEvent(channel: string, content = 'Hello'): InboundMessage {
  return new InboundMessage(
    channel,
    `${channel}:jid`,
    makeMessage({ content, chat_jid: `${channel}:jid`, sender_name: 'User' }),
    { channel },
  );
}

function makeAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    description: 'A test agent',
    folder: 'test-agent',
    channels: ['whatsapp'],
    mcpServers: [],
    capabilities: [],
    concurrency: 2,
    timeoutMs: 60_000,
    isMain: false,
    agentDefId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockAgentRepo(routingTable: Map<string, string>, agentMap = new Map<string, RegisteredAgent>()): AgentRepository {
  return {
    ensureTable: vi.fn(),
    getAll: vi.fn(() => [...agentMap.values()]),
    getById: vi.fn((id: string) => agentMap.get(id)),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(() => false),
    getByChannel: vi.fn(() => []),
    buildRoutingTable: vi.fn(() => routingTable),
  } as unknown as AgentRepository;
}

function makeMockSpawner(result?: AgentExecutionResult): ContainerSpawner {
  return {
    spawn: vi.fn().mockResolvedValue(result ?? { status: 'success', content: 'done', durationMs: 100 }),
  };
}

// ── Tests ───────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createPersistentAgentHandler', () => {
  it('routes to the correct agent for a claimed channel', async () => {
    const agent = makeAgent({ id: 'wa-agent', channels: ['whatsapp'] });
    const routingTable = new Map([['whatsapp', 'wa-agent']]);
    const agentMap = new Map([['wa-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();
    const messageBus = new MessageBus();

    createPersistentAgentHandler({ messageBus, agentRepo, spawner });

    const event = makeInboundEvent('whatsapp', 'test message');
    await messageBus.emit(event);

    expect(spawner.spawn).toHaveBeenCalledWith(
      'wa-agent',
      'test message',
      'whatsapp:jid',
      60_000,
    );
  });

  it('cancels event for a claimed channel', async () => {
    const agent = makeAgent({ id: 'wa-agent' });
    const routingTable = new Map([['whatsapp', 'wa-agent']]);
    const agentMap = new Map([['wa-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();
    const messageBus = new MessageBus();

    createPersistentAgentHandler({ messageBus, agentRepo, spawner });

    const event = makeInboundEvent('whatsapp');
    await messageBus.emit(event);

    expect(event.cancelled).toBe(true);
  });

  it('passes through unclaimed channels', async () => {
    const agent = makeAgent({ id: 'wa-agent' });
    const routingTable = new Map([['whatsapp', 'wa-agent']]);
    const agentMap = new Map([['wa-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();
    const messageBus = new MessageBus();

    createPersistentAgentHandler({ messageBus, agentRepo, spawner });

    const event = makeInboundEvent('telegram');
    await messageBus.emit(event);

    expect(event.cancelled).toBe(false);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('passes through events with no channel', async () => {
    const routingTable = new Map([['whatsapp', 'wa-agent']]);
    const agentRepo = makeMockAgentRepo(routingTable);
    const spawner = makeMockSpawner();
    const messageBus = new MessageBus();

    createPersistentAgentHandler({ messageBus, agentRepo, spawner });

    const event = new InboundMessage('unknown', 'some:jid', makeMessage());
    await messageBus.emit(event);

    expect(event.cancelled).toBe(false);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('emits error OutboundMessage when spawner throws after retries', async () => {
    const agent = makeAgent({ id: 'web-agent', channels: ['web'] });
    const routingTable = new Map([['web', 'web-agent']]);
    const agentMap = new Map([['web-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();
    (spawner.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('spawn failed'));
    const messageBus = new MessageBus();

    createPersistentAgentHandler({ messageBus, agentRepo, spawner, maxRetries: 0 });

    const emittedErrors: OutboundMessage[] = [];
    messageBus.on(OutboundMessage, (event) => { emittedErrors.push(event); });

    const event = makeInboundEvent('web');
    await messageBus.emit(event);

    expect(event.cancelled).toBe(true);
    expect(emittedErrors).toHaveLength(1);
    expect(emittedErrors[0].text).toContain('error');
    expect(emittedErrors[0].jid).toBe('web:jid');
  });

  it('circuit breaker opens after N failures and rejects immediately', async () => {
    const agent = makeAgent({ id: 'cb-agent', channels: ['web'], concurrency: 5 });
    const routingTable = new Map([['web', 'cb-agent']]);
    const agentMap = new Map([['cb-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();
    (spawner.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const messageBus = new MessageBus();

    createPersistentAgentHandler({
      messageBus, agentRepo, spawner,
      maxRetries: 0, failureThreshold: 3, cooldownMs: 30_000,
    });

    // Exhaust 3 failures to trip the circuit
    for (let i = 0; i < 3; i++) {
      await messageBus.emit(makeInboundEvent('web'));
    }
    expect(spawner.spawn).toHaveBeenCalledTimes(3);

    // Next call should be rejected immediately (circuit open, no spawn)
    (spawner.spawn as ReturnType<typeof vi.fn>).mockClear();
    await messageBus.emit(makeInboundEvent('web'));
    expect(spawner.spawn).not.toHaveBeenCalled();
  });

  it('circuit breaker resets after cooldown and successful half-open test', async () => {
    const agent = makeAgent({ id: 'cb-agent', channels: ['web'], concurrency: 5 });
    const routingTable = new Map([['web', 'cb-agent']]);
    const agentMap = new Map([['cb-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();
    (spawner.spawn as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('fail'));
    const messageBus = new MessageBus();

    createPersistentAgentHandler({
      messageBus, agentRepo, spawner,
      maxRetries: 0, failureThreshold: 3, cooldownMs: 30_000,
    });

    // Trip the circuit
    for (let i = 0; i < 3; i++) {
      await messageBus.emit(makeInboundEvent('web'));
    }

    // Advance past cooldown
    vi.advanceTimersByTime(31_000);

    // Now spawner succeeds
    (spawner.spawn as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 'success', content: 'ok', durationMs: 50,
    });
    (spawner.spawn as ReturnType<typeof vi.fn>).mockClear();

    await messageBus.emit(makeInboundEvent('web'));
    expect(spawner.spawn).toHaveBeenCalledTimes(1);

    // Circuit should be closed now — another call should also work
    (spawner.spawn as ReturnType<typeof vi.fn>).mockClear();
    await messageBus.emit(makeInboundEvent('web'));
    expect(spawner.spawn).toHaveBeenCalledTimes(1);
  });

  it('bulkhead rejects when concurrency limit is reached', async () => {
    const agent = makeAgent({ id: 'bh-agent', channels: ['web'], concurrency: 1 });
    const routingTable = new Map([['web', 'bh-agent']]);
    const agentMap = new Map([['bh-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);

    // Create a spawner that hangs until we resolve it
    let resolveSpawn!: (value: AgentExecutionResult) => void;
    const hangingSpawner: ContainerSpawner = {
      spawn: vi.fn(() => new Promise<AgentExecutionResult>((resolve) => {
        resolveSpawn = resolve;
      })),
    };

    const messageBus = new MessageBus();

    createPersistentAgentHandler({
      messageBus, agentRepo, spawner: hangingSpawner, maxRetries: 0,
    });

    // First message starts spawning (takes the slot)
    const firstEmit = messageBus.emit(makeInboundEvent('web'));

    // Second message should be rejected (bulkhead full)
    const errorEvents: OutboundMessage[] = [];
    messageBus.on(OutboundMessage, (event) => { errorEvents.push(event); });

    await messageBus.emit(makeInboundEvent('web'));
    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0].text).toContain('error');

    // Resolve first spawn to clean up
    resolveSpawn({ status: 'success', content: 'done', durationMs: 100 });
    await firstEmit;
  });

  it('retries on spawn failure up to maxRetries', async () => {
    const agent = makeAgent({ id: 'retry-agent', channels: ['web'], concurrency: 5 });
    const routingTable = new Map([['web', 'retry-agent']]);
    const agentMap = new Map([['retry-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();

    let callCount = 0;
    (spawner.spawn as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount <= 2) {
        return { status: 'error' as const, content: 'temp failure', durationMs: 10 };
      }
      return { status: 'success' as const, content: 'ok', durationMs: 10 };
    });

    const messageBus = new MessageBus();

    createPersistentAgentHandler({
      messageBus, agentRepo, spawner,
      maxRetries: 2, retryDelayMs: 100,
    });

    // We need real timers for the retry delays
    vi.useRealTimers();

    await messageBus.emit(makeInboundEvent('web'));

    // Should have been called 3 times (initial + 2 retries)
    expect(spawner.spawn).toHaveBeenCalledTimes(3);

    vi.useFakeTimers();
  });

  it('reload() rebuilds routing table from repository', async () => {
    const agent = makeAgent({ id: 'wa-agent' });
    const initialTable = new Map([['whatsapp', 'wa-agent']]);
    const agentMap = new Map([['wa-agent', agent]]);
    const agentRepo = makeMockAgentRepo(initialTable, agentMap);
    const spawner = makeMockSpawner();
    const messageBus = new MessageBus();

    const handler = createPersistentAgentHandler({ messageBus, agentRepo, spawner });

    // Change routing table
    const tgAgent = makeAgent({ id: 'tg-agent', channels: ['telegram'] });
    const newTable = new Map([['telegram', 'tg-agent']]);
    const newAgentMap = new Map([['tg-agent', tgAgent]]);
    (agentRepo.buildRoutingTable as ReturnType<typeof vi.fn>).mockReturnValue(newTable);
    (agentRepo.getById as ReturnType<typeof vi.fn>).mockImplementation((id: string) => newAgentMap.get(id));

    handler.reload();

    // Old route should not work
    const waEvent = makeInboundEvent('whatsapp');
    await messageBus.emit(waEvent);
    expect(waEvent.cancelled).toBe(false);
    expect(spawner.spawn).not.toHaveBeenCalled();

    // New route should work
    const tgEvent = makeInboundEvent('telegram');
    await messageBus.emit(tgEvent);
    expect(tgEvent.cancelled).toBe(true);
    expect(spawner.spawn).toHaveBeenCalledWith('tg-agent', 'Hello', 'telegram:jid', 60_000);
  });

  it('destroy() unsubscribes from bus and stops routing', async () => {
    const agent = makeAgent({ id: 'wa-agent' });
    const routingTable = new Map([['whatsapp', 'wa-agent']]);
    const agentMap = new Map([['wa-agent', agent]]);
    const agentRepo = makeMockAgentRepo(routingTable, agentMap);
    const spawner = makeMockSpawner();
    const messageBus = new MessageBus();

    const handler = createPersistentAgentHandler({ messageBus, agentRepo, spawner });
    handler.destroy();

    const event = makeInboundEvent('whatsapp');
    await messageBus.emit(event);

    expect(event.cancelled).toBe(false);
    expect(spawner.spawn).not.toHaveBeenCalled();
  });
});
