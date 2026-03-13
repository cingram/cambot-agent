/**
 * message.outbound handler — send a message to a channel via the bus.
 *
 * Authorization: main can send anywhere; non-main can only send to their own JID.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { OutboundMessage } from '../../bus/index.js';
import { logger } from '../../logger.js';
import { channelFromJid } from '../../utils/channel-from-jid.js';
import type { RegisteredGroup } from '../../types.js';
import type { CommandRegistry } from './registry.js';

const MessageOutboundSchema = z.object({
  chatJid: z.string().min(1),
  text: z.string().min(1),
  channel: z.string().optional(),
});

type MessageOutboundPayload = z.infer<typeof MessageOutboundSchema>;

/**
 * Resolve a channel name (e.g. "imessage") to the first matching registered group JID.
 */
function resolveChannelToJid(
  channel: string,
  registeredGroups: Record<string, RegisteredGroup>,
): string | null {
  const normalized = channel.toLowerCase();
  for (const jid of Object.keys(registeredGroups)) {
    if (channelFromJid(jid) === normalized) return jid;
  }
  return null;
}

export function registerMessageOutbound(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.MESSAGE_OUTBOUND,
    MessageOutboundSchema,
    'self-or-main',
    async (payload: MessageOutboundPayload, frame, connection, deps) => {
      const { group, isMain } = connection.identity;
      const registeredGroups = deps.registeredGroups();

      // Resolve channel name to JID if provided
      let chatJid = payload.chatJid;
      if (payload.channel) {
        const resolved = resolveChannelToJid(payload.channel, registeredGroups);
        if (!resolved) {
          logger.warn(
            { channel: payload.channel, group },
            'No registered group found for channel',
          );
          connection.replyError(frame, 'NOT_FOUND', `No registered group for channel "${payload.channel}"`);
          return;
        }
        chatJid = resolved;
        logger.info({ channel: payload.channel, resolvedJid: chatJid }, 'Resolved channel to JID');
      }

      // Authorization: non-main groups can only send to their own JID
      // or to JIDs explicitly authorized at spawn time (e.g. gateway delegation).
      const targetGroup = registeredGroups[chatJid];
      const ownsTarget = targetGroup && targetGroup.folder === group;
      const spawnAuthorized = connection.identity.authorizedJids?.has(chatJid);
      if (!isMain && !ownsTarget && !spawnAuthorized) {
        logger.warn(
          { chatJid, group },
          'Unauthorized message.outbound attempt blocked',
        );
        connection.replyError(frame, 'UNAUTHORIZED', 'Cannot send to this JID');
        return;
      }

      await deps.bus.emit(
        new OutboundMessage('ipc', chatJid, payload.text, { groupFolder: group }),
      );

      connection.reply(frame, FRAME_TYPES.MESSAGE_OUTBOUND, { status: 'sent' });
      logger.info({ chatJid, group }, 'Message sent via socket');
    },
  );
}
