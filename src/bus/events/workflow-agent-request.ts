import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class WorkflowAgentRequest extends BusEvent {
  readonly agentId: string;
  readonly prompt: string;
  readonly runId: string;
  readonly stepId: string;

  constructor(
    source: string,
    opts: {
      agentId: string;
      prompt: string;
      runId: string;
      stepId: string;
    } & EnvelopeOptions,
  ) {
    super('workflow.agent.request', source, opts);
    this.agentId = opts.agentId;
    this.prompt = opts.prompt;
    this.runId = opts.runId;
    this.stepId = opts.stepId;
  }
}
