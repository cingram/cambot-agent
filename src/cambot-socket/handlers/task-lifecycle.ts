/**
 * task.pause / task.resume / task.cancel handlers.
 *
 * Authorization: main can manage any task; non-main can only manage
 * tasks belonging to their own group.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { getTaskById, updateTask, deleteTask } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const TaskIdSchema = z.object({
  taskId: z.string().min(1),
});

type TaskIdPayload = z.infer<typeof TaskIdSchema>;

/** Shared authorization check: main or own group. */
function authorizeTaskAccess(
  taskGroupFolder: string,
  sourceGroup: string,
  isMain: boolean,
): boolean {
  return isMain || taskGroupFolder === sourceGroup;
}

export function registerTaskLifecycle(registry: CommandRegistry): void {
  // ── task.pause ──────────────────────────────────────────
  registry.register(
    FRAME_TYPES.TASK_PAUSE,
    TaskIdSchema,
    'self-or-main',
    async (payload: TaskIdPayload, frame, connection) => {
      const { group: sourceGroup, isMain } = connection.identity;
      const task = getTaskById(payload.taskId);

      if (!task) {
        connection.replyError(frame, 'NOT_FOUND', `Task not found: ${payload.taskId}`);
        return;
      }

      if (!authorizeTaskAccess(task.group_folder, sourceGroup, isMain)) {
        logger.warn({ taskId: payload.taskId, sourceGroup }, 'Unauthorized task.pause attempt');
        connection.replyError(frame, 'UNAUTHORIZED', 'Cannot pause tasks from other groups');
        return;
      }

      updateTask(payload.taskId, { status: 'paused' });
      connection.reply(frame, FRAME_TYPES.TASK_PAUSE, { taskId: payload.taskId, status: 'paused' });
      logger.info({ taskId: payload.taskId, sourceGroup }, 'Task paused via socket');
    },
  );

  // ── task.resume ─────────────────────────────────────────
  registry.register(
    FRAME_TYPES.TASK_RESUME,
    TaskIdSchema,
    'self-or-main',
    async (payload: TaskIdPayload, frame, connection) => {
      const { group: sourceGroup, isMain } = connection.identity;
      const task = getTaskById(payload.taskId);

      if (!task) {
        connection.replyError(frame, 'NOT_FOUND', `Task not found: ${payload.taskId}`);
        return;
      }

      if (!authorizeTaskAccess(task.group_folder, sourceGroup, isMain)) {
        logger.warn({ taskId: payload.taskId, sourceGroup }, 'Unauthorized task.resume attempt');
        connection.replyError(frame, 'UNAUTHORIZED', 'Cannot resume tasks from other groups');
        return;
      }

      updateTask(payload.taskId, { status: 'active' });
      connection.reply(frame, FRAME_TYPES.TASK_RESUME, { taskId: payload.taskId, status: 'active' });
      logger.info({ taskId: payload.taskId, sourceGroup }, 'Task resumed via socket');
    },
  );

  // ── task.cancel ─────────────────────────────────────────
  registry.register(
    FRAME_TYPES.TASK_CANCEL,
    TaskIdSchema,
    'self-or-main',
    async (payload: TaskIdPayload, frame, connection) => {
      const { group: sourceGroup, isMain } = connection.identity;
      const task = getTaskById(payload.taskId);

      if (!task) {
        connection.replyError(frame, 'NOT_FOUND', `Task not found: ${payload.taskId}`);
        return;
      }

      if (!authorizeTaskAccess(task.group_folder, sourceGroup, isMain)) {
        logger.warn({ taskId: payload.taskId, sourceGroup }, 'Unauthorized task.cancel attempt');
        connection.replyError(frame, 'UNAUTHORIZED', 'Cannot cancel tasks from other groups');
        return;
      }

      deleteTask(payload.taskId);
      connection.reply(frame, FRAME_TYPES.TASK_CANCEL, { taskId: payload.taskId, status: 'deleted' });
      logger.info({ taskId: payload.taskId, sourceGroup }, 'Task cancelled via socket');
    },
  );
}
