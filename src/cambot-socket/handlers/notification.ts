/**
 * notification.submit / notification.get / notification.ack handlers.
 *
 * Any agent can submit notifications. Only the main group can
 * read pending notifications or acknowledge them.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

// ── Schemas ──────────────────────────────────────────────

const SubmitSchema = z.object({
  category: z.string().min(1),
  priority: z.enum(['critical', 'high', 'normal', 'low', 'info']).optional(),
  summary: z.string().min(1),
  dedupKey: z.string().min(1).optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

const GetSchema = z.object({
  category: z.string().optional(),
  priority: z.enum(['critical', 'high', 'normal', 'low', 'info']).optional(),
  limit: z.number().optional(),
});

const AckSchema = z.object({
  ids: z.array(z.string().min(1)).min(1),
});

type SubmitPayload = z.infer<typeof SubmitSchema>;
type GetPayload = z.infer<typeof GetSchema>;
type AckPayload = z.infer<typeof AckSchema>;

// ── Registration ─────────────────────────────────────────

export function registerNotificationHandlers(registry: CommandRegistry): void {
  // ── notification.submit (any agent) ─────────────────────
  registry.register(
    FRAME_TYPES.NOTIFICATION_SUBMIT,
    SubmitSchema,
    'any',
    (payload: SubmitPayload, frame, connection, deps) => {
      if (!deps.notificationRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Notification service not configured');
        return;
      }

      const notification = deps.notificationRepo.insert({
        sourceAgent: connection.identity.group,
        category: payload.category,
        priority: payload.priority,
        summary: payload.summary,
        dedupKey: payload.dedupKey,
        payload: payload.payload,
      });

      logger.info(
        { id: notification.id, source: notification.sourceAgent, category: notification.category },
        'Notification submitted',
      );

      connection.reply(frame, FRAME_TYPES.NOTIFICATION_RESULT, {
        status: 'ok',
        result: JSON.stringify({ id: notification.id }),
      });
    },
  );

  // ── notification.get (main only) ────────────────────────
  registry.register(
    FRAME_TYPES.NOTIFICATION_GET,
    GetSchema,
    'main-only',
    (payload: GetPayload, frame, connection, deps) => {
      if (!deps.notificationRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Notification service not configured');
        return;
      }

      const notifications = deps.notificationRepo.getPending({
        category: payload.category,
        priority: payload.priority,
        limit: payload.limit,
      });

      connection.reply(frame, FRAME_TYPES.NOTIFICATION_RESULT, {
        status: 'ok',
        result: JSON.stringify(notifications),
      });
    },
  );

  // ── notification.ack (main only) ────────────────────────
  registry.register(
    FRAME_TYPES.NOTIFICATION_ACK,
    AckSchema,
    'main-only',
    (payload: AckPayload, frame, connection, deps) => {
      if (!deps.notificationRepo) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Notification service not configured');
        return;
      }

      const count = deps.notificationRepo.acknowledge(payload.ids, connection.identity.group);

      logger.info(
        { acknowledgedCount: count, by: connection.identity.group },
        'Notifications acknowledged',
      );

      connection.reply(frame, FRAME_TYPES.NOTIFICATION_RESULT, {
        status: 'ok',
        result: JSON.stringify({ acknowledged: count }),
      });
    },
  );
}
