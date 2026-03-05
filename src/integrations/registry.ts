/**
 * Integration Registry — Converts channel definitions and MCP configs into
 * IntegrationDefinition objects that the integration manager can lifecycle.
 */

import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from 'cambot-integrations';

import { STORE_DIR, WORKSPACE_MCP_PORT } from '../config/config.js';
import { channelDefinitions } from '../channels/registry.js';
import { readEnvFile } from '../config/env.js';
import { createWorkspaceMcpService, type WorkspaceMcpService } from '../utils/workspace-mcp-service.js';
import type { IntegrationDefinition, IntegrationContext, IntegrationHandle } from './types.js';

/** Build the built-in integration definitions from channels + known MCP servers. */
export function buildIntegrationDefinitions(): IntegrationDefinition[] {
  const defs: IntegrationDefinition[] = [];

  // Wrap each channel definition
  for (const chDef of channelDefinitions) {
    defs.push({
      id: `channel:${chDef.name}`,
      name: chDef.name,
      type: 'channel',
      description: `${chDef.name} messaging channel`,
      builtIn: true,
      requirements: buildChannelRequirements(chDef.name),
      isConfigured: chDef.isConfigured,
      start: async (ctx: IntegrationContext) => {
        const channel = await chDef.create(ctx.channelOpts);
        await channel.connect();
        return { stop: () => channel.disconnect(), channel };
      },
    });
  }

  // Google Workspace MCP server
  defs.push(buildGoogleWorkspaceDef());

  return defs;
}

function buildChannelRequirements(name: string): IntegrationDefinition['requirements'] {
  switch (name) {
    case 'whatsapp':
      return [{ name: 'WhatsApp auth creds', check: () => fs.existsSync(path.join(STORE_DIR, 'auth', 'creds.json')) }];
    case 'email':
      return [
        { name: 'GOOGLE_OAUTH_CLIENT_ID', check: () => !!readEnvFile(['GOOGLE_OAUTH_CLIENT_ID']).GOOGLE_OAUTH_CLIENT_ID },
        { name: 'GOOGLE_OAUTH_CLIENT_SECRET', check: () => !!readEnvFile(['GOOGLE_OAUTH_CLIENT_SECRET']).GOOGLE_OAUTH_CLIENT_SECRET },
        { name: 'USER_GOOGLE_EMAIL', check: () => !!readEnvFile(['USER_GOOGLE_EMAIL']).USER_GOOGLE_EMAIL },
      ];
    default:
      return [];
  }
}

function buildGoogleWorkspaceDef(): IntegrationDefinition {
  let service: WorkspaceMcpService | null = null;

  return {
    id: 'mcp:google-workspace',
    name: 'Google Workspace',
    type: 'mcp-server',
    description: 'Google Workspace MCP (Gmail, Calendar, Tasks, Drive, Docs, Sheets)',
    builtIn: true,
    requirements: [
      { name: 'GOOGLE_OAUTH_CLIENT_ID', check: () => !!readEnvFile(['GOOGLE_OAUTH_CLIENT_ID']).GOOGLE_OAUTH_CLIENT_ID },
      { name: 'GOOGLE_OAUTH_CLIENT_SECRET', check: () => !!readEnvFile(['GOOGLE_OAUTH_CLIENT_SECRET']).GOOGLE_OAUTH_CLIENT_SECRET },
      { name: 'USER_GOOGLE_EMAIL', check: () => !!readEnvFile(['USER_GOOGLE_EMAIL']).USER_GOOGLE_EMAIL },
    ],
    isConfigured() {
      const env = readEnvFile(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'USER_GOOGLE_EMAIL']);
      return !!(env.GOOGLE_OAUTH_CLIENT_ID && env.GOOGLE_OAUTH_CLIENT_SECRET && env.USER_GOOGLE_EMAIL);
    },
    async start() {
      const env = readEnvFile(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'USER_GOOGLE_EMAIL']);
      service = createWorkspaceMcpService({
        port: WORKSPACE_MCP_PORT,
        googleOAuthClientId: env.GOOGLE_OAUTH_CLIENT_ID,
        googleOAuthClientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        userGoogleEmail: env.USER_GOOGLE_EMAIL,
      });
      await service.start();
      return {
        stop: () => service!.stop(),
        mcpService: service,
      };
    },
    async healthCheck() {
      if (!service) return false;
      return service.isRunning();
    },
  };
}

/** Convert a user-defined McpServerConfig into an IntegrationDefinition. */
export function mcpServerToDefinition(config: McpServerConfig): IntegrationDefinition {
  const id = `mcp:${config.name}`;
  return {
    id,
    name: config.name,
    type: 'mcp-server',
    description: config.description || `User-defined ${config.transport} MCP server`,
    builtIn: false,
    requirements: (config.envVars ?? []).map((v) => ({
      name: v,
      check: () => !!readEnvFile([v])[v],
    })),
    isConfigured: () => true,
    async start() {
      // User-defined MCP servers don't have a host-side process — they're
      // either pre-running HTTP endpoints or stdio servers run in-container.
      // The manager just tracks their state; the container-runner wires them.
      return { stop: async () => {} };
    },
  };
}
