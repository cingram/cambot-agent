/**
 * Agent Repository — CRUD for the registered_agents table.
 *
 * Uses a factory function (composition over inheritance).
 * All JSON columns (channels, mcp_servers, capabilities) are stored
 * as TEXT in SQLite and parsed as string arrays in TypeScript.
 */
import type Database from 'better-sqlite3';

import type { ContainerConfig, MemoryStrategy, RegisteredAgent, SubagentDefinition } from '../types.js';
import type { ToolPolicy } from '../tools/tool-policy.js';
import type { RoutingKeywords } from '../agents/keyword-generator.js';
import { logger } from '../logger.js';

// ── Raw row shape coming out of SQLite ────────────────────────────
interface AgentRow {
  id: string;
  name: string;
  description: string;
  folder: string;
  channels: string;
  mcp_servers: string;
  capabilities: string;
  concurrency: number;
  timeout_ms: number;
  is_main: number;
  is_system: number;
  tool_policy: string | null;
  system_prompt: string | null;
  soul: string | null;
  provider: string;
  model: string;
  secret_keys: string;
  container_config: string | null;
  memory_strategy: string | null;
  tools: string;
  skills: string;
  temperature: number | null;
  max_tokens: number | null;
  base_url: string | null;
  routing_keywords: string | null;
  subagents: string | null;
  created_at: string;
  updated_at: string;
}

// ── Public interface ──────────────────────────────────────────────
export interface CreateAgentInput {
  id: string;
  name: string;
  /** Required — used for gateway routing keyword generation. */
  description: string;
  folder: string;
  channels?: string[];
  mcpServers?: string[];
  capabilities?: string[];
  concurrency?: number;
  timeoutMs?: number;
  isMain?: boolean;
  /** Mark as system agent (seeded at startup, cannot be deleted). */
  isSystem?: boolean;
  toolPolicy?: ToolPolicy;
  systemPrompt?: string | null;
  soul?: string | null;
  provider?: string;
  model?: string;
  secretKeys?: string[];
  memoryStrategy?: MemoryStrategy;
  containerConfig?: ContainerConfig;
  tools?: string[];
  skills?: string[];
  temperature?: number | null;
  maxTokens?: number | null;
  baseUrl?: string | null;
  routingKeywords?: RoutingKeywords;
  subagents?: Record<string, SubagentDefinition>;
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  channels?: string[];
  mcpServers?: string[];
  capabilities?: string[];
  concurrency?: number;
  timeoutMs?: number;
  isMain?: boolean;
  toolPolicy?: ToolPolicy;
  systemPrompt?: string | null;
  soul?: string | null;
  provider?: string;
  model?: string;
  secretKeys?: string[];
  memoryStrategy?: MemoryStrategy;
  containerConfig?: ContainerConfig;
  tools?: string[];
  skills?: string[];
  temperature?: number | null;
  maxTokens?: number | null;
  baseUrl?: string | null;
  routingKeywords?: RoutingKeywords;
  subagents?: Record<string, SubagentDefinition>;
}

export interface AgentRepository {
  ensureTable(): void;
  getAll(): RegisteredAgent[];
  getById(id: string): RegisteredAgent | undefined;
  getByFolder(folder: string): RegisteredAgent | undefined;
  /** Find the system gateway agent (toolPolicy.preset === 'gateway' + is_system). */
  getSystemGateway(): RegisteredAgent | undefined;
  create(agent: CreateAgentInput): RegisteredAgent;
  update(id: string, updates: UpdateAgentInput): RegisteredAgent;
  /** Promote an agent to system status (cannot be undone via API). */
  markSystem(id: string): void;
  /** Delete an agent. Throws if the agent is a system agent. */
  delete(id: string): boolean;
  getByChannel(channel: string): RegisteredAgent[];
  buildRoutingTable(): Map<string, string>;
}

// ── Validation helpers ────────────────────────────────────────────
function validateConcurrency(value: number): void {
  if (value < 1) {
    throw new Error(`concurrency must be >= 1, got ${value}`);
  }
}

function validateTimeout(value: number): void {
  if (value < 1000) {
    throw new Error(`timeoutMs must be >= 1000, got ${value}`);
  }
}

