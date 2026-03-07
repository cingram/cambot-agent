import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class WorkflowTrigger extends BusEvent {
  readonly workflowId: string;
  readonly params?: Record<string, unknown>;

  constructor(
    source: string,
    workflowId: string,
    opts?: { params?: Record<string, unknown> } & EnvelopeOptions,
  ) {
    super('workflow.trigger', source, opts);
    this.workflowId = workflowId;
    this.params = opts?.params;
  }
}
