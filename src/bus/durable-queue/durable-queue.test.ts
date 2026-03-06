import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { DurableQueue, DrainResult, QueueItem } from './types.js';
import { createDurableQueue } from './queue.js';

// ---------------------------------------------------------------------------
// Mock the logger so errors don't pollute test output
// ---------------------------------------------------------------------------
vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

describe('DurableQueue', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  // Helper: create a queue with a sync drain handler
  function createTestQueue(
    handler: (items: QueueItem<{ msg: string }>[]) => DrainResult[],
    overrides?: Partial<Parameters<typeof createDurableQueue<{ msg: string }>>[1]>,
  ): DurableQueue<{ msg: string }> {
    return createDurableQueue<{ msg: string }>(db, {
      name: 'test_queue',
      drainHandler: handler,
      drainIntervalMs: 10,
      idleIntervalMs: 50,
      batchSize: 100,
      maxAttempts: 3,
      highWaterMark: 5,
      ...overrides,
    });
  }

  // =========================================================================
  // Table creation
  // =========================================================================

  it('creates queue tables on construction', () => {
    const q = createTestQueue(() => []);
    q.stop();

    // Verify the main table and dead letter table exist
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'queue_%'",
      )
      .all() as { name: string }[];

    const tableNames = tables.map((t) => t.name);
    expect(tableNames).toContain('queue_test_queue');
    expect(tableNames).toContain('queue_test_queue_dead');
  });

  // =========================================================================
  // Enqueue and drain
  // =========================================================================

  it('enqueues and drains items', async () => {
    const drained: string[] = [];
    const q = createTestQueue((items) => {
      for (const item of items) {
        drained.push(item.payload.msg);
      }
      return items.map(() => ({ ok: true as const }));
    });

    q.enqueue({ msg: 'hello' });
    q.enqueue({ msg: 'world' });

    await q.flush();
    q.stop();

    expect(drained).toEqual(['hello', 'world']);
    expect(q.depth()).toBe(0);
  });

  // =========================================================================
  // Priority ordering
  // =========================================================================

  it('respects priority ordering (lower priority number = processed first)', async () => {
    const order: number[] = [];
    const q = createTestQueue((items) => {
      for (const item of items) {
        order.push(item.priority);
      }
      return items.map(() => ({ ok: true as const }));
    });

    q.enqueue({ msg: 'low' }, 300);
    q.enqueue({ msg: 'high' }, 1);
    q.enqueue({ msg: 'medium' }, 100);

    await q.flush();
    q.stop();

    expect(order).toEqual([1, 100, 300]);
  });

  // =========================================================================
  // Retry logic
  // =========================================================================

  it('retries failed items up to maxAttempts', async () => {
    let attempt = 0;
    const q = createTestQueue((items) => {
      attempt++;
      if (attempt < 3) {
        return items.map(() => ({
          ok: false as const,
          retryable: true,
          error: `attempt ${attempt}`,
        }));
      }
      return items.map(() => ({ ok: true as const }));
    });

    q.enqueue({ msg: 'retry-me' });
    await q.flush();
    q.stop();

    expect(attempt).toBe(3);
    expect(q.depth()).toBe(0);
  });

  // =========================================================================
  // Dead-lettering
  // =========================================================================

  it('dead-letters items after maxAttempts exceeded', async () => {
    const q = createTestQueue(
      (items) =>
        items.map(() => ({
          ok: false as const,
          retryable: true,
          error: 'always fails',
        })),
      { maxAttempts: 2 },
    );

    q.enqueue({ msg: 'doomed' });
    await q.flush();
    q.stop();

    // Main queue should be empty
    expect(q.depth()).toBe(0);

    // Dead letter table should have one item
    const deadCount = db
      .prepare('SELECT COUNT(*) as cnt FROM queue_test_queue_dead')
      .get() as { cnt: number };
    expect(deadCount.cnt).toBe(1);
  });

  // =========================================================================
  // Metrics
  // =========================================================================

  it('reports correct metrics (depth, deadLetterCount, totalEnqueued, totalDrained)', async () => {
    let callCount = 0;
    const q = createTestQueue((items) => {
      callCount++;
      // Fail the second item always (non-retryable -> dead letter immediately)
      return items.map((item) => {
        if (item.payload.msg === 'fail') {
          return { ok: false as const, retryable: false, error: 'bad' };
        }
        return { ok: true as const };
      });
    });

    q.enqueue({ msg: 'ok1' });
    q.enqueue({ msg: 'fail' });
    q.enqueue({ msg: 'ok2' });

    await q.flush();
    q.stop();

    const m = q.metrics();
    expect(m.name).toBe('test_queue');
    expect(m.depth).toBe(0);
    expect(m.deadLetterCount).toBe(1);
    expect(m.totalEnqueued).toBe(3);
    expect(m.totalDrained).toBe(2);
  });

  // =========================================================================
  // Backpressure
  // =========================================================================

  it('backpressure callback fires when depth exceeds highWaterMark', () => {
    const bpDepths: number[] = [];
    // Create queue with highWaterMark=5 and handler that never processes
    const q = createTestQueue(() => [], { highWaterMark: 5 });
    q.stop(); // Stop drain so items accumulate

    q.onBackpressure((depth) => {
      bpDepths.push(depth);
    });

    // Enqueue 6 items — the 6th should trigger backpressure
    for (let i = 0; i < 6; i++) {
      q.enqueue({ msg: `item-${i}` });
    }

    expect(bpDepths.length).toBeGreaterThan(0);
    expect(bpDepths[0]).toBeGreaterThan(5);
  });

  // =========================================================================
  // flush()
  // =========================================================================

  it('flush() drains all pending items', async () => {
    const drained: string[] = [];
    const q = createTestQueue((items) => {
      for (const item of items) {
        drained.push(item.payload.msg);
      }
      return items.map(() => ({ ok: true as const }));
    });

    for (let i = 0; i < 10; i++) {
      q.enqueue({ msg: `item-${i}` });
    }

    await q.flush();
    q.stop();

    expect(drained).toHaveLength(10);
    expect(q.depth()).toBe(0);
  });

  // =========================================================================
  // stop()
  // =========================================================================

  it('stop() halts the drain loop', async () => {
    let drainCount = 0;
    const q = createTestQueue((items) => {
      drainCount++;
      return items.map(() => ({ ok: true as const }));
    });

    q.stop();

    q.enqueue({ msg: 'after-stop' });

    // Wait a bit — drain should NOT run
    await new Promise((r) => setTimeout(r, 100));

    expect(drainCount).toBe(0);
    expect(q.depth()).toBe(1);
  });

  // =========================================================================
  // enqueueBatch()
  // =========================================================================

  it('enqueueBatch() inserts multiple items atomically', async () => {
    const drained: string[] = [];
    const q = createTestQueue((items) => {
      for (const item of items) {
        drained.push(item.payload.msg);
      }
      return items.map(() => ({ ok: true as const }));
    });

    q.enqueueBatch([
      { payload: { msg: 'a' } },
      { payload: { msg: 'b' }, priority: 1 },
      { payload: { msg: 'c' }, priority: 50 },
    ]);

    expect(q.depth()).toBe(3);

    await q.flush();
    q.stop();

    // Priority order: 1 (b), 50 (c), 100 (a)
    expect(drained).toEqual(['b', 'c', 'a']);
  });

  // =========================================================================
  // Name validation
  // =========================================================================

  it('queue name validation rejects invalid names', () => {
    expect(() =>
      createDurableQueue(db, {
        name: 'INVALID-NAME',
        drainHandler: () => [],
      }),
    ).toThrow(/Invalid queue name/);

    expect(() =>
      createDurableQueue(db, {
        name: 'has spaces',
        drainHandler: () => [],
      }),
    ).toThrow(/Invalid queue name/);

    expect(() =>
      createDurableQueue(db, {
        name: 'drop;table',
        drainHandler: () => [],
      }),
    ).toThrow(/Invalid queue name/);
  });

  // =========================================================================
  // Handler validation
  // =========================================================================

  it('requires exactly one drain handler', () => {
    expect(() =>
      createDurableQueue(db, {
        name: 'no_handler',
      } as any),
    ).toThrow(/requires either/);

    expect(() =>
      createDurableQueue(db, {
        name: 'both_handlers',
        drainHandler: () => [],
        asyncDrainHandler: async () => [],
      }),
    ).toThrow(/exactly one/);
  });
});
