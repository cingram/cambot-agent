import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BusEvent } from '../bus-event.js';
import type { BusMiddleware } from '../middleware.js';
import { createBackpressureMiddleware } from './backpressure.js';

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
// Test event
// ---------------------------------------------------------------------------

class TestEvent extends BusEvent {
  constructor(source = 'test') {
    super('test.event', source);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createBackpressureMiddleware', () => {
  it('has the name "backpressure"', () => {
    const mw = createBackpressureMiddleware({
      highWaterMark: 5,
      strategy: 'drop',
    });
    expect(mw.name).toBe('backpressure');
  });

  describe('strategy: drop', () => {
    let mw: BusMiddleware;
    let onBackpressure: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      onBackpressure = vi.fn();
      mw = createBackpressureMiddleware({
        highWaterMark: 2,
        strategy: 'drop',
        onBackpressure,
      });
    });

    it('allows events under high water mark', () => {
      const evt1 = new TestEvent();
      const evt2 = new TestEvent();

      expect(mw.before!(evt1)).not.toBe(false);
      expect(mw.before!(evt2)).not.toBe(false);
    });

    it('drops events when limit exceeded', () => {
      // Fill up to high water mark
      mw.before!(new TestEvent());
      mw.before!(new TestEvent());

      // Third event exceeds high water mark
      const result = mw.before!(new TestEvent());
      expect(result).toBe(false);
    });

    it('calls onBackpressure callback when limit exceeded', () => {
      mw.before!(new TestEvent());
      mw.before!(new TestEvent());
      mw.before!(new TestEvent());

      expect(onBackpressure).toHaveBeenCalledOnce();
      expect(onBackpressure).toHaveBeenCalledWith(3);
    });

    it('decrements counter after event completes (allowing new events)', () => {
      const evt1 = new TestEvent();
      const evt2 = new TestEvent();

      mw.before!(evt1);
      mw.before!(evt2);

      // At high water mark, complete one event
      mw.after!(evt1);

      // Now a new event should be allowed (inFlight back to 1)
      const result = mw.before!(new TestEvent());
      expect(result).not.toBe(false);
    });
  });

  describe('strategy: warn', () => {
    let mw: BusMiddleware;
    let onBackpressure: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      onBackpressure = vi.fn();
      mw = createBackpressureMiddleware({
        highWaterMark: 2,
        strategy: 'warn',
        onBackpressure,
      });
    });

    it('warns but continues when limit exceeded', async () => {
      const { logger } = await import('../../logger.js');

      mw.before!(new TestEvent());
      mw.before!(new TestEvent());

      // Third event exceeds high water mark but should still be allowed
      const result = mw.before!(new TestEvent());
      expect(result).not.toBe(false);
      expect(logger.warn).toHaveBeenCalled();
    });

    it('calls onBackpressure callback when limit exceeded', () => {
      mw.before!(new TestEvent());
      mw.before!(new TestEvent());
      mw.before!(new TestEvent());

      expect(onBackpressure).toHaveBeenCalledOnce();
      expect(onBackpressure).toHaveBeenCalledWith(3);
    });
  });

  describe('counter tracking', () => {
    it('counter tracks correctly through multiple emit cycles', () => {
      const onBackpressure = vi.fn();
      const mw = createBackpressureMiddleware({
        highWaterMark: 2,
        strategy: 'drop',
        onBackpressure,
      });

      const evt1 = new TestEvent();
      const evt2 = new TestEvent();
      const evt3 = new TestEvent();

      // Cycle 1: fill up
      mw.before!(evt1);
      mw.before!(evt2);

      // Complete both
      mw.after!(evt1);
      mw.after!(evt2);

      // Cycle 2: should be able to fill up again
      mw.before!(evt3);
      const result = mw.before!(new TestEvent());
      expect(result).not.toBe(false);

      // Should not have triggered backpressure in cycle 2
      expect(onBackpressure).not.toHaveBeenCalled();
    });
  });
});
