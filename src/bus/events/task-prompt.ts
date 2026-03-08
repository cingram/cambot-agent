import type { EnvelopeOptions } from '../envelope.js';
import { BusEvent } from '../bus-event.js';

export class TaskPrompt extends BusEvent {
  readonly taskId: string;
  readonly jid: string;
  readonly prompt: string;
  readonly groupFolder: string;
  readonly contextMode: 'group' | 'isolated';
  readonly agentId: string | null;

  constructor(
    source: string,
    taskId: string,
    jid: string,
    prompt: string,
    groupFolder: string,
    opts?: {
      contextMode?: 'group' | 'isolated';
      agentId?: string | null;
    } & EnvelopeOptions,
  ) {
    super('task.prompt', source, opts);
    this.taskId = taskId;
    this.jid = jid;
    this.prompt = prompt;
    this.groupFolder = groupFolder;
    this.contextMode = opts?.contextMode ?? 'isolated';
    this.agentId = opts?.agentId ?? null;
  }
}
