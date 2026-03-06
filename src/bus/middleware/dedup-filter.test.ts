import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BusEvent } from '../bus-event.js';
import type { BusMiddleware } from '../middleware.js';
import { createDedupFilter } from './dedup-filter.js';

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
  constructor(source: string, id?: string) {
    super('test.event', source, id ? { id } : undefined);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDedupFilter', () => {
  let middleware: BusMiddleware;

  beforeEach(() => {
    middleware = createDedupFilter();
  });

  it('has the name "dedup-filter"', () => {
    expect(middleware.name).toBe('dedup-filter');
  });

  it('allows first occurrence of an event through', () => {
    const event = new TestEvent('src', 'evt-1');
    const result = middleware.before!(event);
    expect(result).not.toBe(false);
  });

  it('drops duplicate event (same id emitted twice)', () => {
    const event = new TestEvent('src', 'evt-dup');

    middleware.before!(event);
    const result = middleware.before!(event);

    expect(result).toBe(false);
  });

  it('allows different events through (different ids)', () => {
    const event1 = new TestEvent('src', 'evt-a');
    const event2 = new TestEvent('src', 'evt-b');

    const r1 = middleware.before!(event1);
    const r2 = middleware.before!(event2);

    expect(r1).not.toBe(false);
    expect(r2).not.toBe(false);
  });

  it('evicts oldest entry when maxSize exceeded', () => {
    const small = createDedupFilter({ maxSize: 2 });

    const evt1 = new TestEvent('src', 'evt-1');
    const evt2 = new TestEvent('src', 'evt-2');
    const evt3 = new TestEvent('src', 'evt-3');

    small.before!(evt1);
    small.before!(evt2);
    // Cache is now full [evt-1, evt-2]. Adding evt-3 should evict evt-1.
    small.before!(evt3);

    // evt-3 should be deduped (still in cache)
    expect(small.before!(evt3)).toBe(false);

    // evt-2 should be deduped (still in cache)
    expect(small.before!(evt2)).toBe(false);

    // evt-1 was evicted, so it should be allowed again
    // (checking this last to avoid re-inserting and triggering another eviction)
    const fresh = createDedupFilter({ maxSize: 2 });
    fresh.before!(new TestEvent('src', 'a'));
    fresh.before!(new TestEvent('src', 'b'));
    fresh.before!(new TestEvent('src', 'c')); // evicts 'a'
    expect(fresh.before!(new TestEvent('src', 'a'))).not.toBe(false);
  });

  it('custom maxSize works', () => {
    const custom = createDedupFilter({ maxSize: 3 });

    for (let i = 0; i < 3; i++) {
      custom.before!(new TestEvent('src', `evt-${i}`));
    }

    // All three should be deduplicated
    for (let i = 0; i < 3; i++) {
      expect(custom.before!(new TestEvent('src', `evt-${i}`))).toBe(false);
    }

    // Adding a 4th should evict the oldest (evt-0)
    custom.before!(new TestEvent('src', 'evt-new'));
    expect(custom.before!(new TestEvent('src', 'evt-0'))).not.toBe(false);
  });

  it('default maxSize is 10_000', () => {
    // Verify the cache can hold 10_000 items without evicting
    const dedup = createDedupFilter();

    for (let i = 0; i < 10_000; i++) {
      dedup.before!(new TestEvent('src', `evt-${i}`));
    }

    // The first item should still be in cache (not evicted)
    expect(dedup.before!(new TestEvent('src', 'evt-0'))).toBe(false);

    // After 10_000 inserts, inserting the 10_001st should evict the oldest
    const dedup2 = createDedupFilter();

    for (let i = 0; i < 10_000; i++) {
      dedup2.before!(new TestEvent('src', `e-${i}`));
    }

    // Insert one more to exceed maxSize — evicts e-0
    dedup2.before!(new TestEvent('src', 'e-overflow'));

    // The second entry (e-1) should still be in cache
    expect(dedup2.before!(new TestEvent('src', 'e-1'))).toBe(false);

    // The oldest (e-0) should have been evicted — check with a fresh instance
    // to avoid side effects of re-inserting
    const dedup3 = createDedupFilter();
    for (let i = 0; i < 10_001; i++) {
      dedup3.before!(new TestEvent('src', `f-${i}`));
    }
    // f-0 was evicted
    expect(dedup3.before!(new TestEvent('src', 'f-0'))).not.toBe(false);
  });
});