function validateFolderUnique(db: Database.Database, folder: string, excludeId?: string): void {
  const sql = excludeId
    ? 'SELECT id FROM registered_agents WHERE folder = ? AND id != ?'
    : 'SELECT id FROM registered_agents WHERE folder = ?';
  const params = excludeId ? [folder, excludeId] : [folder];
  const existing = db.prepare(sql).get(...params) as { id: string } | undefined;
  if (existing) {
    throw new Error(`folder "${folder}" is already used by agent "${existing.id}"`);
  }
}

function validateChannelExclusive(
  db: Database.Database,
  channels: string[],
  excludeId?: string,
): void {
  if (channels.length === 0) return;
  const rows = db.prepare('SELECT id, channels FROM registered_agents').all() as AgentRow[];
  for (const row of rows) {
    if (excludeId && row.id === excludeId) continue;
    const existing: string[] = JSON.parse(row.channels);
    for (const ch of channels) {
      if (existing.includes(ch)) {
        throw new Error(`channel "${ch}" is already claimed by agent "${row.id}"`);
      }
    }
  }
}

// ── Row <-> Domain mapper ─────────────────────────────────────────
function rowToAgent(row: AgentRow): RegisteredAgent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    folder: row.folder,
    channels: JSON.parse(row.channels),
    mcpServers: JSON.parse(row.mcp_servers),
    capabilities: JSON.parse(row.capabilities),
    concurrency: row.concurrency,
    timeoutMs: row.timeout_ms,
    isMain: row.is_main === 1,
    system: row.is_system === 1,
    toolPolicy: row.tool_policy ? JSON.parse(row.tool_policy) : undefined,
    systemPrompt: row.system_prompt,
    soul: row.soul,
    provider: row.provider,
    model: row.model,
    secretKeys: JSON.parse(row.secret_keys),
    memoryStrategy: row.memory_strategy ? JSON.parse(row.memory_strategy) : undefined,
    containerConfig: row.container_config ? JSON.parse(row.container_config) : undefined,
    tools: JSON.parse(row.tools),
    skills: JSON.parse(row.skills),
    temperature: row.temperature,
    maxTokens: row.max_tokens,
    baseUrl: row.base_url,
    routingKeywords: row.routing_keywords ? JSON.parse(row.routing_keywords) : undefined,
    subagents: row.subagents ? JSON.parse(row.subagents) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Migration helpers ─────────────────────────────────────────────

function addColumnIfMissing(db: Database.Database, column: string, definition: string): void {
  try {
    db.exec(`ALTER TABLE registered_agents ADD COLUMN ${column} ${definition}`);
  } catch {
    // Column already exists
  }
}

function migrateFromAgentDefinitions(db: Database.Database): void {
  // Check if agent_definitions table exists
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='agent_definitions'",
  ).get();
  if (!hasTable) return;

  // For each registered_agent with an agent_def_id, copy provider/model/secret_keys
  const rows = db.prepare(
    'SELECT ra.id, ra.agent_def_id, ad.provider, ad.model, ad.secret_keys FROM registered_agents ra INNER JOIN agent_definitions ad ON ra.agent_def_id = ad.id WHERE ra.provider = \'claude\' AND ra.agent_def_id IS NOT NULL',
  ).all() as Array<{ id: string; agent_def_id: string; provider: string; model: string; secret_keys: string }>;

  if (rows.length === 0) return;

  const stmt = db.prepare(
    'UPDATE registered_agents SET provider = ?, model = ?, secret_keys = ? WHERE id = ?',
  );
  for (const row of rows) {
    stmt.run(row.provider, row.model, row.secret_keys, row.id);
  }
  logger.info({ count: rows.length }, 'Migrated agent_definitions data into registered_agents');
}

