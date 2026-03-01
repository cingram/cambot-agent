/**
 * Integration Manager — Lifecycle management for channels, MCP servers, and skills.
 *
 * Implements IntegrationBackend from cambot-integrations so the agent-callable
 * tools can delegate to it. Owns start/stop/health-check for all integrations.
 */

import type { IntegrationInfo, McpServerConfig } from 'cambot-integrations';

import {
  getAllIntegrationStates,
  getAllMcpServers,
  deleteMcpServer as dbDeleteMcpServer,
  getIntegrationState,
  getMcpServer,
  insertMcpServer,
  upsertIntegrationState,
  updateIntegrationHealthCheck,
} from '../db.js';
import { logger } from '../logger.js';
import type { Channel } from '../types.js';
import type {
  IntegrationContext,
  IntegrationDefinition,
  IntegrationHandle,
  IntegrationManager,
  McpServerEntry,
} from './types.js';
import { mcpServerToDefinition } from './registry.js';

const HEALTH_CHECK_INTERVAL = 60_000;

export function createIntegrationManager(
  initialDefinitions: IntegrationDefinition[],
): IntegrationManager {
  const definitions = new Map<string, IntegrationDefinition>();
  const handles = new Map<string, IntegrationHandle>();
  let healthTimer: ReturnType<typeof setInterval> | null = null;
  let savedCtx: IntegrationContext | null = null;

  for (const def of initialDefinitions) {
    definitions.set(def.id, def);
  }

  function toInfo(def: IntegrationDefinition): IntegrationInfo {
    const dbState = getIntegrationState(def.id);
    const handle = handles.get(def.id);
    const configured = def.isConfigured();

    let status: IntegrationInfo['status'];
    if (!configured) {
      status = 'unconfigured';
    } else if (dbState && dbState.enabled === 0) {
      status = 'disabled';
    } else if (handle) {
      status = dbState?.status === 'error' ? 'error' : 'active';
    } else {
      status = 'configured';
    }

    return {
      id: def.id,
      name: def.name,
      type: def.type,
      description: def.description,
      enabled: dbState ? dbState.enabled === 1 : true,
      status,
      lastError: dbState?.last_error ?? undefined,
      requirements: def.requirements.map((r) => ({ name: r.name, met: r.check() })),
    };
  }

  async function startIntegration(def: IntegrationDefinition, ctx: IntegrationContext): Promise<void> {
    if (handles.has(def.id)) return;

    if (!def.isConfigured()) {
      upsertIntegrationState(def.id, { status: 'unconfigured' });
      return;
    }

    upsertIntegrationState(def.id, { status: 'starting', lastError: null });

    try {
      const handle = await def.start(ctx);
      handles.set(def.id, handle);
      upsertIntegrationState(def.id, { status: 'active', enabled: true });
      logger.info({ id: def.id }, 'Integration started');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      upsertIntegrationState(def.id, { status: 'error', lastError: msg });
      logger.error({ id: def.id, err }, 'Integration failed to start');
    }
  }

  async function stopIntegration(id: string): Promise<void> {
    const handle = handles.get(id);
    if (!handle) return;

    try {
      await handle.stop();
    } catch (err) {
      logger.error({ id, err }, 'Error stopping integration');
    }
    handles.delete(id);
  }

  async function runHealthChecks(): Promise<void> {
    for (const [id, def] of definitions) {
      if (!handles.has(id) || !def.healthCheck) continue;
      try {
        const healthy = await def.healthCheck();
        updateIntegrationHealthCheck(id);
        if (!healthy) {
          upsertIntegrationState(id, { status: 'error', lastError: 'Health check failed' });
          logger.warn({ id }, 'Integration health check failed');
        }
      } catch (err) {
        logger.error({ id, err }, 'Health check error');
      }
    }
  }

  const manager: IntegrationManager = {
    async initialize(ctx: IntegrationContext): Promise<void> {
      // Load user-defined MCP servers from DB
      for (const row of getAllMcpServers()) {
        const config: McpServerConfig = {
          name: row.name,
          transport: row.transport as 'http' | 'sse' | 'stdio',
          url: row.url ?? undefined,
          command: row.command ?? undefined,
          args: row.args ? JSON.parse(row.args) : undefined,
          envVars: row.env_vars ? JSON.parse(row.env_vars) : undefined,
          description: row.description ?? undefined,
          port: row.port ?? undefined,
        };
        const def = mcpServerToDefinition(config);
        definitions.set(def.id, def);
      }

      // Ensure all definitions have a DB row (first run bootstrap)
      const existingStates = new Set(getAllIntegrationStates().map((s) => s.id));
      for (const def of definitions.values()) {
        if (!existingStates.has(def.id)) {
          upsertIntegrationState(def.id, { enabled: true, status: 'unconfigured' });
        }
      }

      // Start all enabled and configured integrations
      let startedChannels = 0;
      for (const def of definitions.values()) {
        const dbState = getIntegrationState(def.id);
        if (dbState && dbState.enabled === 0) {
          logger.debug({ id: def.id }, 'Integration disabled, skipping');
          continue;
        }
        await startIntegration(def, ctx);
        if (def.type === 'channel' && handles.has(def.id)) startedChannels++;
      }

      if (startedChannels === 0 && !definitions.values().next().done) {
        // Check if there are any channel definitions at all
        const hasChannelDefs = [...definitions.values()].some((d) => d.type === 'channel');
        if (hasChannelDefs) {
          throw new Error('No channels configured. Set CHANNELS=cli in .env or run WhatsApp auth.');
        }
      }

      // Start health check timer
      healthTimer = setInterval(() => runHealthChecks(), HEALTH_CHECK_INTERVAL);
      logger.info(
        { total: definitions.size, active: handles.size },
        'Integration manager initialized',
      );
    },

    list(): IntegrationInfo[] {
      return [...definitions.values()].map(toInfo);
    },

    getStatus(id: string): IntegrationInfo | undefined {
      const def = definitions.get(id);
      if (!def) return undefined;
      return toInfo(def);
    },

    async enable(id: string): Promise<IntegrationInfo> {
      const def = definitions.get(id);
      if (!def) throw new Error(`Integration "${id}" not found`);

      upsertIntegrationState(id, { enabled: true });

      // Start if configured and not already running
      if (def.isConfigured() && !handles.has(id)) {
        // We need the context — get it from an active channel handle
        // The manager stores context from initialize(), so we re-use it
        await startIntegration(def, savedCtx!);
      }

      return toInfo(def);
    },

    async disable(id: string): Promise<IntegrationInfo> {
      const def = definitions.get(id);
      if (!def) throw new Error(`Integration "${id}" not found`);

      upsertIntegrationState(id, { enabled: false, status: 'disabled' });
      await stopIntegration(id);

      return toInfo(def);
    },

    async addMcpServer(config: McpServerConfig): Promise<IntegrationInfo> {
      const id = `mcp:${config.name}`;
      if (definitions.has(id)) throw new Error(`MCP server "${config.name}" already exists`);

      // Persist to DB
      insertMcpServer({
        id,
        name: config.name,
        transport: config.transport,
        url: config.url ?? null,
        command: config.command ?? null,
        args: config.args ? JSON.stringify(config.args) : null,
        env_vars: config.envVars ? JSON.stringify(config.envVars) : null,
        description: config.description ?? null,
        port: config.port ?? null,
        created_at: new Date().toISOString(),
      });

      // Add to runtime
      const def = mcpServerToDefinition(config);
      definitions.set(id, def);
      upsertIntegrationState(id, { enabled: true, status: 'configured' });

      // Start immediately if configured
      if (def.isConfigured() && savedCtx) {
        await startIntegration(def, savedCtx);
      }

      return toInfo(def);
    },

    async removeMcpServer(id: string): Promise<void> {
      const def = definitions.get(id);
      if (!def) throw new Error(`Integration "${id}" not found`);
      if (def.builtIn) throw new Error(`Cannot remove built-in integration "${id}"`);

      await stopIntegration(id);
      dbDeleteMcpServer(id);
      definitions.delete(id);
      // Clean up integration state row too
      upsertIntegrationState(id, { status: 'disabled', enabled: false });
    },

    getActiveChannels(): Channel[] {
      const channels: Channel[] = [];
      for (const [id, handle] of handles) {
        const def = definitions.get(id);
        if (def?.type === 'channel' && handle.channel) {
          channels.push(handle.channel);
        }
      }
      return channels;
    },

    getActiveMcpServers(): McpServerEntry[] {
      const servers: McpServerEntry[] = [];
      for (const [id, handle] of handles) {
        const def = definitions.get(id);
        if (def?.type !== 'mcp-server') continue;

        // Built-in MCP servers with a running service
        if (handle.mcpService && handle.mcpService.isRunning()) {
          servers.push({
            name: def.name.toLowerCase().replace(/\s+/g, '-'),
            transport: 'http',
            url: handle.mcpService.getUrl(),
          });
          continue;
        }

        // User-defined HTTP/SSE servers from DB
        const row = getMcpServer(id);
        if (row && (row.transport === 'http' || row.transport === 'sse') && row.url) {
          servers.push({
            name: row.name,
            transport: row.transport as 'http' | 'sse',
            url: row.url,
          });
        }
      }
      return servers;
    },

    async shutdown(): Promise<void> {
      if (healthTimer) clearInterval(healthTimer);
      const ids = [...handles.keys()];
      await Promise.all(ids.map((id) => stopIntegration(id)));
      logger.info('Integration manager shut down');
    },
  };

  // Wrap initialize to capture context for later enable() calls
  const originalInit = manager.initialize.bind(manager);
  manager.initialize = async (ctx: IntegrationContext) => {
    savedCtx = ctx;
    return originalInit(ctx);
  };

  return manager;
}
