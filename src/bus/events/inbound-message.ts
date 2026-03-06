import type { NewMessage } from '../../types.js';
import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class InboundMessage extends BusEvent {
  readonly jid: string;
  readonly message: NewMessage;

  constructor(
    source: string,
    jid: string,
    message: NewMessage,
    opts?: { channel?: string } & EnvelopeOptions,
  ) {
    super('message.inbound', source, opts);
    this.jid = jid;
    this.message = message;
  }
}
