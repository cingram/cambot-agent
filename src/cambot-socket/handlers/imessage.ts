/**
 * iMessage rich capability handlers — attachment, reaction, read receipt, capabilities.
 *
 * These handlers find the iMessage channel via the integration manager,
 * access the underlying provider, and invoke the optional rich methods.
 * Returns errors gracefully if the provider doesn't support a capability.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the iMessage channel's provider from the integration manager.
 * Returns null if iMessage isn't configured.
 */
function getImessageProvider(deps: Parameters<Parameters<CommandRegistry['register']>[3]>[3]) {
  const channels = deps.integrationManager?.getActiveChannels() ?? [];
  const imChannel = channels.find((ch) => ch.name === 'imessage');
  if (!imChannel) return null;

  // IMessageChannel exposes getProvider() for rich access
  const getProvider = (imChannel as unknown as Record<string, unknown>).getProvider;
  if (typeof getProvider !== 'function') return null;

  return getProvider.call(imChannel) as Record<string, (...args: unknown[]) => unknown>;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const SendAttachmentSchema = z.object({
  requestId: z.string(),
  chatJid: z.string().min(1),
  filePath: z.string().min(1),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  text: z.string().optional(),
});

const SendReactionSchema = z.object({
  requestId: z.string(),
  chatJid: z.string().min(1),
  messageId: z.string().min(1),
  reaction: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question']),
});

const MarkReadSchema = z.object({
  requestId: z.string(),
  chatJid: z.string().min(1),
});

const GetAttachmentSchema = z.object({
  requestId: z.string(),
  attachmentId: z.string().min(1),
});

const CapabilitiesSchema = z.object({
  requestId: z.string(),
});

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerImessageHandlers(registry: CommandRegistry): void {
  // ── send_attachment ──────────────────────────────────────────
  registry.register(
    FRAME_TYPES.IMESSAGE_SEND_ATTACHMENT,
    SendAttachmentSchema,
    'self-or-main',
    async (payload, frame, connection, deps) => {
      const provider = getImessageProvider(deps);
      if (!provider?.sendAttachment) {
        connection.replyError(frame, 'UNSUPPORTED', 'iMessage provider does not support attachments');
        return;
      }

      const recipientId = payload.chatJid.replace(/^im:/, '');
      const result = await (provider.sendAttachment as Function)(
        recipientId,
        { filePath: payload.filePath, mimeType: payload.mimeType, filename: payload.filename },
        payload.text,
      );

      connection.reply(frame, FRAME_TYPES.IMESSAGE_RESULT, result);
      logger.info({ chatJid: payload.chatJid }, 'iMessage attachment sent via socket');
    },
  );

  // ── send_reaction ────────────────────────────────────────────
  registry.register(
    FRAME_TYPES.IMESSAGE_SEND_REACTION,
    SendReactionSchema,
    'self-or-main',
    async (payload, frame, connection, deps) => {
      const provider = getImessageProvider(deps);
      if (!provider?.sendReaction) {
        connection.replyError(frame, 'UNSUPPORTED', 'iMessage provider does not support reactions');
        return;
      }

      const recipientId = payload.chatJid.replace(/^im:/, '');
      const result = await (provider.sendReaction as Function)(recipientId, payload.messageId, payload.reaction);

      connection.reply(frame, FRAME_TYPES.IMESSAGE_RESULT, result);
      logger.info({ chatJid: payload.chatJid, reaction: payload.reaction }, 'iMessage reaction sent via socket');
    },
  );

  // ── remove_reaction ──────────────────────────────────────────
  registry.register(
    FRAME_TYPES.IMESSAGE_REMOVE_REACTION,
    SendReactionSchema,
    'self-or-main',
    async (payload, frame, connection, deps) => {
      const provider = getImessageProvider(deps);
      if (!provider?.removeReaction) {
        connection.replyError(frame, 'UNSUPPORTED', 'iMessage provider does not support reactions');
        return;
      }

      const recipientId = payload.chatJid.replace(/^im:/, '');
      const result = await (provider.removeReaction as Function)(recipientId, payload.messageId, payload.reaction);

      connection.reply(frame, FRAME_TYPES.IMESSAGE_RESULT, result);
      logger.info({ chatJid: payload.chatJid, reaction: payload.reaction }, 'iMessage reaction removed via socket');
    },
  );

  // ── mark_read ────────────────────────────────────────────────
  registry.register(
    FRAME_TYPES.IMESSAGE_MARK_READ,
    MarkReadSchema,
    'self-or-main',
    async (payload, frame, connection, deps) => {
      const provider = getImessageProvider(deps);
      if (!provider?.markRead) {
        connection.replyError(frame, 'UNSUPPORTED', 'iMessage provider does not support read receipts');
        return;
      }

      const recipientId = payload.chatJid.replace(/^im:/, '');
      await (provider.markRead as Function)(recipientId);

      connection.reply(frame, FRAME_TYPES.IMESSAGE_RESULT, { status: 'ok' });
      logger.info({ chatJid: payload.chatJid }, 'iMessage marked read via socket');
    },
  );

  // ── get_attachment ───────────────────────────────────────────
  registry.register(
    FRAME_TYPES.IMESSAGE_GET_ATTACHMENT,
    GetAttachmentSchema,
    'self-or-main',
    async (payload, frame, connection, deps) => {
      const provider = getImessageProvider(deps);
      if (!provider?.getAttachment) {
        connection.replyError(frame, 'UNSUPPORTED', 'iMessage provider does not support attachment downloads');
        return;
      }

      const result = await (provider.getAttachment as Function)(payload.attachmentId);
      if (!result) {
        connection.replyError(frame, 'NOT_FOUND', 'Attachment not found');
        return;
      }

      // Send binary data as base64 to avoid binary framing issues
      connection.reply(frame, FRAME_TYPES.IMESSAGE_RESULT, {
        data: (result.data as Buffer).toString('base64'),
        mimeType: result.mimeType,
        filename: result.filename,
      });
      logger.info({ attachmentId: payload.attachmentId }, 'iMessage attachment fetched via socket');
    },
  );

  // ── capabilities ─────────────────────────────────────────────
  registry.register(
    FRAME_TYPES.IMESSAGE_CAPABILITIES,
    CapabilitiesSchema,
    'any',
    async (_payload, frame, connection, deps) => {
      const provider = getImessageProvider(deps);
      if (!provider) {
        connection.reply(frame, FRAME_TYPES.IMESSAGE_RESULT, {
          configured: false,
          attachments: false,
          reactions: false,
          readReceipts: false,
          typing: false,
        });
        return;
      }

      const caps = typeof provider.capabilities === 'function'
        ? (provider.capabilities as Function)()
        : { attachments: false, reactions: false, readReceipts: false, typing: false };

      connection.reply(frame, FRAME_TYPES.IMESSAGE_RESULT, { configured: true, ...caps });
    },
  );
}
