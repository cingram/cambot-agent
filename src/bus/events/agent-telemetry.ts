import { BusEvent } from '../bus-event.js';

export class AgentTelemetry extends BusEvent {
  readonly chatJid: string;
  readonly durationMs: number;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly totalCostUsd?: number;

  constructor(
    source: string,
    chatJid: string,
    opts: {
      durationMs: number;
      inputTokens?: number;
      outputTokens?: number;
      totalCostUsd?: number;
    },
  ) {
    super(source);
    this.chatJid = chatJid;
    this.durationMs = opts.durationMs;
    this.inputTokens = opts.inputTokens;
    this.outputTokens = opts.outputTokens;
    this.totalCostUsd = opts.totalCostUsd;
  }
}
