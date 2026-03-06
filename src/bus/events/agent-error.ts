import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class AgentError extends BusEvent {
  readonly chatJid: string;
  readonly error: string;
  readonly durationMs: number;

  constructor(
    source: string,
    chatJid: string,
    error: string,
    durationMs: number,
    envelope?: EnvelopeOptions,
  ) {
    super('agent.error', source, envelope);
    this.chatJid = chatJid;
    this.error = error;
    this.durationMs = durationMs;
  }
}
