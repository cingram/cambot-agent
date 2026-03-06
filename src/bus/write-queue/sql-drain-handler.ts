/**
 * SQL drain handler -- processes WriteOp batches inside a single SQLite transaction.
 */

import type Database from 'better-sqlite3';
import type { DrainHandler, DrainResult, QueueItem } from '../durable-queue/types.js';
import type { WriteOp } from './types.js';

/**
 * Returns true if the SQLite error message indicates a transient failure
 * that should be retried. Schema and syntax errors are permanent.
 */
export function isRetryableError(msg: string): boolean {
  // Schema/syntax errors — permanent, never retry
  if (msg.includes('no such table')) return false;
  if (msg.includes('no such column')) return false;
  if (msg.includes('has no column')) return false;
  if (msg.includes('syntax error')) return false;
  // Constraint violations — permanent (same data will fail again)
  if (msg.includes('UNIQUE constraint failed')) return false;
  if (msg.includes('NOT NULL constraint failed')) return false;
  if (msg.includes('CHECK constraint failed')) return false;
  if (msg.includes('FOREIGN KEY constraint failed')) return false;
  // Everything else (SQLITE_BUSY, SQLITE_LOCKED, etc.) is transient
  return true;
}

/**
 * Creates a synchronous drain handler that wraps the batch in a single
 * SQLite transaction for maximum throughput.
 */
export function createSqlDrainHandler(
  db: Database.Database,
): DrainHandler<WriteOp> {
  return (items: QueueItem<WriteOp>[]): DrainResult[] => {
    const succeeded: number[] = [];
    const failed: Array<{
      index: number;
      error: string;
      retryable: boolean;
    }> = [];

    const runBatch = db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        try {
          const params = item.payload.params ?? [];
          db.prepare(item.payload.sql).run(...params);
          succeeded.push(i);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const retryable = isRetryableError(msg);
          failed.push({ index: i, error: msg, retryable });
          // Don't rethrow -- let other items in the batch proceed
        }
      }
    });

    try {
      runBatch();
    } catch (err) {
      // Entire transaction failed (e.g., SQLITE_BUSY) -- all items retry
      const msg = err instanceof Error ? err.message : String(err);
      return items.map(() => ({
        ok: false as const,
        retryable: true,
        error: msg,
      }));
    }

    // Map results
    const results: DrainResult[] = [];
    for (let i = 0; i < items.length; i++) {
      const fail = failed.find((f) => f.index === i);
      if (fail) {
        results.push({ ok: false, retryable: fail.retryable, error: fail.error });
      } else {
        results.push({ ok: true });
      }
    }

    return results;
  };
}
