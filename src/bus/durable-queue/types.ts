/**
 * DurableQueue<T> -- Generic SQLite-backed FIFO queue types.
 *
 * Provides durability, priority lanes, retry, dead-lettering,
 * backpressure, and observability for any payload type T.
 */

/** Regex for validating queue names (used as table name suffix). */
export const QUEUE_NAME_PATTERN = /^[a-z0-9_]+$/;

/** A single item in the queue. T is the payload type (serialized as JSON). */
export interface QueueItem<T> {
  id: number;
  payload: T;
  priority: number;
  attempts: number;
  createdAt: string;
  lastError: string | null;
}

/** Result returned by the drain handler for each item. */
export type DrainResult =
  | { ok: true }
  | { ok: false; retryable: boolean; error: string };

/** Synchronous drain handler -- processes a batch of items. */
export type DrainHandler<T> = (items: QueueItem<T>[]) => DrainResult[];

/** Async drain handler for handlers that need I/O (HTTP, filesystem, etc.). */
export type AsyncDrainHandler<T> = (
  items: QueueItem<T>[],
) => Promise<DrainResult[]>;

/** Snapshot of queue health metrics. */
export interface QueueMetrics {
  name: string;
  depth: number;
  deadLetterCount: number;
  totalEnqueued: number;
  totalDrained: number;
  totalFailed: number;
  avgBatchSize: number;
  avgDrainMs: number;
}

/** Events emitted via the onMetric callback for observability. */
export type QueueMetricEvent =
  | { type: 'drained'; batchSize: number; durationMs: number; depth: number }
  | { type: 'backpressure'; depth: number; highWaterMark: number }
  | { type: 'dead_letter'; payload: unknown; error: string; attempts: number }
  | { type: 'error'; error: string; phase: 'enqueue' | 'drain' };

/** Configuration for creating a DurableQueue instance. */
export interface DurableQueueConfig<T> {
  /** Unique queue name. Derives table names: `queue_{name}`, `queue_{name}_dead`. Must match [a-z0-9_]+. */
  name: string;
  /** Synchronous drain handler. Provide exactly one of drainHandler or asyncDrainHandler. */
  drainHandler?: DrainHandler<T>;
  /** Async drain handler. Provide exactly one of drainHandler or asyncDrainHandler. */
  asyncDrainHandler?: AsyncDrainHandler<T>;
  /** Drain interval in ms when queue has items. Default: 50 */
  drainIntervalMs?: number;
  /** Drain interval in ms when queue is empty (backs off). Default: 500 */
  idleIntervalMs?: number;
  /** Max items per drain batch. Default: 200 */
  batchSize?: number;
  /** Max retry attempts before dead-lettering. Default: 5 */
  maxAttempts?: number;
  /** Queue depth that triggers backpressure signal. Default: 5000 */
  highWaterMark?: number;
  /** Optional callback for metrics/errors (decoupled from EventBus). */
  onMetric?: (event: QueueMetricEvent) => void;
}

/** The public DurableQueue interface returned by the factory. */
export interface DurableQueue<T> {
  /** Queue name (used as table prefix and metric namespace). */
  readonly name: string;
  /** Enqueue a single item. Returns immediately. */
  enqueue(payload: T, priority?: number): void;
  /** Enqueue multiple items atomically. */
  enqueueBatch(items: Array<{ payload: T; priority?: number }>): void;
  /** Current pending item count. */
  depth(): number;
  /** Metrics snapshot. */
  metrics(): QueueMetrics;
  /** Register a backpressure callback. Returns unsubscribe function. */
  onBackpressure(cb: (depth: number) => void): () => void;
  /** Force an immediate drain cycle (runs until empty or only dead-letterable items remain). */
  flush(): Promise<void>;
  /** Stop the drain loop. Pending items remain in the staging table. */
  stop(): void;
  /** Start (or restart) the drain loop. */
  start(): void;
}
