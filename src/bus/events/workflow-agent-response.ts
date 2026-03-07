import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export interface ModelUsageEntry {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class WorkflowAgentResponse extends BusEvent {
  readonly status: 'success' | 'error';
  readonly text: string;
  readonly runId: string;
  readonly stepId: string;
  readonly durationMs: number;
  readonly totalCostUsd?: number;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly modelUsage?: Record<string, ModelUsageEntry>;

  constructor(
    source: string,
    opts: {
      status: 'success' | 'error';
      text: string;
      runId: string;
      stepId: string;
      durationMs: number;
      totalCostUsd?: number;
      tokensIn?: number;
      tokensOut?: number;
      modelUsage?: Record<string, ModelUsageEntry>;
    } & EnvelopeOptions,
  ) {
    super('workflow.agent.response', source, opts);
    this.status = opts.status;
    this.text = opts.text;
    this.runId = opts.runId;
    this.stepId = opts.stepId;
    this.durationMs = opts.durationMs;
    this.totalCostUsd = opts.totalCostUsd;
    this.tokensIn = opts.tokensIn;
    this.tokensOut = opts.tokensOut;
    this.modelUsage = opts.modelUsage;
  }
}
