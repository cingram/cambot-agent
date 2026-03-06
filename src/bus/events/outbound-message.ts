import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class OutboundMessage extends BusEvent {
  readonly jid: string;
  readonly text: string;
  readonly groupFolder?: string;
  readonly broadcast?: boolean;
  readonly agentId?: string;

  constructor(
    source: string,
    jid: string,
    text: string,
    opts?: { groupFolder?: string; broadcast?: boolean; agentId?: string } & EnvelopeOptions,
  ) {
    super('message.outbound', source, opts);
    this.jid = jid;
    this.text = text;
    this.groupFolder = opts?.groupFolder;
    this.broadcast = opts?.broadcast;
    this.agentId = opts?.agentId;
  }
}
