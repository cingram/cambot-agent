import { BusEvent } from '../bus-event.js';

export class TypingUpdate extends BusEvent {
  readonly jid: string;
  readonly isTyping: boolean;

  constructor(source: string, jid: string, isTyping: boolean) {
    super(source);
    this.jid = jid;
    this.isTyping = isTyping;
  }
}
