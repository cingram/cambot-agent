/**
 * Envelope metadata carried by every bus event.
 * Provides correlation, causation, routing, and versioning.
 */
export interface EnvelopeOptions {
  /** UUID, auto-generated if omitted. */
  id?: string;
  /** Links request/response chains. */
  correlationId?: string;
  /** Immediate parent event ID. */
  causationId?: string;
  /** Routing target (agentId, jid). */
  target?: string;
  /** Transport channel (whatsapp, web, email). */
  channel?: string;
  /** Schema version, default 1. */
  version?: number;
}
