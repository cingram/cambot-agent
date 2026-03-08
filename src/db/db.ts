import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createSchemaManager } from 'cambot-core';

import { DATA_DIR, STORE_DIR } from '../config/config.js';
import { isValidGroupFolder } from '../groups/group-folder.js';
import { logger } from '../logger.js';
import { NewMessage, RegisteredGroup, ScheduledTask, TaskRunLog, WorkerDefinition } from '../types.js';

let db: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'cambot.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');

  // Load sqlite-vec extension if available
  try {
    db.loadExtension('vec0');
  } catch {
    try {
      db.loadExtension('sqlite-vec');
    } catch {
      logger.debug('sqlite-vec extension not available, vector search disabled');
    }
  }

  // Delegate schema creation to cambot-core's schema manager
  const schema = createSchemaManager();
  schema.initialize(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  const schema = createSchemaManager();
  schema.initialize(db);

  // Create agent-specific tables not managed by cambot-core schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_images (
      provider TEXT PRIMARY KEY,
      container_image TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      personality TEXT,
      secret_keys TEXT NOT NULL DEFAULT '[]'
    );
  `);
}

/** Expose the database instance for subsystems that need direct access. */
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDatabase() first');
  return db;
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

/**
 * Store a message directly (for non-WhatsApp channels that don't use Baileys proto).
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me, is_bot_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
  );
}

export interface HistoryMessage {
  id: string;
  content: string;
  sender_name: string;
  timestamp: string;
  is_bot_message: number;
}

/**
 * Get full conversation history for a chat (both user and bot messages).
 * Returns oldest-first ordering.
 */
export function getConversationHistory(
  chatJid: string,
  limit = 200,
): HistoryMessage[] {
  return (
    db
      .prepare(
        `
      SELECT id, content, sender_name, timestamp, is_bot_message
      FROM messages
      WHERE chat_jid = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `,
      )
      .all(chatJid, limit) as HistoryMessage[]
  ).reverse();
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  const sql = `
    SELECT id, chat_jid, sender, sender_name, content, timestamp
    FROM messages
    WHERE chat_jid = ? AND timestamp > ?
      AND is_bot_message = 0 AND content NOT LIKE ?
    ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`) as NewMessage[];
}

export function getChatHistory(
  chatJid: string,
  limit: number,
): Array<{ id: string; content: string; sender_name: string; timestamp: string; is_bot_message: number }> {
  const sql = `
    SELECT id, content, sender_name, timestamp, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `;
  const rows = db.prepare(sql).all(chatJid, limit) as Array<{
    id: string; content: string; sender_name: string; timestamp: string; is_bot_message: number;
  }>;
  // Return in chronological order
  return rows.reverse();
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, schedule_type, schedule_value, context_mode, agent_id, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.agent_id || null,
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function getArchivedTasks(): ScheduledTask[] {
  return db
    .prepare(
      "SELECT * FROM scheduled_tasks WHERE status IN ('completed', 'paused') ORDER BY created_at DESC",
    )
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      'prompt' | 'schedule_type' | 'schedule_value' | 'next_run' | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(sessionKey: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM auth_sessions WHERE group_folder = ?')
    .get(sessionKey) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(sessionKey: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO auth_sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(sessionKey, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM auth_sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as
    | {
        jid: string;
        name: string;
        folder: string;
        trigger_pattern: string;
        added_at: string;
        container_config: string | null;
        requires_trigger: number | null;
      }
    | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
  };
}

export function setRegisteredGroup(
  jid: string,
  group: RegisteredGroup,
): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  // Preserve container_config when re-registering (channels re-register on
  // every connect without containerConfig). Read existing config first, then
  // use INSERT OR REPLACE which handles both jid and folder unique constraints.
  const existingConfig = group.containerConfig
    ? JSON.stringify(group.containerConfig)
    : (db.prepare(
        'SELECT container_config FROM registered_groups WHERE jid = ? OR folder = ?',
      ).get(jid, group.folder) as { container_config: string | null } | undefined)?.container_config ?? null;

  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    existingConfig,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as Array<{
    jid: string;
    name: string;
    folder: string;
    trigger_pattern: string;
    added_at: string;
    container_config: string | null;
    requires_trigger: number | null;
  }>;
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = {
      name: row.name,
      folder: row.folder,
      trigger: row.trigger_pattern,
      added_at: row.added_at,
      containerConfig: row.container_config
        ? JSON.parse(row.container_config)
        : undefined,
      requiresTrigger: row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    };
  }
  return result;
}


// --- Custom agent accessors ---

export interface CustomAgentRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  api_key_env_var: string;
  base_url: string | null;
  system_prompt: string;
  tools: string;
  trigger_pattern: string | null;
  group_folder: string;
  max_tokens: number | null;
  temperature: number | null;
  max_iterations: number;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

export function createCustomAgent(agent: CustomAgentRow): void {
  db.prepare(
    `INSERT INTO custom_agents (id, name, description, provider, model, api_key_env_var, base_url, system_prompt, tools, trigger_pattern, group_folder, max_tokens, temperature, max_iterations, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id, agent.name, agent.description, agent.provider, agent.model,
    agent.api_key_env_var, agent.base_url, agent.system_prompt, agent.tools,
    agent.trigger_pattern, agent.group_folder, agent.max_tokens, agent.temperature,
    agent.max_iterations, agent.timeout_ms, agent.created_at, agent.updated_at,
  );
}

