import { BusEvent } from '../bus-event.js';

export class ChatMetadata extends BusEvent {
  readonly jid: string;
  readonly name?: string;
  readonly channel?: string;
  readonly isGroup?: boolean;

  constructor(
    source: string,
    jid: string,
    opts?: { name?: string; channel?: string; isGroup?: boolean },
  ) {
    super(source);
    this.jid = jid;
    this.name = opts?.name;
    this.channel = opts?.channel;
    this.isGroup = opts?.isGroup;
  }
}
