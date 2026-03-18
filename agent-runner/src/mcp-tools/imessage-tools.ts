/**
 * MCP tool registration: iMessage rich capabilities.
 *
 * These tools are available to all agents but gracefully degrade — if the
 * iMessage provider doesn't support a capability, the tool returns an error
 * message instead of failing.
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { mcpText, mcpError } from './helpers.js';

export function registerImessageTools(ctx: McpToolContext): void {
  // ── send_attachment ──────────────────────────────────────────
  ctx.server.tool(
    'imessage_send_attachment',
    'Send a file (image, PDF, etc.) via iMessage. The file must exist at the given path inside your workspace.',
    {
      file_path: z.string().describe('Absolute path to the file to send'),
      chat_jid: z.string().optional().describe('Target chat JID (defaults to current chat). Example: "im:+1234567890"'),
      text: z.string().optional().describe('Optional text caption to include with the attachment'),
      mime_type: z.string().optional().describe('MIME type (e.g. "image/png"). Auto-detected if omitted.'),
      filename: z.string().optional().describe('Display filename. Defaults to the file basename.'),
    },
    async (args) => {
      try {
        const reply = await ctx.client.imessageSendAttachment(
          args.chat_jid || ctx.chatJid,
          args.file_path,
          { mimeType: args.mime_type, filename: args.filename, text: args.text },
        );
        const payload = reply.payload as { accepted?: boolean; error?: string };
        if (payload.error) return mcpError(payload.error);
        return mcpText('Attachment sent.');
      } catch (err) {
        return mcpError(`Failed to send attachment: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── send_reaction ────────────────────────────────────────────
  ctx.server.tool(
    'imessage_send_reaction',
    'Send a tapback reaction to an iMessage. Reactions: love, like, dislike, laugh, emphasize, question.',
    {
      message_id: z.string().describe('The message ID to react to (from an inbound message)'),
      reaction: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question']).describe('Tapback reaction type'),
      chat_jid: z.string().optional().describe('Target chat JID (defaults to current chat)'),
    },
    async (args) => {
      try {
        const reply = await ctx.client.imessageSendReaction(
          args.chat_jid || ctx.chatJid,
          args.message_id,
          args.reaction,
        );
        const payload = reply.payload as { accepted?: boolean; error?: string };
        if (payload.error) return mcpError(payload.error);
        return mcpText(`Reacted with ${args.reaction}.`);
      } catch (err) {
        return mcpError(`Failed to send reaction: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── remove_reaction ──────────────────────────────────────────
  ctx.server.tool(
    'imessage_remove_reaction',
    'Remove a previously sent tapback reaction from an iMessage.',
    {
      message_id: z.string().describe('The message ID to remove the reaction from'),
      reaction: z.enum(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question']).describe('Tapback reaction type to remove'),
      chat_jid: z.string().optional().describe('Target chat JID (defaults to current chat)'),
    },
    async (args) => {
      try {
        const reply = await ctx.client.imessageRemoveReaction(
          args.chat_jid || ctx.chatJid,
          args.message_id,
          args.reaction,
        );
        const payload = reply.payload as { accepted?: boolean; error?: string };
        if (payload.error) return mcpError(payload.error);
        return mcpText(`Removed ${args.reaction} reaction.`);
      } catch (err) {
        return mcpError(`Failed to remove reaction: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── mark_read ────────────────────────────────────────────────
  ctx.server.tool(
    'imessage_mark_read',
    'Mark an iMessage conversation as read (sends a read receipt to the sender).',
    {
      chat_jid: z.string().optional().describe('Target chat JID (defaults to current chat)'),
    },
    async (args) => {
      try {
        const reply = await ctx.client.imessageMarkRead(args.chat_jid || ctx.chatJid);
        const payload = reply.payload as { status?: string; error?: string };
        if (payload.error) return mcpError(payload.error);
        return mcpText('Conversation marked as read.');
      } catch (err) {
        return mcpError(`Failed to mark read: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  // ── get_capabilities ─────────────────────────────────────────
  ctx.server.tool(
    'imessage_capabilities',
    'Check which iMessage features are available (attachments, reactions, read receipts, typing). Use this before calling other imessage_ tools to verify support.',
    {},
    async () => {
      try {
        const reply = await ctx.client.imessageCapabilities();
        const caps = reply.payload as Record<string, boolean>;
        const lines = Object.entries(caps)
          .map(([k, v]) => `${k}: ${v ? 'yes' : 'no'}`)
          .join('\n');
        return mcpText(lines);
      } catch (err) {
        return mcpError(`Failed to check capabilities: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
