import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { WriteQueue } from './write-queue.js';
import { createWriteQueue } from './write-queue.js';

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

describe('WriteQueue', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create a target table for test writes
    db.exec(`
      CREATE TABLE test_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        value TEXT
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function createAndFlush(overrides?: Parameters<typeof createWriteQueue>[1]): WriteQueue {
    return createWriteQueue(db, {
      drainIntervalMs: 10,
      batchSize: 100,
      maxAttempts: 3,
      ...overrides,
    });
  }

  // =========================================================================
  // Basic batch execution
  // =========================================================================

  it('executes INSERT statements in batches', async () => {
    const wq = createAndFlush();

    wq.enqueue({
      tableName: 'test_data',
      opType: 'insert',
      sql: "INSERT INTO test_data (name, value) VALUES (?, ?)",
      params: ['alice', 'a'],
    });

    wq.enqueue({
      tableName: 'test_data',
      opType: 'insert',
      sql: "INSERT INTO test_data (name, value) VALUES (?, ?)",
      params: ['bob', 'b'],
    });

    await wq.flush();
    wq.stop();

    const rows = db.prepare('SELECT name, value FROM test_data ORDER BY name').all() as { name: string; value: string }[];
    expect(rows).toEqual([
      { name: 'alice', value: 'a' },
      { name: 'bob', value: 'b' },
    ]);
  });

  // =========================================================================
  // SQL error handling
  // =========================================================================

  it('handles SQL errors (retryable vs non-retryable)', async () => {
    const wq = createAndFlush();

    // Valid insert
    wq.enqueue({
      tableName: 'test_data',
      opType: 'insert',
      sql: "INSERT INTO test_data (name, value) VALUES (?, ?)",
      params: ['valid', 'ok'],
    });

    // Invalid SQL (syntax error) - non-retryable
    wq.enqueue({
      tableName: 'test_data',
      opType: 'raw',
      sql: "INSERT INTO nonexistent_table (x) VALUES (?)",
      params: ['bad'],
    });

    await wq.flush();
    wq.stop();

    // The valid insert should have succeeded
    const rows = db.prepare('SELECT name FROM test_data').all() as { name: string }[];
    expect(rows).toEqual([{ name: 'valid' }]);

    // The bad insert should be dead-lettered (non-retryable)
    const m = wq.metrics();
    expect(m.totalFailed).toBeGreaterThan(0);
  });

  // =========================================================================
  // Non-retryable errors are not retried
  // =========================================================================

  it('non-retryable errors (syntax, missing table) are not retried', async () => {
    const wq = createAndFlush({ maxAttempts: 5 });

    wq.enqueue({
      tableName: 'test_data',
      opType: 'raw',
      sql: "INVALID SQL SYNTAX HERE !!",
      params: [],
    });

    await wq.flush();
    wq.stop();

    // Dead letter table should have the item after just 1 attempt (not retried)
    const deadRows = db
      .prepare("SELECT attempts FROM queue_db_writes_dead")
      .all() as { attempts: number }[];
    expect(deadRows).toHaveLength(1);
    // Non-retryable: dead-lettered on first attempt (attempts = 1)
    expect(deadRows[0].attempts).toBe(1);
  });

  // =========================================================================
  // Retryable errors are retried
  // =========================================================================

  it('retryable errors are retried', async () => {
    // UNIQUE/NOT NULL/CHECK/FK constraints and syntax errors are
    // classified as non-retryable in sql-drain-handler.ts.
    // Truly retryable errors (SQLITE_BUSY, SQLITE_LOCKED) are hard
    // to trigger in single-process tests, so we verify via the
    // durable queue directly with a custom drain handler that
    // returns retryable failures.
    const { createDurableQueue } = await import('../durable-queue/queue.js');

    let attempt = 0;
    const q = createDurableQueue<{ msg: string }>(db, {
      name: 'retry_test',
      maxAttempts: 3,
      drainIntervalMs: 10,
      drainHandler: (items) => {
        attempt++;
        return items.map(() => ({
          ok: false as const,
          retryable: true,
          error: `SQLITE_BUSY (attempt ${attempt})`,
        }));
      },
    });

    q.enqueue({ msg: 'retry-me' });
    await q.flush();
    q.stop();

    // Should have been retried maxAttempts times then dead-lettered
    const deadRows = db
      .prepare("SELECT attempts FROM queue_retry_test_dead")
      .all() as { attempts: number }[];
    expect(deadRows).toHaveLength(1);
    expect(deadRows[0].attempts).toBe(3);
  });

  // =========================================================================
  // Transaction wrapping
  // =========================================================================

  it('batch wraps in a transaction', async () => {
    const wq = createAndFlush();

    // Enqueue several valid writes
    for (let i = 0; i < 5; i++) {
      wq.enqueue({
        tableName: 'test_data',
        opType: 'insert',
        sql: "INSERT INTO test_data (name, value) VALUES (?, ?)",
        params: [`item-${i}`, `val-${i}`],
      });
    }

    await wq.flush();
    wq.stop();

    const count = db.prepare('SELECT COUNT(*) as cnt FROM test_data').get() as { cnt: number };
    expect(count.cnt).toBe(5);
  });
});
