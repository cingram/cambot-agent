/**
 * In-memory registry of active DurableQueue instances.
 * Used by diagnostics to discover and inspect queues.
 */

import type { DurableQueue, QueueMetrics } from './types.js';

const activeQueues = new Map<string, DurableQueue<unknown>>();

export function registerQueue(queue: DurableQueue<unknown>): void {
  activeQueues.set(queue.name, queue);
}

export function unregisterQueue(name: string): void {
  activeQueues.delete(name);
}

export function getQueue(name: string): DurableQueue<unknown> | undefined {
  return activeQueues.get(name);
}

export function listQueues(): Array<{ name: string; metrics: QueueMetrics }> {
  return [...activeQueues.entries()].map(([name, q]) => ({
    name,
    metrics: q.metrics(),
  }));
}

/** Clear all registered queues. For testing only. */
export function clearAllQueues(): void {
  activeQueues.clear();
}
