/**
 * Drain loop logic for DurableQueue -- setTimeout chaining with adaptive interval.
 */

import type Database from 'better-sqlite3';
import type {
  QueueItem,
  DrainResult,
  DrainHandler,
  AsyncDrainHandler,
  QueueMetricEvent,
} from './types.js';
import { logger } from '../../logger.js';

export interface DrainDeps<T> {
  db: Database.Database;
  tableName: string;
  deadTableName: string;
  batchSize: number;
  maxAttempts: number;
  drainIntervalMs: number;
  idleIntervalMs: number;
  drainHandler?: DrainHandler<T>;
  asyncDrainHandler?: AsyncDrainHandler<T>;
  onMetric?: (event: QueueMetricEvent) => void;
  /** Mutable stats object shared with the queue factory. */
  stats: DrainStats;
}

export interface DrainStats {
  totalDrained: number;
  totalFailed: number;
  batchSizes: number[];
  drainDurations: number[];
}

export interface DrainControl {
  start(): void;
  stop(): void;
  flush(): Promise<void>;
}

/** Creates the drain loop controller. Uses setTimeout chaining to prevent overlapping ticks. */
export function createDrainLoop<T>(deps: DrainDeps<T>): DrainControl {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;

  const selectBatch = deps.db.prepare<
    [],
    {
      id: number;
      payload: string;
      priority: number;
      attempts: number;
      created_at: string;
      last_error: string | null;
    }
  >(
    `SELECT id, payload, priority, attempts, created_at, last_error
     FROM ${deps.tableName}
     ORDER BY priority ASC, id ASC
     LIMIT ${deps.batchSize}`,
  );

  const deleteItem = deps.db.prepare(
    `DELETE FROM ${deps.tableName} WHERE id = ?`,
  );

  const updateRetry = deps.db.prepare(
    `UPDATE ${deps.tableName} SET attempts = attempts + 1, last_error = ? WHERE id = ?`,
  );

  const insertDead = deps.db.prepare(
    `INSERT INTO ${deps.deadTableName} (id, priority, payload, created_at, attempts, last_error)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );

  const countPending = deps.db.prepare(
    `SELECT COUNT(*) as cnt FROM ${deps.tableName}`,
  );

  const moveToDead = deps.db.transaction(
    (row: {
      id: number;
      priority: number;
      payload: string;
      createdAt: string;
      attempts: number;
      error: string;
    }) => {
      insertDead.run(
        row.id,
        row.priority,
        row.payload,
        row.createdAt,
        row.attempts,
        row.error,
      );
      deleteItem.run(row.id);
    },
  );

  function parseBatch(
    rows: Array<{
      id: number;
      payload: string;
      priority: number;
      attempts: number;
      created_at: string;
      last_error: string | null;
    }>,
  ): QueueItem<T>[] {
    return rows.map((r) => ({
      id: r.id,
      payload: JSON.parse(r.payload) as T,
      priority: r.priority,
      attempts: r.attempts,
      createdAt: r.created_at,
      lastError: r.last_error,
    }));
  }

  /** Returns the number of items removed from the queue (succeeded + dead-lettered). */
  function processResults(
    items: QueueItem<T>[],
    rows: Array<{
      id: number;
      priority: number;
      payload: string;
      created_at: string;
      attempts: number;
    }>,
    results: DrainResult[],
  ): number {
    let removed = 0;

    for (let i = 0; i < items.length; i++) {
      const result = results[i];
      const row = rows[i];
      const item = items[i];

      if (result.ok) {
        deleteItem.run(row.id);
        deps.stats.totalDrained++;
        removed++;
      } else if (result.retryable) {
        const newAttempts = item.attempts + 1;
        if (newAttempts >= deps.maxAttempts) {
          moveToDead({
            id: row.id,
            priority: row.priority,
            payload: row.payload,
            createdAt: row.created_at,
            attempts: newAttempts,
            error: result.error,
          });
          deps.stats.totalFailed++;
          removed++;
          deps.onMetric?.({
            type: 'dead_letter',
            payload: item.payload,
            error: result.error,
            attempts: newAttempts,
          });
        } else {
          updateRetry.run(result.error, row.id);
        }
      } else {
        // Non-retryable: dead-letter immediately
        moveToDead({
          id: row.id,
          priority: row.priority,
          payload: row.payload,
          createdAt: row.created_at,
          attempts: item.attempts + 1,
          error: result.error,
        });
        deps.stats.totalFailed++;
        removed++;
        deps.onMetric?.({
          type: 'dead_letter',
          payload: item.payload,
          error: result.error,
          attempts: item.attempts + 1,
        });
      }
    }

    return removed;
  }

  interface DrainOnceResult {
    fetched: number;
    removed: number;
  }

  async function drainOnce(): Promise<DrainOnceResult> {
    const rows = selectBatch.all();
    if (rows.length === 0) return { fetched: 0, removed: 0 };

    const items = parseBatch(rows);
    const start = performance.now();
    let results: DrainResult[];

    try {
      if (deps.drainHandler) {
        results = deps.drainHandler(items);
      } else if (deps.asyncDrainHandler) {
        results = await deps.asyncDrainHandler(items);
      } else {
        return { fetched: 0, removed: 0 };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      deps.onMetric?.({ type: 'error', error: msg, phase: 'drain' });
      // Treat handler crash as retryable for all items
      results = items.map(() => ({
        ok: false as const,
        retryable: true,
        error: msg,
      }));
    }

    const durationMs = performance.now() - start;
    const removed = processResults(items, rows, results);

    // Track stats
    deps.stats.batchSizes.push(items.length);
    deps.stats.drainDurations.push(durationMs);
    // Keep rolling window of last 100 measurements
    if (deps.stats.batchSizes.length > 100) deps.stats.batchSizes.shift();
    if (deps.stats.drainDurations.length > 100)
      deps.stats.drainDurations.shift();

    const currentDepth = countPending.get() as { cnt: number };
    deps.onMetric?.({
      type: 'drained',
      batchSize: items.length,
      durationMs,
      depth: currentDepth.cnt,
    });

    return { fetched: items.length, removed };
  }

  function scheduleTick(): void {
    if (!running) return;

    timer = setTimeout(async () => {
      try {
        const { fetched } = await drainOnce();
        const interval =
          fetched > 0 ? deps.drainIntervalMs : deps.idleIntervalMs;
        if (running) {
          timer = setTimeout(() => scheduleTick(), interval);
        }
      } catch (err) {
        logger.error({ err }, 'DurableQueue drain tick failed');
        deps.onMetric?.({
          type: 'error',
          error: err instanceof Error ? err.message : String(err),
          phase: 'drain',
        });
        // Back off on error
        if (running) {
          timer = setTimeout(() => scheduleTick(), deps.idleIntervalMs);
        }
      }
    }, 0);
  }

  return {
    start() {
      if (running) return;
      running = true;
      scheduleTick();
    },

    stop() {
      running = false;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },

    async flush() {
      // Run drain ticks until queue is empty or all remaining items are
      // stuck (retryable but not yet at maxAttempts). We allow enough
      // consecutive no-progress passes for retries to accumulate.
      let maxIterations = 1000;
      let consecutiveNoProgress = 0;
      while (maxIterations-- > 0) {
        const pending = (countPending.get() as { cnt: number }).cnt;
        if (pending === 0) break;

        const { fetched, removed } = await drainOnce();
        if (fetched === 0) break;

        if (removed === 0) {
          consecutiveNoProgress++;
          // Allow enough passes for retries to reach maxAttempts
          if (consecutiveNoProgress >= deps.maxAttempts) break;
        } else {
          consecutiveNoProgress = 0;
        }
      }
    },
  };
}
