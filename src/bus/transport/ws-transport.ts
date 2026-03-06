import type { WebSocketManager } from '../../channels/web-ws.js';
import type { BusEvent } from '../bus-event.js';
import { extractDomainData } from '../event-serialization.js';
import type { BusMiddleware } from '../middleware.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WsTransportOptions {
  /** Which event types to broadcast. Default: all ('*'). */
  eventTypes?: string[];
  /** Serialize event for wire format. Default: JSON envelope. */
  serializer?: (event: BusEvent) => Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Default serializer
// ---------------------------------------------------------------------------

function defaultSerializer(event: BusEvent): Record<string, unknown> {
  return {
    id: event.id,
    type: event.type,
    source: event.source,
    channel: event.channel,
    correlationId: event.correlationId,
    timestamp: event.timestamp,
    ...extractDomainData(event),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWsTransport(
  wsManager: WebSocketManager,
  opts?: WsTransportOptions,
): BusMiddleware {
  const allowedTypes = opts?.eventTypes;
  const broadcastAll = !allowedTypes || allowedTypes.length === 0;
  const allowedSet = broadcastAll ? null : new Set(allowedTypes);
  const serialize = opts?.serializer ?? defaultSerializer;

  return {
    name: 'ws-transport',

    after(event: BusEvent): void {
      if (wsManager.clientCount() === 0) return;
      if (allowedSet && !allowedSet.has(event.type)) return;

      wsManager.broadcast(serialize(event));
    },
  };
}
