/**
 * createDurableQueue<T>() -- Factory for SQLite-backed durable queues.
 *
 * Each queue gets its own pair of tables (queue_{name} and queue_{name}_dead),
 * created idempotently on construction.
 */

import type Database from 'better-sqlite3';
import type {
  DurableQueue,
  DurableQueueConfig,
  QueueMetrics,
} from './types.js';
import { QUEUE_NAME_PATTERN } from './types.js';
import { createDrainLoop, type DrainStats } from './drain.js';
import { registerQueue, unregisterQueue } from './registry.js';

/** Default configuration values. */
const DEFAULTS = {
  drainIntervalMs: 50,
  idleIntervalMs: 500,
  batchSize: 200,
  maxAttempts: 5,
  highWaterMark: 5000,
} as const;

function createTables(db: Database.Database, name: string): void {
  const table = `queue_${name}`;
  const deadTable = `queue_${name}_dead`;

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      priority   INTEGER NOT NULL DEFAULT 100,
      payload    TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      attempts   INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_${table}_drain
      ON ${table}(priority ASC, id ASC);

    CREATE TABLE IF NOT EXISTS ${deadTable} (
      id         INTEGER PRIMARY KEY,
      priority   INTEGER NOT NULL,
      payload    TEXT    NOT NULL,
      created_at TEXT    NOT NULL,
      failed_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      attempts   INTEGER NOT NULL,
      last_error TEXT
    );
  `);
}

export function createDurableQueue<T>(
  db: Database.Database,
  config: DurableQueueConfig<T>,
): DurableQueue<T> {
  // Validate queue name
  if (!QUEUE_NAME_PATTERN.test(config.name)) {
    throw new Error(
      `Invalid queue name "${config.name}": must match [a-z0-9_]+`,
    );
  }

  // Validate exactly one handler
  if (!config.drainHandler && !config.asyncDrainHandler) {
    throw new Error(
      'DurableQueue requires either drainHandler or asyncDrainHandler',
    );
  }
  if (config.drainHandler && config.asyncDrainHandler) {
    throw new Error(
      'DurableQueue requires exactly one of drainHandler or asyncDrainHandler, not both',
    );
  }

  const tableName = `queue_${config.name}`;
  const deadTableName = `queue_${config.name}_dead`;
  const highWaterMark = config.highWaterMark ?? DEFAULTS.highWaterMark;

  // Create tables idempotently
  createTables(db, config.name);

  // Prepared statements for enqueue
  const insertOne = db.prepare(
    `INSERT INTO ${tableName} (payload, priority) VALUES (?, ?)`,
  );
  const insertBatch = db.transaction(
    (items: Array<{ payload: string; priority: number }>) => {
      for (const item of items) {
        insertOne.run(item.payload, item.priority);
      }
    },
  );
  const countPending = db.prepare(
    `SELECT COUNT(*) as cnt FROM ${tableName}`,
  );
  const countDead = db.prepare(
    `SELECT COUNT(*) as cnt FROM ${deadTableName}`,
  );

  // Mutable state
  let totalEnqueued = 0;
  const backpressureCallbacks: Array<(depth: number) => void> = [];

  const stats: DrainStats = {
    totalDrained: 0,
    totalFailed: 0,
    batchSizes: [],
    drainDurations: [],
  };

  // Create drain loop
  const drain = createDrainLoop<T>({
    db,
    tableName,
    deadTableName,
    batchSize: config.batchSize ?? DEFAULTS.batchSize,
    maxAttempts: config.maxAttempts ?? DEFAULTS.maxAttempts,
    drainIntervalMs: config.drainIntervalMs ?? DEFAULTS.drainIntervalMs,
    idleIntervalMs: config.idleIntervalMs ?? DEFAULTS.idleIntervalMs,
    drainHandler: config.drainHandler,
    asyncDrainHandler: config.asyncDrainHandler,
    onMetric: config.onMetric,
    stats,
  });

  function checkBackpressure(): void {
    const d = (countPending.get() as { cnt: number }).cnt;
    if (d > highWaterMark) {
      config.onMetric?.({ type: 'backpressure', depth: d, highWaterMark });
      for (const cb of backpressureCallbacks) {
        try {
          cb(d);
        } catch {
          // Swallow backpressure callback errors
        }
      }
    }
  }

  const queue: DurableQueue<T> = {
    name: config.name,

    enqueue(payload: T, priority = 100): void {
      try {
        insertOne.run(JSON.stringify(payload), priority);
        totalEnqueued++;
        checkBackpressure();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        config.onMetric?.({ type: 'error', error: msg, phase: 'enqueue' });
        throw err;
      }
    },

    enqueueBatch(items: Array<{ payload: T; priority?: number }>): void {
      try {
        insertBatch(
          items.map((i) => ({
            payload: JSON.stringify(i.payload),
            priority: i.priority ?? 100,
          })),
        );
        totalEnqueued += items.length;
        checkBackpressure();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        config.onMetric?.({ type: 'error', error: msg, phase: 'enqueue' });
        throw err;
      }
    },

    depth(): number {
      return (countPending.get() as { cnt: number }).cnt;
    },

    metrics(): QueueMetrics {
      const avgBatchSize =
        stats.batchSizes.length > 0
          ? stats.batchSizes.reduce((a, b) => a + b, 0) /
            stats.batchSizes.length
          : 0;
      const avgDrainMs =
        stats.drainDurations.length > 0
          ? stats.drainDurations.reduce((a, b) => a + b, 0) /
            stats.drainDurations.length
          : 0;

      return {
        name: config.name,
        depth: queue.depth(),
        deadLetterCount: (countDead.get() as { cnt: number }).cnt,
        totalEnqueued,
        totalDrained: stats.totalDrained,
        totalFailed: stats.totalFailed,
        avgBatchSize,
        avgDrainMs,
      };
    },

    onBackpressure(cb: (depth: number) => void): () => void {
      backpressureCallbacks.push(cb);
      return () => {
        const idx = backpressureCallbacks.indexOf(cb);
        if (idx >= 0) backpressureCallbacks.splice(idx, 1);
      };
    },

    async flush(): Promise<void> {
      await drain.flush();
    },

    stop(): void {
      drain.stop();
      unregisterQueue(config.name);
    },

    start(): void {
      registerQueue(queue as DurableQueue<unknown>);
      drain.start();
    },
  };

  // Register and start drain loop
  registerQueue(queue as DurableQueue<unknown>);
  drain.start();

  return queue;
}
