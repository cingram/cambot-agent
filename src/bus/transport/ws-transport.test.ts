import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WebSocketManager } from '../../channels/web-ws.js';
import { BusEvent } from '../bus-event.js';
import { MessageBus, createMessageBus } from '../message-bus.js';
import { createWsTransport } from './ws-transport.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test events
// ---------------------------------------------------------------------------

class TestEvent extends BusEvent {
  readonly data: string;

  constructor(source: string, data: string) {
    super('test.event', source);
    this.data = data;
  }
}

class OtherEvent extends BusEvent {
  readonly value: number;

  constructor(source: string, value: number) {
    super('other.event', source);
    this.value = value;
  }
}

// ---------------------------------------------------------------------------
// Mock WebSocketManager
// ---------------------------------------------------------------------------

function createMockWsManager(): WebSocketManager {
  return {
    broadcast: vi.fn(),
    clientCount: vi.fn(() => 1),
    attach: vi.fn(),
    onInboundMessage: vi.fn(),
    onClientConnect: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocketManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createWsTransport', () => {
  let bus: MessageBus;
  let mockWsManager: WebSocketManager;

  beforeEach(() => {
    bus = createMessageBus();
    mockWsManager = createMockWsManager();
  });

  it('has the name "ws-transport"', () => {
    const transport = createWsTransport(mockWsManager);
    expect(transport.name).toBe('ws-transport');
  });

  it('broadcasts events via wsManager.broadcast after emit', async () => {
    const transport = createWsTransport(mockWsManager);
    bus.use(transport);

    const event = new TestEvent('unit-test', 'hello');
    await bus.emit(event);

    expect(mockWsManager.broadcast).toHaveBeenCalledTimes(1);
  });

  it('serializes event envelope fields correctly', async () => {
    const transport = createWsTransport(mockWsManager);
    bus.use(transport);

    const event = new TestEvent('unit-test', 'hello');
    await bus.emit(event);

    const broadcastCall = vi.mocked(mockWsManager.broadcast).mock.calls[0][0];
    expect(broadcastCall).toMatchObject({
      id: event.id,
      type: 'test.event',
      source: 'unit-test',
      timestamp: event.timestamp,
    });
  });

  it('includes domain-specific properties (e.g., data from TestEvent)', async () => {
    const transport = createWsTransport(mockWsManager);
    bus.use(transport);

    const event = new TestEvent('unit-test', 'hello-world');
    await bus.emit(event);

    const broadcastCall = vi.mocked(mockWsManager.broadcast).mock.calls[0][0];
    expect(broadcastCall).toHaveProperty('data', 'hello-world');
  });

  it('filters by eventTypes when specified', async () => {
    const transport = createWsTransport(mockWsManager, {
      eventTypes: ['test.event'],
    });
    bus.use(transport);

    // This should be broadcast (matches filter)
    await bus.emit(new TestEvent('unit-test', 'included'));
    expect(mockWsManager.broadcast).toHaveBeenCalledTimes(1);

    // This should NOT be broadcast (does not match filter)
    await bus.emit(new OtherEvent('unit-test', 42));
    expect(mockWsManager.broadcast).toHaveBeenCalledTimes(1); // still 1
  });

  it('broadcasts all events when eventTypes not specified', async () => {
    const transport = createWsTransport(mockWsManager);
    bus.use(transport);

    await bus.emit(new TestEvent('unit-test', 'first'));
    await bus.emit(new OtherEvent('unit-test', 99));

    expect(mockWsManager.broadcast).toHaveBeenCalledTimes(2);
  });

  it('does not broadcast when clientCount is 0 (optimization)', async () => {
    vi.mocked(mockWsManager.clientCount).mockReturnValue(0);

    const transport = createWsTransport(mockWsManager);
    bus.use(transport);

    await bus.emit(new TestEvent('unit-test', 'nobody listening'));

    expect(mockWsManager.broadcast).not.toHaveBeenCalled();
  });

  it('custom serializer overrides default serialization', async () => {
    const customSerializer = vi.fn((event: BusEvent) => ({
      custom: true,
      eventType: event.type,
    }));

    const transport = createWsTransport(mockWsManager, {
      serializer: customSerializer,
    });
    bus.use(transport);

    const event = new TestEvent('unit-test', 'custom');
    await bus.emit(event);

    expect(customSerializer).toHaveBeenCalledWith(event);
    expect(mockWsManager.broadcast).toHaveBeenCalledWith({
      custom: true,
      eventType: 'test.event',
    });
  });

  it('uses after hook (not before) — handler runs before broadcast', async () => {
    const executionOrder: string[] = [];

    const transport = createWsTransport(mockWsManager);
    bus.use(transport);

    vi.mocked(mockWsManager.broadcast).mockImplementation(() => {
      executionOrder.push('broadcast');
    });

    bus.on(TestEvent, () => {
      executionOrder.push('handler');
    });

    await bus.emit(new TestEvent('unit-test', 'order-test'));

    expect(executionOrder).toEqual(['handler', 'broadcast']);
  });

  it('only defines after hook, not before hook', () => {
    const transport = createWsTransport(mockWsManager);
    expect(transport.after).toBeDefined();
    expect(transport.before).toBeUndefined();
  });

  it('broadcasts all when eventTypes is empty array', async () => {
    const transport = createWsTransport(mockWsManager, {
      eventTypes: [],
    });
    bus.use(transport);

    await bus.emit(new TestEvent('unit-test', 'a'));
    await bus.emit(new OtherEvent('unit-test', 1));

    expect(mockWsManager.broadcast).toHaveBeenCalledTimes(2);
  });

  it('includes envelope optional fields when present', async () => {
    const transport = createWsTransport(mockWsManager);
    bus.use(transport);

    class EnvelopeEvent extends BusEvent {
      constructor() {
        super('envelope.test', 'src', {
          correlationId: 'corr-123',
          channel: 'web',
        });
      }
    }

    const event = new EnvelopeEvent();
    await bus.emit(event);

    const broadcastCall = vi.mocked(mockWsManager.broadcast).mock.calls[0][0];
    expect(broadcastCall).toMatchObject({
      correlationId: 'corr-123',
      channel: 'web',
    });
  });
});
