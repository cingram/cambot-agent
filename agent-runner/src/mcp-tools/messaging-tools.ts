/**
 * MCP tool registration: send_message.
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { mcpText } from './helpers.js';

export function registerMessagingTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'send_message',
    "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
    {
      text: z.string().describe('The message text to send'),
      sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
      channel: z.string().optional().describe(
        'Channel name for cross-channel messaging (main group only). '
        + 'The host resolves this to the correct JID automatically. '
        + 'Examples: "imessage", "telegram", "web", "whatsapp", "discord", "email"',
      ),
      target_jid: z.string().optional().describe(
        'Target chat JID for cross-channel messaging (main group only). '
        + 'Prefer using "channel" instead — it resolves the JID for you. '
        + 'Defaults to current chat. Examples: "im:+1234567890", "web:ui", "tg:12345"',
      ),
    },
    async (args) => {
      ctx.client.sendMessage(
        args.target_jid || ctx.chatJid,
        args.text,
        { sender: args.sender, channel: args.channel },
      );
      return mcpText('Message sent.');
    },
  );
}
