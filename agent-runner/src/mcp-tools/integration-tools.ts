/**
 * MCP tool registration: integrations and MCP server management.
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError, requestWithTimeout } from './helpers.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

export function registerIntegrationTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'list_integrations',
    'List all available integrations and their status for the current group.',
    {},
    async () => {
      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.INTEGRATION_LIST,
          id: uuid(),
          payload: { chatJid: ctx.chatJid },
        },
        10_000,
        'Integration list',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'enable_integration',
    'Enable an integration for the current group. Main group only.',
    {
      target_id: z.string().describe('The integration ID to enable'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can manage integrations.');

      ctx.client.send({
        type: FRAME_TYPES.INTEGRATION_ENABLE,
        id: uuid(),
        payload: { targetId: args.target_id },
      });

      return mcpText(`Integration ${args.target_id} enable requested.`);
    },
  );

  ctx.server.tool(
    'disable_integration',
    'Disable an integration for the current group. Main group only.',
    {
      target_id: z.string().describe('The integration ID to disable'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can manage integrations.');

      ctx.client.send({
        type: FRAME_TYPES.INTEGRATION_DISABLE,
        id: uuid(),
        payload: { targetId: args.target_id },
      });

      return mcpText(`Integration ${args.target_id} disable requested.`);
    },
  );

  ctx.server.tool(
    'add_mcp_server',
    'Add an MCP server to the group configuration. Main group only.',
    {
      name: z.string().describe('Server name'),
      transport: z.enum(['http', 'sse']).describe('Transport type'),
      url: z.string().describe('Server URL'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can manage MCP servers.');

      ctx.client.send({
        type: FRAME_TYPES.MCP_ADD,
        id: uuid(),
        payload: { name: args.name, transport: args.transport, url: args.url },
      });

      return mcpText(`MCP server "${args.name}" add requested.`);
    },
  );

  ctx.server.tool(
    'remove_mcp_server',
    'Remove an MCP server from the group configuration. Main group only.',
    {
      target_id: z.string().describe('The MCP server name/ID to remove'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can manage MCP servers.');

      ctx.client.send({
        type: FRAME_TYPES.MCP_REMOVE,
        id: uuid(),
        payload: { targetId: args.target_id },
      });

      return mcpText(`MCP server "${args.target_id}" remove requested.`);
    },
  );
}
