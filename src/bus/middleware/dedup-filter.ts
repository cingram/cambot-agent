import type { BusMiddleware } from '../middleware.js';

export interface DedupFilterOptions {
  maxSize?: number; // default 10_000
}

export function createDedupFilter(opts?: DedupFilterOptions): BusMiddleware {
  const maxSize = opts?.maxSize ?? 10_000;
  const seen = new Map<string, true>();

  return {
    name: 'dedup-filter',

    before(event) {
      if (seen.has(event.id)) {
        // Duplicate detected — drop. No LRU refresh so first-seen time governs eviction.
        return false;
      }

      seen.set(event.id, true);

      if (seen.size > maxSize) {
        // Evict oldest entry (first key in insertion order)
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }

      return undefined;
    },
  };
}
