/**
 * message.outbound handler — send a message to a channel via the bus.
 *
 * Authorization: main can send anywhere; non-main can only send to their own JID.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { OutboundMessage } from '../../bus/index.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const MessageOutboundSchema = z.object({
  chatJid: z.string().min(1),
  text: z.string().min(1),
});

type MessageOutboundPayload = z.infer<typeof MessageOutboundSchema>;

export function registerMessageOutbound(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.MESSAGE_OUTBOUND,
    MessageOutboundSchema,
    'self-or-main',
    async (payload: MessageOutboundPayload, frame, connection, deps) => {
      const { group, isMain } = connection.identity;
      const registeredGroups = deps.registeredGroups();

      // Authorization: non-main groups can only send to their own JID
      const targetGroup = registeredGroups[payload.chatJid];
      if (!isMain && (!targetGroup || targetGroup.folder !== group)) {
        logger.warn(
          { chatJid: payload.chatJid, group },
          'Unauthorized message.outbound attempt blocked',
        );
        connection.replyError(frame, 'UNAUTHORIZED', 'Cannot send to this JID');
        return;
      }

      await deps.bus.emit(
        new OutboundMessage('ipc', payload.chatJid, payload.text, { groupFolder: group }),
      );

      connection.reply(frame, FRAME_TYPES.MESSAGE_OUTBOUND, { status: 'sent' });
      logger.info({ chatJid: payload.chatJid, group }, 'Message sent via socket');
    },
  );
}
