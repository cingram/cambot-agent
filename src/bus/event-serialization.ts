/**
 * Shared event serialization utilities used by ws-transport and event-journal.
 */

import type { BusEvent } from './bus-event.js';
import { GenericEvent } from './message-bus.js';

/** Envelope keys that live in dedicated columns/fields, not in the data blob. */
export const ENVELOPE_KEYS = new Set([
  'id',
  'type',
  'version',
  'correlationId',
  'causationId',
  'target',
  'channel',
  'source',
  'timestamp',
  'cancelled',
]);

/** Extract domain-specific (non-envelope) own enumerable properties from an event. */
export function extractDomainData(event: BusEvent): Record<string, unknown> {
  if (event instanceof GenericEvent) {
    return event.data;
  }

  const data: Record<string, unknown> = {};
  for (const key of Object.keys(event)) {
    if (!ENVELOPE_KEYS.has(key)) {
      data[key] = (event as unknown as Record<string, unknown>)[key];
    }
  }
  return data;
}
