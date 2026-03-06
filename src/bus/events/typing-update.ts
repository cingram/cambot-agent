import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class TypingUpdate extends BusEvent {
  readonly jid: string;
  readonly isTyping: boolean;

  constructor(source: string, jid: string, isTyping: boolean, envelope?: EnvelopeOptions) {
    super('typing.update', source, envelope);
    this.jid = jid;
    this.isTyping = isTyping;
  }
}
