import type { BusEvent } from './bus-event.js';

/**
 * Middleware that wraps the bus emit pipeline.
 *
 * - `before` runs before handlers; return `false` to drop the event.
 * - `after` runs after all handlers complete.
 * - `onError` runs when a handler throws; return `true` to suppress.
 */
export interface BusMiddleware {
  /** Human-readable name for logging / debugging. */
  name: string;
  /** Runs before handlers. Return `false` to drop the event entirely. */
  before?(event: BusEvent): boolean | void | Promise<boolean | void>;
  /** Runs after all handlers have completed. */
  after?(event: BusEvent): void | Promise<void>;
  /** Runs when a handler throws. Return `true` to suppress the error log. */
  onError?(error: unknown, event: BusEvent, handlerId: string): boolean | void | Promise<boolean | void>;
}