function migrateCustomAgents(db: Database.Database): void {
  const hasTable = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='custom_agents'",
  ).get();
  if (!hasTable) return;

  const rows = db.prepare('SELECT * FROM custom_agents').all() as Array<{
    id: string;
    name: string;
    description: string;
    provider: string;
    model: string;
    api_key_env_var: string;
    base_url: string | null;
    system_prompt: string;
    tools: string;
    group_folder: string;
    max_tokens: number | null;
    temperature: number | null;
    max_iterations: number;
    timeout_ms: number;
    created_at: string;
    updated_at: string;
  }>;

  if (rows.length === 0) {
    db.exec('DROP TABLE custom_agents');
    logger.info('Dropped empty custom_agents table');
    return;
  }

  const now = new Date().toISOString();
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO registered_agents
      (id, name, description, folder, channels, mcp_servers, capabilities,
       concurrency, timeout_ms, is_main, tool_policy,
       system_prompt, soul, provider, model, secret_keys,
       container_config, tools, temperature, max_tokens, base_url,
       created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', '[]', '[]', 1, ?, 0, NULL,
            ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    insertStmt.run(
      row.id,
      row.name,
      row.description,
      row.group_folder,
      row.timeout_ms,
      row.system_prompt,
      row.provider,
      row.model,
      JSON.stringify([row.api_key_env_var]),
      row.tools, // already JSON
      row.temperature,
      row.max_tokens,
      row.base_url,
      row.created_at || now,
      row.updated_at || now,
    );
  }

  db.exec('DROP TABLE custom_agents');
  logger.info({ count: rows.length }, 'Migrated custom_agents into registered_agents and dropped custom_agents table');
}

