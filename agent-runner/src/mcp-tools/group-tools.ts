/**
 * MCP tool registration: group management (register, refresh, update).
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError } from './helpers.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

export function registerGroupTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'register_group',
    `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
    {
      jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
      name: z.string().describe('Display name for the group'),
      folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
      trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can register new groups.');

      ctx.client.send({
        type: FRAME_TYPES.GROUP_REGISTER,
        id: uuid(),
        payload: {
          jid: args.jid,
          name: args.name,
          folder: args.folder,
          trigger: args.trigger,
        },
      });

      return mcpText(`Group "${args.name}" registered. It will start receiving messages immediately.`);
    },
  );

  ctx.server.tool(
    'refresh_groups',
    'Refresh the group registry from the database. Use after registering or updating groups.',
    {},
    async () => {
      ctx.client.send({ type: FRAME_TYPES.GROUP_REFRESH, id: uuid(), payload: {} });
      return mcpText('Group refresh requested.');
    },
  );

  ctx.server.tool(
    'update_group',
    'Update settings for a registered group. Main group only.',
    {
      jid: z.string().describe('The group JID to update'),
      name: z.string().optional().describe('New display name'),
      trigger: z.string().optional().describe('New trigger pattern'),
      container_config: z.string().optional().describe('JSON string of container config (additionalMounts, etc.)'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can update groups.');

      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.trigger !== undefined) updates.trigger = args.trigger;
      if (args.container_config !== undefined) {
        try {
          updates.container_config = JSON.parse(args.container_config);
        } catch {
          return mcpError('Invalid container_config JSON.');
        }
      }

      ctx.client.send({
        type: FRAME_TYPES.GROUP_UPDATE,
        id: uuid(),
        payload: { jid: args.jid, updates },
      });

      return mcpText(`Group ${args.jid} update requested.`);
    },
  );
}
