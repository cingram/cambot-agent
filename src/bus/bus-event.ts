import { randomUUID } from 'crypto';
import type { EnvelopeOptions } from './envelope.js';

/**
 * Abstract base for all bus events.
 *
 * Each subclass declares its own `type` string (e.g. 'message.inbound').
 * The envelope fields enable correlation tracking, routing, and versioning.
 */
export abstract class BusEvent {
  /** Unique event ID (UUID v4). */
  readonly id: string;
  /** Discriminator string set by each subclass (e.g. 'message.inbound'). */
  readonly type: string;
  /** Schema version for forward-compatible evolution. */
  readonly version: number;
  /** Links request/response chains across multiple events. */
  readonly correlationId?: string;
  /** Immediate parent event ID for causal ordering. */
  readonly causationId?: string;
  /** Routing target (agentId, jid). */
  readonly target?: string;
  /** Transport channel (whatsapp, web, email). */
  readonly channel?: string;
  /** Component that produced this event. */
  readonly source: string;
  /** ISO 8601 timestamp of event creation. */
  readonly timestamp: string;
  /** Mutable flag — handlers can cancel propagation. */
  cancelled = false;

  constructor(type: string, source: string, envelope?: EnvelopeOptions) {
    this.type = type;
    this.source = source;
    this.timestamp = new Date().toISOString();
    this.id = envelope?.id ?? randomUUID();
    this.version = envelope?.version ?? 1;
    this.correlationId = envelope?.correlationId;
    this.causationId = envelope?.causationId;
    this.target = envelope?.target;
    this.channel = envelope?.channel;
  }
}