// ── Factory ───────────────────────────────────────────────────────
export function createAgentRepository(db: Database.Database): AgentRepository {
  return {
    ensureTable(): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS registered_agents (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          folder        TEXT NOT NULL UNIQUE,
          channels      TEXT NOT NULL DEFAULT '[]',
          mcp_servers   TEXT NOT NULL DEFAULT '[]',
          capabilities  TEXT NOT NULL DEFAULT '[]',
          concurrency   INTEGER NOT NULL DEFAULT 1,
          timeout_ms    INTEGER NOT NULL DEFAULT 300000,
          is_main       INTEGER NOT NULL DEFAULT 0,
          is_system     INTEGER NOT NULL DEFAULT 0,
          agent_def_id  TEXT,
          tool_policy   TEXT,
          system_prompt TEXT,
          soul          TEXT,
          provider      TEXT NOT NULL DEFAULT 'claude',
          model         TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
          secret_keys   TEXT NOT NULL DEFAULT '[]',
          container_config TEXT,
          tools         TEXT NOT NULL DEFAULT '[]',
          skills        TEXT NOT NULL DEFAULT '[]',
          temperature   REAL,
          max_tokens    INTEGER,
          base_url      TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
      `);

      // Migrations for existing tables
      addColumnIfMissing(db, 'tool_policy', 'TEXT');
      addColumnIfMissing(db, 'system_prompt', 'TEXT');
      addColumnIfMissing(db, 'soul', 'TEXT');
      addColumnIfMissing(db, 'provider', "TEXT NOT NULL DEFAULT 'claude'");
      addColumnIfMissing(db, 'model', "TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'");
      addColumnIfMissing(db, 'secret_keys', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'container_config', 'TEXT');
      addColumnIfMissing(db, 'memory_strategy', 'TEXT');
      addColumnIfMissing(db, 'tools', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'skills', "TEXT NOT NULL DEFAULT '[]'");
      addColumnIfMissing(db, 'temperature', 'REAL');
      addColumnIfMissing(db, 'max_tokens', 'INTEGER');
      addColumnIfMissing(db, 'base_url', 'TEXT');
      addColumnIfMissing(db, 'is_system', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'routing_keywords', 'TEXT');
      addColumnIfMissing(db, 'subagents', 'TEXT');

      // Data migrations
      migrateFromAgentDefinitions(db);
      migrateCustomAgents(db);
    },

    getAll(): RegisteredAgent[] {
      const rows = db.prepare('SELECT * FROM registered_agents ORDER BY created_at').all() as AgentRow[];
      return rows.map(rowToAgent);
    },

    getById(id: string): RegisteredAgent | undefined {
      const row = db.prepare('SELECT * FROM registered_agents WHERE id = ?').get(id) as AgentRow | undefined;
      return row ? rowToAgent(row) : undefined;
    },

    getByFolder(folder: string): RegisteredAgent | undefined {
      const row = db.prepare('SELECT * FROM registered_agents WHERE folder = ?').get(folder) as AgentRow | undefined;
      return row ? rowToAgent(row) : undefined;
    },

    getSystemGateway(): RegisteredAgent | undefined {
      const row = db.prepare(
        'SELECT * FROM registered_agents WHERE is_system = 1 AND tool_policy IS NOT NULL',
      ).get() as AgentRow | undefined;
      if (!row) return undefined;
      const agent = rowToAgent(row);
      return agent.toolPolicy?.preset === 'gateway' ? agent : undefined;
    },

    create(input: CreateAgentInput): RegisteredAgent {
      const channels = input.channels ?? [];
      const mcpServers = input.mcpServers ?? [];
      const capabilities = input.capabilities ?? [];
      const concurrency = input.concurrency ?? 1;
      const timeoutMs = input.timeoutMs ?? 300_000;

      validateConcurrency(concurrency);
      validateTimeout(timeoutMs);
      validateFolderUnique(db, input.folder);
      validateChannelExclusive(db, channels);

      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO registered_agents
          (id, name, description, folder, channels, mcp_servers, capabilities,
           concurrency, timeout_ms, is_main, is_system, tool_policy,
           system_prompt, soul, provider, model, secret_keys,
           memory_strategy, container_config, tools, skills, temperature, max_tokens, base_url,
           routing_keywords, subagents, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.name,
        input.description,
        input.folder,
        JSON.stringify(channels),
        JSON.stringify(mcpServers),
        JSON.stringify(capabilities),
        concurrency,
        timeoutMs,
        input.isMain ? 1 : 0,
        input.isSystem ? 1 : 0,
        input.toolPolicy ? JSON.stringify(input.toolPolicy) : null,
        input.systemPrompt ?? null,
        input.soul ?? null,
        input.provider ?? 'claude',
        input.model ?? 'claude-sonnet-4-6',
        JSON.stringify(input.secretKeys ?? []),
        input.memoryStrategy ? JSON.stringify(input.memoryStrategy) : null,
        input.containerConfig ? JSON.stringify(input.containerConfig) : null,
        JSON.stringify(input.tools ?? []),
        JSON.stringify(input.skills ?? []),
        input.temperature ?? null,
        input.maxTokens ?? null,
        input.baseUrl ?? null,
        input.routingKeywords ? JSON.stringify(input.routingKeywords) : null,
        input.subagents ? JSON.stringify(input.subagents) : null,
        now,
        now,
      );

      return this.getById(input.id)!;
    },

    update(id: string, updates: UpdateAgentInput): RegisteredAgent {
      const existing = this.getById(id);
      if (!existing) {
        throw new Error(`Agent "${id}" not found`);
      }

      const fields: string[] = [];
      const values: unknown[] = [];
      let invalidatesSessions = false;

      if (updates.name !== undefined) {
        fields.push('name = ?');
        values.push(updates.name);
      }
      if (updates.description !== undefined) {
        fields.push('description = ?');
        values.push(updates.description);
      }
      if (updates.channels !== undefined) {
        validateChannelExclusive(db, updates.channels, id);
        fields.push('channels = ?');
        values.push(JSON.stringify(updates.channels));
      }
      if (updates.mcpServers !== undefined) {
        fields.push('mcp_servers = ?');
        values.push(JSON.stringify(updates.mcpServers));
        invalidatesSessions = true;
      }
      if (updates.capabilities !== undefined) {
        fields.push('capabilities = ?');
        values.push(JSON.stringify(updates.capabilities));
      }
      if (updates.concurrency !== undefined) {
        validateConcurrency(updates.concurrency);
        fields.push('concurrency = ?');
        values.push(updates.concurrency);
      }
      if (updates.timeoutMs !== undefined) {
        validateTimeout(updates.timeoutMs);
        fields.push('timeout_ms = ?');
        values.push(updates.timeoutMs);
      }
      if (updates.isMain !== undefined) {
        fields.push('is_main = ?');
        values.push(updates.isMain ? 1 : 0);
      }
      if (updates.toolPolicy !== undefined) {
        fields.push('tool_policy = ?');
        values.push(JSON.stringify(updates.toolPolicy));
        invalidatesSessions = true;
      }
      if (updates.systemPrompt !== undefined) {
        fields.push('system_prompt = ?');
        values.push(updates.systemPrompt);
        invalidatesSessions = true;
      }
      if (updates.soul !== undefined) {
        fields.push('soul = ?');
        values.push(updates.soul);
        invalidatesSessions = true;
      }
      if (updates.provider !== undefined) {
        fields.push('provider = ?');
        values.push(updates.provider);
        invalidatesSessions = true;
      }
      if (updates.model !== undefined) {
        fields.push('model = ?');
        values.push(updates.model);
        invalidatesSessions = true;
      }
      if (updates.secretKeys !== undefined) {
        fields.push('secret_keys = ?');
        values.push(JSON.stringify(updates.secretKeys));
      }
      if (updates.memoryStrategy !== undefined) {
        fields.push('memory_strategy = ?');
        values.push(updates.memoryStrategy ? JSON.stringify(updates.memoryStrategy) : null);
        invalidatesSessions = true;
      }
      if (updates.containerConfig !== undefined) {
        fields.push('container_config = ?');
        values.push(updates.containerConfig ? JSON.stringify(updates.containerConfig) : null);
      }
      if (updates.tools !== undefined) {
        fields.push('tools = ?');
        values.push(JSON.stringify(updates.tools));
      }
      if (updates.skills !== undefined) {
        fields.push('skills = ?');
        values.push(JSON.stringify(updates.skills));
      }
      if (updates.temperature !== undefined) {
        fields.push('temperature = ?');
        values.push(updates.temperature);
      }
      if (updates.maxTokens !== undefined) {
        fields.push('max_tokens = ?');
        values.push(updates.maxTokens);
      }
      if (updates.baseUrl !== undefined) {
        fields.push('base_url = ?');
        values.push(updates.baseUrl);
      }
      if (updates.routingKeywords !== undefined) {
        fields.push('routing_keywords = ?');
        values.push(JSON.stringify(updates.routingKeywords));
      }
      if (updates.subagents !== undefined) {
        fields.push('subagents = ?');
        values.push(updates.subagents ? JSON.stringify(updates.subagents) : null);
        invalidatesSessions = true;
      }

      if (fields.length === 0) return existing;

      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);

      db.prepare(`UPDATE registered_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);

      if (invalidatesSessions) {
        try {
          const cleared = db.prepare(`
            UPDATE conversations SET session_id = NULL
            WHERE agent_folder = ? AND session_id IS NOT NULL
          `).run(existing.folder);
          if (cleared.changes > 0) {
            logger.info(
              { agentId: id, sessionsCleared: cleared.changes },
              'Agent config changed — invalidated active sessions',
            );
          }

          // Switching to ephemeral: deactivate all conversations for this agent
          if (updates.memoryStrategy?.mode === 'ephemeral') {
            db.prepare(`
              UPDATE conversations SET is_active = 0
              WHERE agent_folder = ? AND is_active = 1
            `).run(existing.folder);
          }
        } catch {
          // conversations table may not exist yet (e.g. during migration)
        }
      }

      return this.getById(id)!;
    },

    markSystem(id: string): void {
      const result = db.prepare(
        'UPDATE registered_agents SET is_system = 1, updated_at = ? WHERE id = ?',
      ).run(new Date().toISOString(), id);
      if (result.changes === 0) {
        throw new Error(`Agent "${id}" not found`);
      }
    },

    delete(id: string): boolean {
      const existing = this.getById(id);
      if (existing?.system) {
        throw new Error(`Cannot delete system agent "${id}"`);
      }
      const result = db.prepare('DELETE FROM registered_agents WHERE id = ?').run(id);
      return result.changes > 0;
    },

    getByChannel(channel: string): RegisteredAgent[] {
      return this.getAll().filter(a => a.channels.includes(channel));
    },

    buildRoutingTable(): Map<string, string> {
      const table = new Map<string, string>();
      const agents = this.getAll();
      for (const agent of agents) {
        for (const channel of agent.channels) {
          table.set(channel, agent.id);
        }
      }
      return table;
    },
  };
}
