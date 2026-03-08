/**
 * task.schedule handler — create a scheduled task in the database.
 *
 * Validates cron/interval/once schedule expressions, resolves the target
 * group from JID, and enforces authorization (non-main can only schedule
 * for their own group).
 */

import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';

import { FRAME_TYPES } from '../protocol/types.js';
import { TIMEZONE } from '../../config/config.js';
import { createTask } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const TaskScheduleSchema = z.object({
  prompt: z.string().min(1),
  scheduleType: z.enum(['cron', 'interval', 'once']),
  scheduleValue: z.string().min(1),
  targetJid: z.string().min(1),
  contextMode: z.enum(['group', 'isolated']).optional().default('isolated'),
  agentId: z.string().optional(),
  chatJid: z.string().optional(),
});

type TaskSchedulePayload = z.infer<typeof TaskScheduleSchema>;

/** Compute the next run time from a schedule spec. Returns null on invalid input. */
function computeNextRun(
  scheduleType: 'cron' | 'interval' | 'once',
  scheduleValue: string,
): { nextRun: string | null; error?: string } {
  switch (scheduleType) {
    case 'cron': {
      try {
        const interval = CronExpressionParser.parse(scheduleValue, { tz: TIMEZONE });
        return { nextRun: interval.next().toISOString() };
      } catch {
        return { nextRun: null, error: `Invalid cron expression: ${scheduleValue}` };
      }
    }
    case 'interval': {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms) || ms <= 0) {
        return { nextRun: null, error: `Invalid interval: ${scheduleValue}` };
      }
      return { nextRun: new Date(Date.now() + ms).toISOString() };
    }
    case 'once': {
      const relMatch = scheduleValue.match(/^\+(\d+)(s|m|h)$/);
      if (relMatch) {
        const amount = parseInt(relMatch[1], 10);
        const unit = relMatch[2];
        const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
        return { nextRun: new Date(Date.now() + amount * multiplier).toISOString() };
      }

      let value = scheduleValue;
      if (!/[Zz]$/.test(value) && !/[+-]\d{2}:\d{2}$/.test(value)) {
        value += 'Z';
      }
      const scheduled = new Date(value);
      if (isNaN(scheduled.getTime())) {
        return { nextRun: null, error: `Invalid timestamp: ${scheduleValue}` };
      }
      return { nextRun: scheduled.toISOString() };
    }
  }
}

export function registerTaskSchedule(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.TASK_SCHEDULE,
    TaskScheduleSchema,
    'self-or-main',
    async (payload: TaskSchedulePayload, frame, connection, deps) => {
      const { group: sourceGroup, isMain } = connection.identity;
      const registeredGroups = deps.registeredGroups();

      // Resolve target group from JID
      const targetGroupEntry = registeredGroups[payload.targetJid];
      if (!targetGroupEntry) {
        connection.replyError(frame, 'NOT_FOUND', 'Target group not registered');
        return;
      }

      const targetFolder = targetGroupEntry.folder;

      // Authorization: non-main can only schedule for own group
      if (!isMain && targetFolder !== sourceGroup) {
        logger.warn(
          { sourceGroup, targetFolder },
          'Unauthorized task.schedule attempt blocked',
        );
        connection.replyError(frame, 'UNAUTHORIZED', 'Cannot schedule tasks for other groups');
        return;
      }

      // Compute next run time
      const { nextRun, error } = computeNextRun(payload.scheduleType, payload.scheduleValue);
      if (error) {
        connection.replyError(frame, 'VALIDATION_ERROR', error);
        return;
      }

      const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      createTask({
        id: taskId,
        group_folder: targetFolder,
        chat_jid: payload.targetJid,
        prompt: payload.prompt,
        schedule_type: payload.scheduleType,
        schedule_value: payload.scheduleValue,
        context_mode: payload.contextMode,
        agent_id: payload.agentId || null,
        next_run: nextRun,
        status: 'active',
        created_at: new Date().toISOString(),
      });

      connection.reply(frame, FRAME_TYPES.TASK_SCHEDULE, { taskId, nextRun });
      logger.info(
        { taskId, sourceGroup, targetFolder, contextMode: payload.contextMode },
        'Task created via socket',
      );
    },
  );
}
