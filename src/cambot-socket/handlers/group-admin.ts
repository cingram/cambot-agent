/**
 * group.refresh / group.register handlers — group administration.
 *
 * group.refresh: triggers metadata sync and returns updated group snapshot.
 * group.register: creates or updates a registered group entry.
 *
 * Both are main-only operations.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { isValidGroupFolder } from '../../groups/group-folder.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

// ── group.refresh ────────────────────────────────────────

const GroupRefreshSchema = z.object({}).passthrough();

export function registerGroupRefresh(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.GROUP_REFRESH,
    GroupRefreshSchema,
    'main-only',
    async (_payload, frame, connection, deps) => {
      const { group: sourceGroup } = connection.identity;

      logger.info({ sourceGroup }, 'Group metadata refresh requested via socket');
      await deps.syncGroupMetadata(true);

      const availableGroups = deps.getAvailableGroups();
      const registeredGroups = deps.registeredGroups();

      deps.writeGroupsSnapshot(
        sourceGroup,
        true,
        availableGroups,
        new Set(Object.keys(registeredGroups)),
      );

      connection.reply(frame, FRAME_TYPES.GROUP_REFRESH, {
        status: 'refreshed',
        groupCount: availableGroups.length,
      });
    },
  );
}

// ── group.register ───────────────────────────────────────

const AdditionalMountSchema = z.object({
  hostPath: z.string(),
  containerPath: z.string().optional(),
  readonly: z.boolean().optional(),
});

const ContainerConfigSchema = z.object({
  additionalMounts: z.array(AdditionalMountSchema).optional(),
  timeout: z.number().optional(),
}).optional();

const GroupRegisterSchema = z.object({
  jid: z.string().min(1),
  name: z.string().min(1),
  folder: z.string().min(1),
  trigger: z.string().min(1),
  requiresTrigger: z.boolean().optional(),
  containerConfig: ContainerConfigSchema,
});

type GroupRegisterPayload = z.infer<typeof GroupRegisterSchema>;

export function registerGroupRegister(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.GROUP_REGISTER,
    GroupRegisterSchema,
    'main-only',
    async (payload: GroupRegisterPayload, frame, connection, deps) => {
      if (!isValidGroupFolder(payload.folder)) {
        logger.warn(
          { folder: payload.folder },
          'Invalid group.register request — unsafe folder name',
        );
        connection.replyError(frame, 'VALIDATION_ERROR', `Invalid folder name: ${payload.folder}`);
        return;
      }

      deps.registerGroup(payload.jid, {
        name: payload.name,
        folder: payload.folder,
        trigger: payload.trigger,
        added_at: new Date().toISOString(),
        containerConfig: payload.containerConfig,
        requiresTrigger: payload.requiresTrigger,
      });

      connection.reply(frame, FRAME_TYPES.GROUP_REGISTER, {
        status: 'registered',
        jid: payload.jid,
        folder: payload.folder,
      });

      logger.info(
        { jid: payload.jid, folder: payload.folder },
        'Group registered via socket',
      );
    },
  );
}

/** Register both group admin handlers at once. */
export function registerGroupAdmin(registry: CommandRegistry): void {
  registerGroupRefresh(registry);
  registerGroupRegister(registry);
}
