import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BusEvent } from './bus-event.js';
import type { EnvelopeOptions } from './envelope.js';
import type { BusMiddleware } from './middleware.js';
import { MessageBus, createMessageBus, GenericEvent } from './message-bus.js';

// ---------------------------------------------------------------------------
// Mock the logger so handler errors don't pollute test output
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test event subclasses
// ---------------------------------------------------------------------------

class TestEvent extends BusEvent {
  readonly type = 'test.event';
  constructor(source: string, envelope?: EnvelopeOptions) {
    super('test.event', source, envelope);
  }
}

class OtherEvent extends BusEvent {
  readonly type = 'other.event';
  constructor(source: string, envelope?: EnvelopeOptions) {
    super('other.event', source, envelope);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageBus', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = createMessageBus();
  });

  // =========================================================================
  // Class-based routing (existing behavior)
  // =========================================================================

  describe('class-based routing', () => {
    it('calls matching handlers by instanceof', async () => {
      const handler = vi.fn();
      bus.on(TestEvent, handler);

      const event = new TestEvent('test');
      await bus.emit(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('does not call non-matching handlers', async () => {
      const testHandler = vi.fn();
      const otherHandler = vi.fn();
      bus.on(TestEvent, testHandler);
      bus.on(OtherEvent, otherHandler);

      await bus.emit(new TestEvent('test'));

      expect(testHandler).toHaveBeenCalledOnce();
      expect(otherHandler).not.toHaveBeenCalled();
    });

    it('runs handlers in priority order (lower number = higher priority)', async () => {
      const order: number[] = [];

      bus.on(TestEvent, () => { order.push(3); }, { priority: 300, sequential: true });
      bus.on(TestEvent, () => { order.push(1); }, { priority: 100, sequential: true });
      bus.on(TestEvent, () => { order.push(2); }, { priority: 200, sequential: true });

      await bus.emit(new TestEvent('test'));

      expect(order).toEqual([1, 2, 3]);
    });

    it('runs sequentially when any handler sets sequential: true', async () => {
      const order: number[] = [];

      bus.on(TestEvent, async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }, { priority: 100, sequential: true });

      bus.on(TestEvent, () => {
        order.push(2);
      }, { priority: 200 });

      await bus.emit(new TestEvent('test'));

      // Handler 1 (slow) should finish before handler 2 starts
      expect(order).toEqual([1, 2]);
    });

    it('runs in parallel via Promise.allSettled when no handler is sequential', async () => {
      const timestamps: number[] = [];

      bus.on(TestEvent, async () => {
        timestamps.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
      }, { priority: 100 });

      bus.on(TestEvent, async () => {
        timestamps.push(Date.now());
        await new Promise((r) => setTimeout(r, 50));
      }, { priority: 200 });

      await bus.emit(new TestEvent('test'));

      // Both handlers should start nearly simultaneously (within 20ms)
      expect(timestamps).toHaveLength(2);
      expect(Math.abs(timestamps[0] - timestamps[1])).toBeLessThan(20);
    });

    it('stops sequential handler chain when event is cancelled', async () => {
      const order: string[] = [];

      bus.on(TestEvent, (event) => {
        order.push('first');
        event.cancelled = true;
      }, { priority: 100, sequential: true });

      bus.on(TestEvent, () => {
        order.push('second');
      }, { priority: 200, sequential: true });

      await bus.emit(new TestEvent('test'));

      expect(order).toEqual(['first']);
    });

    it('returns an unsubscribe function that removes the handler', async () => {
      const handler = vi.fn();
      const unsub = bus.on(TestEvent, handler);

      await bus.emit(new TestEvent('test'));
      expect(handler).toHaveBeenCalledOnce();

      unsub();

      await bus.emit(new TestEvent('test'));
      // Still only called once — unsubscribed
      expect(handler).toHaveBeenCalledOnce();
    });

    it('logs handler errors without crashing the bus (sequential)', async () => {
      const { logger } = await import('../logger.js');
      vi.mocked(logger.error).mockClear();

      const good = vi.fn();
      const bad = vi.fn(() => { throw new Error('handler boom'); });

      bus.on(TestEvent, bad, { priority: 100, sequential: true });
      bus.on(TestEvent, good, { priority: 200, sequential: true });

      // Should not throw
      await bus.emit(new TestEvent('test'));

      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });

    it('logs handler errors without crashing the bus (parallel, async rejection)', async () => {
      const { logger } = await import('../logger.js');
      vi.mocked(logger.error).mockClear();

      const good = vi.fn();
      const bad = vi.fn(async () => { throw new Error('async handler boom'); });

      bus.on(TestEvent, bad, { priority: 100 });
      bus.on(TestEvent, good, { priority: 200 });

      // Should not throw
      await bus.emit(new TestEvent('test'));

      expect(bad).toHaveBeenCalled();
      expect(good).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // String-based routing (NEW)
  // =========================================================================

  describe('string-based routing', () => {
    it('routes by exact type string match', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler);

      const event = new TestEvent('test');
      await bus.emit(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('does not call string handler for non-matching type', async () => {
      const handler = vi.fn();
      bus.on('other.event', handler);

      await bus.emit(new TestEvent('test'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('wildcard "*" handler receives all events', async () => {
      const handler = vi.fn();
      bus.on('*', handler);

      const testEvt = new TestEvent('test');
      const otherEvt = new OtherEvent('test');
      await bus.emit(testEvt);
      await bus.emit(otherEvt);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenCalledWith(testEvt);
      expect(handler).toHaveBeenCalledWith(otherEvt);
    });

    it('string handler and class handler coexist for same event type', async () => {
      const classHandler = vi.fn();
      const stringHandler = vi.fn();

      bus.on(TestEvent, classHandler);
      bus.on('test.event', stringHandler);

      const event = new TestEvent('test');
      await bus.emit(event);

      expect(classHandler).toHaveBeenCalledOnce();
      expect(stringHandler).toHaveBeenCalledOnce();
    });

    it('string handlers respect priority ordering', async () => {
      const order: number[] = [];

      bus.on('test.event', () => { order.push(3); }, { priority: 300, sequential: true });
      bus.on('test.event', () => { order.push(1); }, { priority: 100, sequential: true });
      bus.on('test.event', () => { order.push(2); }, { priority: 200, sequential: true });

      await bus.emit(new TestEvent('test'));

      expect(order).toEqual([1, 2, 3]);
    });

    it('string handlers respect sequential flag', async () => {
      const order: number[] = [];

      bus.on('test.event', async () => {
        await new Promise((r) => setTimeout(r, 10));
        order.push(1);
      }, { priority: 100, sequential: true });

      bus.on('test.event', () => {
        order.push(2);
      }, { priority: 200 });

      await bus.emit(new TestEvent('test'));

      expect(order).toEqual([1, 2]);
    });
  });

  // =========================================================================
  // Subscription filters (NEW)
  // =========================================================================

  describe('subscription filters', () => {
    it('filters by a single property match', async () => {
      const handler = vi.fn();
      bus.on(TestEvent, handler, { filter: { channel: 'web' } });

      await bus.emit(new TestEvent('test', { channel: 'web' }));
      await bus.emit(new TestEvent('test', { channel: 'email' }));
      await bus.emit(new TestEvent('test'));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('requires ALL filter keys to match (AND logic)', async () => {
      const handler = vi.fn();
      bus.on(TestEvent, handler, {
        filter: { channel: 'web', source: 'api' },
      });

      // Only channel matches
      await bus.emit(new TestEvent('other-source', { channel: 'web' }));
      expect(handler).not.toHaveBeenCalled();

      // Both match
      await bus.emit(new TestEvent('api', { channel: 'web' }));
      expect(handler).toHaveBeenCalledOnce();
    });

    it('does not call handler when no events match the filter', async () => {
      const handler = vi.fn();
      bus.on(TestEvent, handler, { filter: { channel: 'sms' } });

      await bus.emit(new TestEvent('test', { channel: 'web' }));
      await bus.emit(new TestEvent('test'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('works with string-based subscriptions', async () => {
      const handler = vi.fn();
      bus.on('test.event', handler, { filter: { channel: 'web' } });

      await bus.emit(new TestEvent('test', { channel: 'web' }));
      await bus.emit(new TestEvent('test', { channel: 'email' }));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('works with wildcard string subscriptions', async () => {
      const handler = vi.fn();
      bus.on('*', handler, { filter: { channel: 'web' } });

      await bus.emit(new TestEvent('test', { channel: 'web' }));
      await bus.emit(new OtherEvent('test', { channel: 'web' }));
      await bus.emit(new TestEvent('test', { channel: 'email' }));

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // Middleware pipeline (NEW)
  // =========================================================================

  describe('middleware pipeline', () => {
    it('registers middleware via use()', async () => {
      const before = vi.fn();
      bus.use({ name: 'test-mw', before });

      await bus.emit(new TestEvent('test'));

      expect(before).toHaveBeenCalledOnce();
    });

    it('before hook runs before handlers', async () => {
      const order: string[] = [];

      bus.use({
        name: 'ordering-mw',
        before: () => { order.push('before'); },
      });

      bus.on(TestEvent, () => { order.push('handler'); });

      await bus.emit(new TestEvent('test'));

      expect(order).toEqual(['before', 'handler']);
    });

    it('before hook returning false drops the event (handlers not called)', async () => {
      const handler = vi.fn();

      bus.use({
        name: 'dropper',
        before: () => false,
      });

      bus.on(TestEvent, handler);

      await bus.emit(new TestEvent('test'));

      expect(handler).not.toHaveBeenCalled();
    });

    it('multiple before hooks run in registration order', async () => {
      const order: number[] = [];

      bus.use({ name: 'mw-1', before: () => { order.push(1); } });
      bus.use({ name: 'mw-2', before: () => { order.push(2); } });
      bus.use({ name: 'mw-3', before: () => { order.push(3); } });

      await bus.emit(new TestEvent('test'));

      expect(order).toEqual([1, 2, 3]);
    });

    it('after hook runs after all handlers complete', async () => {
      const order: string[] = [];

      bus.use({
        name: 'after-mw',
        after: () => { order.push('after'); },
      });

      bus.on(TestEvent, () => { order.push('handler'); });

      await bus.emit(new TestEvent('test'));

      expect(order).toEqual(['handler', 'after']);
    });

    it('after hooks run even if a handler threw', async () => {
      const afterHook = vi.fn();

      bus.use({
        name: 'resilient-after',
        after: afterHook,
        onError: () => true, // suppress error logging
      });

      bus.on(TestEvent, () => { throw new Error('handler fail'); }, { sequential: true });

      await bus.emit(new TestEvent('test'));

      expect(afterHook).toHaveBeenCalledOnce();
    });

    it('onError hook receives handler errors', async () => {
      const onError = vi.fn(() => true);
      const thrownError = new Error('deliberate');

      bus.use({ name: 'error-catcher', onError });

      bus.on(TestEvent, () => { throw thrownError; }, {
        id: 'failing-handler',
        sequential: true,
      });

      await bus.emit(new TestEvent('test'));

      expect(onError).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(
        thrownError,
        expect.any(TestEvent),
        'failing-handler',
      );
    });

    it('onError returning true suppresses the default error log', async () => {
      const { logger } = await import('../logger.js');
      vi.mocked(logger.error).mockClear();

      bus.use({ name: 'suppressor', onError: () => true });

      bus.on(TestEvent, () => { throw new Error('suppressed'); }, { sequential: true });

      await bus.emit(new TestEvent('test'));

      // logger.error should NOT have been called for the handler error
      expect(logger.error).not.toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        'MessageBus handler failed',
      );
    });

    it('middleware with only before hook works fine (no after/onError)', async () => {
      const handler = vi.fn();
      bus.use({ name: 'before-only', before: () => {} });
      bus.on(TestEvent, handler);

      await bus.emit(new TestEvent('test'));

      expect(handler).toHaveBeenCalledOnce();
    });

    it('middleware with only after hook works fine (no before/onError)', async () => {
      const afterHook = vi.fn();
      bus.use({ name: 'after-only', after: afterHook });
      bus.on(TestEvent, () => {});

      await bus.emit(new TestEvent('test'));

      expect(afterHook).toHaveBeenCalledOnce();
    });

    it('middleware with only onError hook works fine (no before/after)', async () => {
      const onError = vi.fn(() => true);
      bus.use({ name: 'error-only', onError });
      bus.on(TestEvent, () => { throw new Error('boom'); }, { sequential: true });

      await bus.emit(new TestEvent('test'));

      expect(onError).toHaveBeenCalledOnce();
    });
  });

  // =========================================================================
  // Event type registry (NEW)
  // =========================================================================

  describe('event type registry', () => {
    it('registerEventType stores a type descriptor', () => {
      bus.registerEventType('test.event', 'A test event');

      const types = bus.listEventTypes();
      expect(types).toHaveLength(1);
      expect(types[0]).toEqual({ type: 'test.event', description: 'A test event' });
    });

    it('listEventTypes returns all registered types', () => {
      bus.registerEventType('type.a', 'Type A');
      bus.registerEventType('type.b', 'Type B');
      bus.registerEventType('type.c', 'Type C');

      const types = bus.listEventTypes();
      expect(types).toHaveLength(3);
      expect(types.map((t) => t.type)).toEqual(['type.a', 'type.b', 'type.c']);
    });

    it('registering same type twice is idempotent (no duplicates)', () => {
      bus.registerEventType('test.event', 'A test event');
      bus.registerEventType('test.event', 'A test event again');

      const types = bus.listEventTypes();
      expect(types).toHaveLength(1);
    });

    it('returns empty array when no types registered', () => {
      expect(bus.listEventTypes()).toEqual([]);
    });
  });

  // =========================================================================
  // GenericEvent
  // =========================================================================

  describe('GenericEvent', () => {
    it('creates a valid BusEvent with type, source, and data', () => {
      const event = new GenericEvent('custom.type', 'source', { key: 'value' });

      expect(event.type).toBe('custom.type');
      expect(event.source).toBe('source');
      expect(event.data).toEqual({ key: 'value' });
      expect(event).toBeInstanceOf(BusEvent);
    });

    it('holds the data payload', () => {
      const payload = { foo: 'bar', count: 42, nested: { a: true } };
      const event = new GenericEvent('custom.type', 'src', payload);

      expect(event.data).toEqual(payload);
    });

    it('routes correctly by instanceof (GenericEvent and BusEvent)', async () => {
      const genericHandler = vi.fn();
      const baseHandler = vi.fn();

      bus.on(GenericEvent, genericHandler);
      bus.on(BusEvent, baseHandler);

      const event = new GenericEvent('custom.type', 'src', {});
      await bus.emit(event);

      expect(genericHandler).toHaveBeenCalledWith(event);
      expect(baseHandler).toHaveBeenCalledWith(event);
    });

    it('routes correctly by string type', async () => {
      const handler = vi.fn();
      bus.on('custom.type', handler);

      const event = new GenericEvent('custom.type', 'src', { x: 1 });
      await bus.emit(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it('accepts envelope options', () => {
      const event = new GenericEvent('custom.type', 'src', { key: 'val' }, {
        correlationId: 'corr-gen',
        channel: 'web',
        version: 2,
      });

      expect(event.correlationId).toBe('corr-gen');
      expect(event.channel).toBe('web');
      expect(event.version).toBe(2);
    });
  });

  // =========================================================================
  // createMessageBus factory
  // =========================================================================

  describe('createMessageBus', () => {
    it('returns a MessageBus instance', () => {
      const b = createMessageBus();
      expect(b).toBeInstanceOf(MessageBus);
    });
  });
});
