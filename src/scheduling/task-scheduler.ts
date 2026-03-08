import fs from 'fs';

import { CronExpressionParser } from 'cron-parser';

import {
  SCHEDULER_POLL_INTERVAL,
  TIMEZONE,
} from '../config/config.js';
import {
  getDueTasks,
  getTaskById,
} from '../db/index.js';
import type { GroupQueue } from '../groups/group-queue.js';
import { resolveGroupFolderPath } from '../groups/group-folder.js';
import { logger } from '../logger.js';
import type { MessageBus, ScheduledTask } from '../types.js';
import { TaskPrompt } from '../bus/index.js';
import { logTaskRun, updateTask } from '../db/index.js';

export interface SchedulerDependencies {
  queue: GroupQueue;
  messageBus: MessageBus;
}

/**
 * Emit a TaskPrompt event on the bus for a due task.
 * The TaskPromptHandler picks it up and routes to the appropriate agent.
 */
async function fireTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: 0,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder, agentId: task.agent_id },
    'Firing scheduled task',
  );

  await deps.messageBus.emit(
    new TaskPrompt('task-scheduler', task.id, task.chat_jid, task.prompt, task.group_folder, {
      contextMode: task.context_mode,
      agentId: task.agent_id,
    }),
  );
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(
          currentTask.chat_jid,
          currentTask.id,
          () => fireTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
