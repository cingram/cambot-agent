/**
 * Agent Repository — CRUD for the registered_agents table.
 *
 * Uses a factory function (composition over inheritance).
 * All JSON columns (channels, mcp_servers, capabilities) are stored
 * as TEXT in SQLite and parsed as string arrays in TypeScript.
 */
import type Database from 'better-sqlite3';

import type { RegisteredAgent } from '../types.js';

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
  agent_def_id: string | null;
  created_at: string;
  updated_at: string;
}

// ── Public interface ──────────────────────────────────────────────
export interface CreateAgentInput {
  id: string;
  name: string;
  description?: string;
  folder: string;
  channels?: string[];
  mcpServers?: string[];
  capabilities?: string[];
  concurrency?: number;
  timeoutMs?: number;
  isMain?: boolean;
  agentDefId?: string | null;
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
  agentDefId?: string | null;
}

export interface AgentRepository {
  ensureTable(): void;
  getAll(): RegisteredAgent[];
  getById(id: string): RegisteredAgent | undefined;
  create(agent: CreateAgentInput): RegisteredAgent;
  update(id: string, updates: UpdateAgentInput): RegisteredAgent;
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
    agentDefId: row.agent_def_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
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
          agent_def_id  TEXT,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
      `);
    },

    getAll(): RegisteredAgent[] {
      const rows = db.prepare('SELECT * FROM registered_agents ORDER BY created_at').all() as AgentRow[];
      return rows.map(rowToAgent);
    },

    getById(id: string): RegisteredAgent | undefined {
      const row = db.prepare('SELECT * FROM registered_agents WHERE id = ?').get(id) as AgentRow | undefined;
      return row ? rowToAgent(row) : undefined;
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
          (id, name, description, folder, channels, mcp_servers, capabilities, concurrency, timeout_ms, is_main, agent_def_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.name,
        input.description ?? '',
        input.folder,
        JSON.stringify(channels),
        JSON.stringify(mcpServers),
        JSON.stringify(capabilities),
        concurrency,
        timeoutMs,
        input.isMain ? 1 : 0,
        input.agentDefId ?? null,
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
      if (updates.agentDefId !== undefined) {
        fields.push('agent_def_id = ?');
        values.push(updates.agentDefId);
      }

      if (fields.length === 0) return existing;

      fields.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);

      db.prepare(`UPDATE registered_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);

      return this.getById(id)!;
    },

    delete(id: string): boolean {
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
