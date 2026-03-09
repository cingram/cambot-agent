/**
 * MCP tool registration: task scheduling (schedule, list, pause, resume, cancel).
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError, requestWithTimeout } from './helpers.js';
import { validateScheduleValue } from './schedule-validation.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

export function registerTaskTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'schedule_task',
    `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT:
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am local time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour). Use for recurring tasks.
\u2022 once: Run once. Accepts either:
  - A relative offset: "+2m", "+30s", "+1h", "+90m" (minutes, seconds, hours). PREFERRED for "in X minutes" requests.
  - An absolute local timestamp: "2026-02-01T15:30:00" (interpreted as local timezone, auto-converted to UTC).
  Timestamps with "Z" or timezone offsets are also accepted.`,
    {
      prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
      schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time or after a delay'),
      schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: relative like "+2m", "+1h", "+30s" OR absolute like "2026-02-01T15:30:00"'),
      context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
      target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
    },
    async (args) => {
      const validation = validateScheduleValue(args.schedule_type, args.schedule_value);
      if (validation.error) return mcpError(validation.error);

      const resolvedValue = validation.resolvedValue ?? args.schedule_value;
      const targetJid = ctx.isMain && args.target_group_jid ? args.target_group_jid : ctx.chatJid;

      ctx.client.send({
        type: FRAME_TYPES.TASK_SCHEDULE,
        id: uuid(),
        payload: {
          prompt: args.prompt,
          scheduleType: args.schedule_type,
          scheduleValue: resolvedValue,
          contextMode: args.context_mode || 'group',
          targetJid,
          createdBy: ctx.groupFolder,
        },
      });

      const displayValue = args.schedule_type === 'once'
        ? new Date(resolvedValue).toLocaleString()
        : resolvedValue;

      return mcpText(`Task scheduled: ${args.schedule_type} - ${displayValue}`);
    },
  );

  ctx.server.tool(
    'list_tasks',
    "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
    {},
    async () => {
      const result = await requestWithTimeout(
        ctx.client,
        { type: FRAME_TYPES.TASK_LIST, id: uuid(), payload: { groupFolder: ctx.groupFolder, isMain: ctx.isMain } },
        10_000,
        'Task list',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'pause_task',
    'Pause a scheduled task. It will not run until resumed.',
    { task_id: z.string().describe('The task ID to pause') },
    async (args) => {
      ctx.client.send({
        type: FRAME_TYPES.TASK_PAUSE,
        id: uuid(),
        payload: { taskId: args.task_id, groupFolder: ctx.groupFolder, isMain: ctx.isMain },
      });
      return mcpText(`Task ${args.task_id} pause requested.`);
    },
  );

  ctx.server.tool(
    'resume_task',
    'Resume a paused task.',
    { task_id: z.string().describe('The task ID to resume') },
    async (args) => {
      ctx.client.send({
        type: FRAME_TYPES.TASK_RESUME,
        id: uuid(),
        payload: { taskId: args.task_id, groupFolder: ctx.groupFolder, isMain: ctx.isMain },
      });
      return mcpText(`Task ${args.task_id} resume requested.`);
    },
  );

  ctx.server.tool(
    'cancel_task',
    'Cancel and delete a scheduled task.',
    { task_id: z.string().describe('The task ID to cancel') },
    async (args) => {
      ctx.client.send({
        type: FRAME_TYPES.TASK_CANCEL,
        id: uuid(),
        payload: { taskId: args.task_id, groupFolder: ctx.groupFolder, isMain: ctx.isMain },
      });
      return mcpText(`Task ${args.task_id} cancellation requested.`);
    },
  );
}