export function getCustomAgent(id: string): CustomAgentRow | undefined {
  return db.prepare('SELECT * FROM custom_agents WHERE id = ?').get(id) as CustomAgentRow | undefined;
}

export function getAllCustomAgents(): CustomAgentRow[] {
  return db.prepare('SELECT * FROM custom_agents ORDER BY created_at DESC').all() as CustomAgentRow[];
}

export function getCustomAgentsByGroup(groupFolder: string): CustomAgentRow[] {
  return db.prepare(
    'SELECT * FROM custom_agents WHERE group_folder = ? ORDER BY created_at DESC',
  ).all(groupFolder) as CustomAgentRow[];
}

export function updateCustomAgent(
  id: string,
  updates: Partial<Omit<CustomAgentRow, 'id' | 'created_at'>>,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  const allowedFields = [
    'name', 'description', 'provider', 'model', 'api_key_env_var', 'base_url',
    'system_prompt', 'tools', 'trigger_pattern', 'group_folder', 'max_tokens',
    'temperature', 'max_iterations', 'timeout_ms',
  ] as const;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(updates[field]);
    }
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE custom_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteCustomAgent(id: string): void {
  db.prepare('DELETE FROM custom_agents WHERE id = ?').run(id);
}

export function findCustomAgentByTrigger(messageContent: string): CustomAgentRow | undefined {
  const agents = db.prepare(
    'SELECT * FROM custom_agents WHERE trigger_pattern IS NOT NULL',
  ).all() as CustomAgentRow[];

  for (const agent of agents) {
    if (!agent.trigger_pattern) continue;
    try {
      const regex = new RegExp(agent.trigger_pattern, 'i');
      if (regex.test(messageContent.trim())) {
        return agent;
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return undefined;
}

// --- Provider image accessors ---

export function setProviderImage(provider: string, containerImage: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO provider_images (provider, container_image) VALUES (?, ?)',
  ).run(provider, containerImage);
}

export function getProviderImage(provider: string): string | undefined {
  const row = db
    .prepare('SELECT container_image FROM provider_images WHERE provider = ?')
    .get(provider) as { container_image: string } | undefined;
  return row?.container_image;
}

// --- Agent definition accessors ---

export function setAgentDefinition(def: WorkerDefinition): void {
  db.prepare(
    'INSERT OR REPLACE INTO agent_definitions (id, provider, model, personality, secret_keys) VALUES (?, ?, ?, ?, ?)',
  ).run(def.id, def.provider, def.model, def.personality ?? null, JSON.stringify(def.secretKeys));
}

export function getAgentDefinition(id: string): WorkerDefinition | undefined {
  const row = db
    .prepare('SELECT * FROM agent_definitions WHERE id = ?')
    .get(id) as {
      id: string;
      provider: string;
      model: string;
      personality: string | null;
      secret_keys: string;
    } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    personality: row.personality ?? undefined,
    secretKeys: JSON.parse(row.secret_keys),
  };
}

export function getAllAgentDefinitions(): WorkerDefinition[] {
  const rows = db
    .prepare('SELECT * FROM agent_definitions')
    .all() as Array<{
      id: string;
      provider: string;
      model: string;
      personality: string | null;
      secret_keys: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    model: row.model,
    personality: row.personality ?? undefined,
    secretKeys: JSON.parse(row.secret_keys),
  }));
}

export function deleteAgentDefinition(id: string): void {
  db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id);
}

// --- Email state accessors ---

export function getEmailState(key: string): string | null {
  const row = db
    .prepare('SELECT value FROM email_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setEmailState(key: string, value: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO email_state (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run(key, value, new Date().toISOString());
}

// --- Integration state accessors ---

export interface IntegrationStateRow {
  id: string;
  enabled: number;
  status: string;
  last_error: string | null;
  last_health_check: string | null;
  updated_at: string;
}

export function getIntegrationState(id: string): IntegrationStateRow | undefined {
  return db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationStateRow | undefined;
}

export function upsertIntegrationState(
  id: string,
  updates: { enabled?: boolean; status?: string; lastError?: string | null },
): void {
  const now = new Date().toISOString();
  const existing = getIntegrationState(id);
  if (existing) {
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.lastError !== undefined) {
      fields.push('last_error = ?');
      values.push(updates.lastError);
    }
    values.push(id);
    db.prepare(`UPDATE integrations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  } else {
    db.prepare(
      `INSERT INTO integrations (id, enabled, status, last_error, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      id,
      updates.enabled === false ? 0 : 1,
      updates.status ?? 'unconfigured',
      updates.lastError ?? null,
      now,
    );
  }
}

export function updateIntegrationHealthCheck(id: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE integrations SET last_health_check = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

export function getAllIntegrationStates(): IntegrationStateRow[] {
  return db.prepare('SELECT * FROM integrations').all() as IntegrationStateRow[];
}

// --- MCP server accessors ---

export interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string | null;
  env_vars: string | null;
  description: string | null;
  port: number | null;
  created_at: string;
}

export function getMcpServer(id: string): McpServerRow | undefined {
  return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
}

export function getAllMcpServers(): McpServerRow[] {
  return db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as McpServerRow[];
}

export function insertMcpServer(server: McpServerRow): void {
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, url, command, args, env_vars, description, port, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    server.id, server.name, server.transport, server.url, server.command,
    server.args, server.env_vars, server.description, server.port, server.created_at,
  );
}

export function deleteMcpServer(id: string): void {
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
