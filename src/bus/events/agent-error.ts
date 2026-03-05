import { BusEvent } from '../bus-event.js';

export class AgentError extends BusEvent {
  readonly chatJid: string;
  readonly error: string;
  readonly durationMs: number;

  constructor(source: string, chatJid: string, error: string, durationMs: number) {
    super(source);
    this.chatJid = chatJid;
    this.error = error;
    this.durationMs = durationMs;
  }
}
