/**
 * Integration and MCP server management handlers.
 *
 * integration.list / integration.enable / integration.disable
 * mcp.add / mcp.remove
 *
 * All are main-only operations.
 * Ported from the file-based integration IPC handlers.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import type { SocketFrame } from '../protocol/types.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';
import type { SocketDeps } from '../deps.js';
import type { CambotSocketConnection } from '../connection.js';

// ── Schemas ──────────────────────────────────────────────

const IntegrationListSchema = z.object({}).passthrough();

const IntegrationToggleSchema = z.object({
  integrationId: z.string().min(1),
});

const McpAddSchema = z.object({
  name: z.string().min(1),
  transport: z.enum(['http', 'sse', 'stdio']),
  url: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  envVars: z.array(z.string()).optional(),
  description: z.string().optional(),
  port: z.number().optional(),
});

const McpRemoveSchema = z.object({
  serverId: z.string().min(1),
});

type IntegrationTogglePayload = z.infer<typeof IntegrationToggleSchema>;
type McpAddPayload = z.infer<typeof McpAddSchema>;
type McpRemovePayload = z.infer<typeof McpRemoveSchema>;

// ── Helpers ──────────────────────────────────────────────

function requireIntegrationManager(
  deps: SocketDeps,
  frame: SocketFrame,
  connection: CambotSocketConnection,
): boolean {
  if (!deps.integrationManager) {
    connection.replyError(frame, 'NOT_AVAILABLE', 'Integration manager not initialized');
    return false;
  }
  return true;
}

// ── Registration ─────────────────────────────────────────

export function registerIntegrationAdmin(registry: CommandRegistry): void {
  // ── integration.list ────────────────────────────────────
  registry.register(
    FRAME_TYPES.INTEGRATION_LIST,
    IntegrationListSchema,
    'main-only',
    async (_payload, frame, connection, deps) => {
      if (!requireIntegrationManager(deps, frame, connection)) return;

      const integrations = deps.integrationManager!.list();
      const items = integrations.map((i) => ({
        id: i.id,
        status: i.status,
        enabled: i.enabled,
      }));

      connection.reply(frame, FRAME_TYPES.INTEGRATION_LIST, { integrations: items });
    },
  );

  // ── integration.enable ──────────────────────────────────
  registry.register(
    FRAME_TYPES.INTEGRATION_ENABLE,
    IntegrationToggleSchema,
    'main-only',
    async (payload: IntegrationTogglePayload, frame, connection, deps) => {
      if (!requireIntegrationManager(deps, frame, connection)) return;

      try {
        const info = await deps.integrationManager!.enable(payload.integrationId);
        connection.reply(frame, FRAME_TYPES.INTEGRATION_ENABLE, {
          status: 'enabled',
          id: payload.integrationId,
          integrationStatus: info.status,
        });
        logger.info(
          { id: payload.integrationId, status: info.status },
          'Integration enabled via socket',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ id: payload.integrationId, err }, 'Integration enable failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── integration.disable ─────────────────────────────────
  registry.register(
    FRAME_TYPES.INTEGRATION_DISABLE,
    IntegrationToggleSchema,
    'main-only',
    async (payload: IntegrationTogglePayload, frame, connection, deps) => {
      if (!requireIntegrationManager(deps, frame, connection)) return;

      try {
        const info = await deps.integrationManager!.disable(payload.integrationId);
        connection.reply(frame, FRAME_TYPES.INTEGRATION_DISABLE, {
          status: 'disabled',
          id: payload.integrationId,
          integrationStatus: info.status,
        });
        logger.info(
          { id: payload.integrationId, status: info.status },
          'Integration disabled via socket',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ id: payload.integrationId, err }, 'Integration disable failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── mcp.add ─────────────────────────────────────────────
  registry.register(
    FRAME_TYPES.MCP_ADD,
    McpAddSchema,
    'main-only',
    async (payload: McpAddPayload, frame, connection, deps) => {
      if (!requireIntegrationManager(deps, frame, connection)) return;

      try {
        const info = await deps.integrationManager!.addMcpServer({
          name: payload.name,
          transport: payload.transport,
          url: payload.url,
          command: payload.command,
          args: payload.args,
          envVars: payload.envVars,
          description: payload.description,
          port: payload.port,
        });

        connection.reply(frame, FRAME_TYPES.MCP_ADD, {
          status: 'added',
          id: info.id,
          name: payload.name,
        });
        logger.info({ id: info.id, name: payload.name }, 'MCP server added via socket');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ name: payload.name, err }, 'MCP server add failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── mcp.remove ──────────────────────────────────────────
  registry.register(
    FRAME_TYPES.MCP_REMOVE,
    McpRemoveSchema,
    'main-only',
    async (payload: McpRemovePayload, frame, connection, deps) => {
      if (!requireIntegrationManager(deps, frame, connection)) return;

      try {
        await deps.integrationManager!.removeMcpServer(payload.serverId);
        connection.reply(frame, FRAME_TYPES.MCP_REMOVE, {
          status: 'removed',
          id: payload.serverId,
        });
        logger.info({ id: payload.serverId }, 'MCP server removed via socket');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ id: payload.serverId, err }, 'MCP server remove failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );
}
