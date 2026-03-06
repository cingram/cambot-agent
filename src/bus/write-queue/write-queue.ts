/**
 * createWriteQueue() -- Thin wrapper around createDurableQueue<WriteOp>
 * specialized for batching SQLite write operations.
 */

import type Database from 'better-sqlite3';
import type { DurableQueue } from '../durable-queue/types.js';
import { createDurableQueue } from '../durable-queue/queue.js';
import { createSqlDrainHandler } from './sql-drain-handler.js';
import type { WriteOp } from './types.js';

export interface WriteQueueConfig {
  drainIntervalMs?: number;
  batchSize?: number;
  maxAttempts?: number;
  highWaterMark?: number;
  /** Optional metrics callback (replaces the cambot-core EventBus bridge). */
  onMetric?: (event: import('../durable-queue/types.js').QueueMetricEvent) => void;
}

export type WriteQueue = DurableQueue<WriteOp>;

export function createWriteQueue(
  db: Database.Database,
  config?: WriteQueueConfig,
): WriteQueue {
  return createDurableQueue<WriteOp>(db, {
    name: 'db_writes',
    drainHandler: createSqlDrainHandler(db),
    drainIntervalMs: config?.drainIntervalMs ?? 50,
    batchSize: config?.batchSize ?? 200,
    maxAttempts: config?.maxAttempts ?? 5,
    highWaterMark: config?.highWaterMark ?? 5000,
    onMetric: config?.onMetric,
  });
}
