/**
 * registerAllHandlers — one-call registration of every command handler.
 */

import type { CommandRegistry } from './handlers/registry.js';
import { registerMessageOutbound } from './handlers/message-outbound.js';
import { registerTaskSchedule } from './handlers/task-schedule.js';
import { registerTaskLifecycle } from './handlers/task-lifecycle.js';
import { registerTaskListHandler } from './handlers/task-list.js';
import { registerGroupAdmin } from './handlers/group-admin.js';
import { registerGroupUpdate } from './handlers/group-update.js';
import { registerWorkerDelegate } from './handlers/worker-delegate.js';
import { registerAgentSend } from './handlers/agent-send.js';
import { registerAgentCrud } from './handlers/agent-crud.js';
import { registerWorkflowRuntime } from './handlers/workflow-runtime.js';
import { registerWorkflowBuilder } from './handlers/workflow-builder.js';
import { registerIntegrationAdmin } from './handlers/integration-admin.js';
import { registerEmailHandlers } from './handlers/email.js';
import { registerBusMessage } from './handlers/bus-message.js';
import { registerOutputHandler } from './handlers/output.js';
import { registerWorkflowQuery } from './handlers/workflow-query.js';

/** Register all cambot-socket command handlers with the given registry. */
export function registerAllHandlers(registry: CommandRegistry): void {
  registerMessageOutbound(registry);
  registerTaskSchedule(registry);
  registerTaskLifecycle(registry);
  registerTaskListHandler(registry);
  registerGroupAdmin(registry);
  registerGroupUpdate(registry);
  registerWorkerDelegate(registry);
  registerAgentSend(registry);
  registerAgentCrud(registry);
  registerWorkflowRuntime(registry);
  registerWorkflowBuilder(registry);
  registerWorkflowQuery(registry);
  registerIntegrationAdmin(registry);
  registerEmailHandlers(registry);
  registerBusMessage(registry);
  registerOutputHandler(registry);
}
