/**
 * MCP tool registration: admin inbox notifications.
 *
 * - submit_notification: available to all agents
 * - get_notifications: main group only
 * - acknowledge_notifications: main group only
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError, requestWithTimeout } from './helpers.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

export function registerNotificationTools(ctx: McpToolContext): void {
  // ── submit_notification (all agents) ─────────────────────
  ctx.server.tool(
    'submit_notification',
    'Submit a notification to the admin inbox. Any agent can call this. '
    + 'Use for reporting events, alerts, or status updates that the admin '
    + 'assistant should review.\n\n'
    + 'Priority classification guide:\n'
    + '- critical: Requires immediate action — security alerts, payment failures, service outages, account lockouts\n'
    + '- high: Needs attention today — urgent emails from known contacts, approaching deadlines, failed workflows\n'
    + '- normal: Standard items to review — regular correspondence, routine reports, non-urgent requests\n'
    + '- low: No rush — informational updates, newsletters worth reading, low-priority follow-ups\n'
    + '- info: FYI only — automated confirmations, read receipts, bulk notifications, can be batched\n\n'
    + 'Always include a clear summary and use the payload field for structured details (sender, subject, counts, etc.).',
    {
      category: z.string().describe(
        'Notification category. Use a consistent slug: '
        + '"email-priority", "email-newsletter", "workflow-failure", "monitoring-alert", "calendar-event"',
      ),
      summary: z.string().describe(
        'Human-readable summary. Lead with the count or key fact, e.g. '
        + '"3 urgent emails from John about Q1 budget" or "Backup workflow failed: disk full"',
      ),
      priority: z.enum(['critical', 'high', 'normal', 'low', 'info'])
        .default('normal')
        .describe(
          'Priority level — classify using the guide above. '
          + 'When unsure, prefer normal over high. Default: normal',
        ),
      payload: z.record(z.string(), z.unknown()).optional().describe(
        'Structured data for the admin assistant to act on. '
        + 'For emails include: sender, subject, threadId, labels. '
        + 'For failures include: error, component, timestamp.',
      ),
    },
    async (args) => {
      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.NOTIFICATION_SUBMIT,
          id: uuid(),
          payload: {
            category: args.category,
            summary: args.summary,
            priority: args.priority,
            payload: args.payload,
          },
        },
        30_000,
        'Notification submit',
      );
      if (result.isError) return mcpError(`Notification submit error: ${result.text}`);
      return mcpText(result.text);
    },
  );

  // ── get_notifications (main only) ────────────────────────
  if (ctx.isMain) {
    ctx.server.tool(
      'get_notifications',
      'Read pending notifications from the admin inbox. '
      + 'Returns items sorted by priority (critical first) then age (oldest first). '
      + 'Use to sweep and consolidate reports for the admin.',
      {
        category: z.string().optional().describe('Filter by category'),
        priority: z.enum(['critical', 'high', 'normal', 'low', 'info'])
          .optional()
          .describe('Filter by priority'),
        limit: z.number().default(50).describe('Max items to return (default 50)'),
      },
      async (args) => {
        const result = await requestWithTimeout(
          ctx.client,
          {
            type: FRAME_TYPES.NOTIFICATION_GET,
            id: uuid(),
            payload: {
              category: args.category,
              priority: args.priority,
              limit: args.limit,
            },
          },
          30_000,
          'Notification get',
        );
        if (result.isError) return mcpError(`Notification get error: ${result.text}`);
        return mcpText(result.text);
      },
    );

    // ── acknowledge_notifications (main only) ──────────────
    ctx.server.tool(
      'acknowledge_notifications',
      'Mark notifications as handled. Pass the IDs from get_notifications results. '
      + 'Acknowledged notifications will no longer appear in pending queries.',
      {
        ids: z.array(z.string()).min(1).describe('Notification IDs to acknowledge'),
      },
      async (args) => {
        const result = await requestWithTimeout(
          ctx.client,
          {
            type: FRAME_TYPES.NOTIFICATION_ACK,
            id: uuid(),
            payload: { ids: args.ids },
          },
          30_000,
          'Notification acknowledge',
        );
        if (result.isError) return mcpError(`Notification acknowledge error: ${result.text}`);
        return mcpText(result.text);
      },
    );
  }
}
