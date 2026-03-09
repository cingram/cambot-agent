/**
 * Default Task Pipeline — Runs a task through the standard container agent.
 *
 * Extracted from the old task-scheduler runTask() to serve as the fallback
 * when a task has no agent_id. Called by TaskPromptHandler.
 */
import { ChildProcess } from 'child_process';

import { MAIN_GROUP_FOLDER } from '../config/config.js';
import { getLeadAgentId, resolveAgentImage } from '../agents/agents.js';
import { ContainerOutput, runContainerAgent } from '../container/runner.js';
import { writeTasksSnapshot } from '../container/snapshot-writers.js';
import { getAllTasks } from '../db/index.js';
import type { GroupQueue } from '../groups/group-queue.js';
import { logger } from '../logger.js';
import { formatOutbound } from '../utils/router.js';
import type { MessageBus, RegisteredGroup, ScheduledTask } from '../types.js';
import { toExecutionContext } from '../types.js';
import { OutboundMessage } from '../bus/index.js';
import { resolveToolList } from '../tools/tool-policy.js';
import { getActiveConversation } from '../db/conversation-repository.js';
import type { DefaultPipelineResult } from './task-prompt-handler.js';
import type { IntegrationManager } from '../integrations/index.js';
import type { CambotSocketServer } from '../cambot-socket/server.js';

export interface DefaultPipelineDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  messageBus: MessageBus;
  getIntegrationManager: () => IntegrationManager | null;
  getSocketServer?: () => CambotSocketServer | undefined;
}

export async function runDefaultTaskPipeline(
  task: ScheduledTask,
  deps: DefaultPipelineDeps,
): Promise<DefaultPipelineResult> {
  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    const error = `Group not found: ${task.group_folder}`;
    logger.error({ taskId: task.id, groupFolder: task.group_folder }, 'Group not found for task');
    return { result: null, error };
  }

  const isMain = task.group_folder === MAIN_GROUP_FOLDER;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
      agentId: t.agent_id,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  const activeConvo = task.context_mode === 'group'
    ? getActiveConversation(task.group_folder)
    : undefined;
  const sessionId = activeConvo?.sessionId ?? undefined;

  try {
    const agentOpts = resolveAgentImage(getLeadAgentId());

    const output = await runContainerAgent(
      toExecutionContext(group, isMain),
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        allowedSdkTools: resolveToolList(group?.containerConfig?.toolPolicy),
        mcpServers: deps.getIntegrationManager()?.getActiveMcpServers(),
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          result = streamedOutput.result;
          const text = formatOutbound(streamedOutput.result);
          if (text) {
            await deps.messageBus.emit(new OutboundMessage('task', task.chat_jid, text, { broadcast: true, groupFolder: task.group_folder }));
          }
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
      agentOpts,
      deps.getSocketServer?.(),
    );

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      result = output.result;
    }

    logger.info(
      { taskId: task.id },
      'Default task pipeline completed',
    );
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Default task pipeline failed');
  }

  return { result, error };
}
