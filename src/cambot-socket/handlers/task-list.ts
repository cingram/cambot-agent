/**
 * task.list handler — returns scheduled tasks from the database.
 *
 * Main group: sees all tasks. Non-main: sees only own group's tasks.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { getAllTasks, getTasksForGroup } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const TaskListSchema = z.object({
  groupFolder: z.string().optional(),
  isMain: z.boolean().optional(),
});

export function registerTaskListHandler(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.TASK_LIST,
    TaskListSchema,
    'any',
    async (payload, frame, connection) => {
      const { group: sourceGroup, isMain: connIsMain } = connection.identity;
      const isMain = payload.isMain ?? connIsMain;

      try {
        const tasks = isMain
          ? getAllTasks()
          : getTasksForGroup(payload.groupFolder ?? sourceGroup);

        const lines = tasks.map((t) =>
          `[${t.id}] ${t.schedule_type}(${t.schedule_value}) status=${t.status} prompt="${t.prompt.slice(0, 80)}"`,
        );

        connection.reply(frame, FRAME_TYPES.TASK_LIST, {
          status: 'ok',
          result: tasks.length > 0
            ? `${tasks.length} task(s):\n${lines.join('\n')}`
            : 'No tasks found.',
        });

        logger.debug({ sourceGroup, count: tasks.length }, 'task.list processed');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'task.list failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );
}
