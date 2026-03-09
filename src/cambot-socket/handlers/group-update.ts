/**
 * group.update handler — update settings for a registered group.
 *
 * Main-only operation. Updates the group in the database and refreshes
 * the in-memory registry.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { getRegisteredGroup, setRegisteredGroup } from '../../db/index.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const GroupUpdateSchema = z.object({
  jid: z.string().min(1),
  updates: z.object({}).passthrough(),
});

type GroupUpdatePayload = z.infer<typeof GroupUpdateSchema>;

export function registerGroupUpdate(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.GROUP_UPDATE,
    GroupUpdateSchema,
    'main-only',
    async (payload: GroupUpdatePayload, frame, connection, deps) => {
      try {
        const existing = getRegisteredGroup(payload.jid);
        if (!existing) {
          connection.replyError(frame, 'NOT_FOUND', `Group "${payload.jid}" not found`);
          return;
        }

        const updates = payload.updates as Record<string, unknown>;
        const updated = {
          name: (updates.name as string) ?? existing.name,
          folder: existing.folder,
          trigger: (updates.trigger as string) ?? existing.trigger,
          added_at: existing.added_at,
          containerConfig: updates.container_config !== undefined
            ? updates.container_config as Record<string, unknown>
            : existing.containerConfig,
          requiresTrigger: existing.requiresTrigger,
        };

        setRegisteredGroup(payload.jid, updated);

        // Refresh the in-memory registry
        deps.registerGroup(payload.jid, updated);

        connection.reply(frame, FRAME_TYPES.GROUP_UPDATE, {
          status: 'ok',
          jid: payload.jid,
        });

        logger.info({ jid: payload.jid }, 'Group updated via socket');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ jid: payload.jid, err }, 'group.update failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );
}
