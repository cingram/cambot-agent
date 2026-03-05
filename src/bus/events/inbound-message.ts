import type { NewMessage } from '../../types.js';
import { BusEvent } from '../bus-event.js';

export class InboundMessage extends BusEvent {
  readonly jid: string;
  readonly message: NewMessage;
  readonly channel?: string;

  constructor(source: string, jid: string, message: NewMessage, channel?: string) {
    super(source);
    this.jid = jid;
    this.message = message;
    this.channel = channel;
  }
}
