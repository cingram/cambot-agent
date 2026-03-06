import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class ChatMetadata extends BusEvent {
  readonly jid: string;
  readonly name?: string;
  readonly isGroup?: boolean;

  constructor(
    source: string,
    jid: string,
    opts?: { name?: string; channel?: string; isGroup?: boolean } & EnvelopeOptions,
  ) {
    super('chat.metadata', source, opts);
    this.jid = jid;
    this.name = opts?.name;
    this.isGroup = opts?.isGroup;
  }
}
