/**
 * Conversation Repository — manages multi-conversation sessions across all channels.
 *
 * Each agent+channel pair can have multiple conversations. Only one is active at a time
 * per (agent_folder, channel). Conversations link to Claude SDK sessions, enabling
 * switch-back to old conversations.
 */
import { randomUUID } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, CONVERSATION_ROTATION_ENABLED, CONVERSATION_IDLE_TIMEOUT_MS, CONVERSATION_MAX_SIZE_KB, LONG_LIVED_DEFAULT_MAX_SIZE_KB } from '../config/config.js';
import type { MemoryStrategy } from '../types.js';
import { getDatabase } from './connection.js';

export interface Conversation {
  id: string;
  title: string;
  preview: string;
  agentFolder: string;
  sessionId: string | null;
  channel: string;
  chatJid: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationResolution {
  conversation: Conversation;
  rotatedFrom?: Conversation;  // set when rotation occurred
  isNew: boolean;              // true if conversation was just created
  isTransient: boolean;        // true for ephemeral (not in DB)
}

interface ConversationRow {
  id: string;
  title: string;
  preview: string;
  agent_folder: string;
  session_id: string | null;
  channel: string;
  chat_jid: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    preview: row.preview,
    agentFolder: row.agent_folder,
    sessionId: row.session_id,
    channel: row.channel,
    chatJid: row.chat_jid,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Create a new conversation. Deactivates the current active conversation for the same agent+channel. */
export function createConversation(agentFolder: string, channel: string, chatJid?: string, title?: string): Conversation {
  const db = getDatabase();
  const id = randomUUID();
  db.transaction(() => {
    db.prepare(`
      UPDATE conversations SET is_active = 0
      WHERE agent_folder = ? AND channel = ? AND is_active = 1
    `).run(agentFolder, channel);
    db.prepare(`
      INSERT INTO conversations (id, title, agent_folder, channel, chat_jid, is_active)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(id, title ?? 'New conversation', agentFolder, channel, chatJid ?? null);
  })();
  return getConversationById(id)!;
}

/** Get the active conversation for an agent+channel. Returns undefined if none. */
export function getActiveConversation(agentFolder: string, channel?: string): Conversation | undefined {
  const db = getDatabase();
  if (channel) {
    const row = db.prepare(`
      SELECT * FROM conversations
      WHERE agent_folder = ? AND channel = ? AND is_active = 1
    `).get(agentFolder, channel) as ConversationRow | undefined;
    return row ? rowToConversation(row) : undefined;
  }
  // Fallback: any active conversation for this agent
  const row = db.prepare(`
    SELECT * FROM conversations
    WHERE agent_folder = ? AND is_active = 1
    ORDER BY updated_at DESC LIMIT 1
  `).get(agentFolder) as ConversationRow | undefined;
  return row ? rowToConversation(row) : undefined;
}

/** Get a conversation by ID. */
export function getConversationById(id: string): Conversation | undefined {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as ConversationRow | undefined;
  return row ? rowToConversation(row) : undefined;
}

/** List all conversations for an agent, most recent first. */
export function listAgentConversations(agentFolder: string, limit = 50): Conversation[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM conversations
    WHERE agent_folder = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(agentFolder, limit) as ConversationRow[];
  return rows.map(rowToConversation);
}

/** List all conversations (for web UI), most recent first. */
export function listConversations(limit = 100): Conversation[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM conversations
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as ConversationRow[];
  return rows.map(rowToConversation);
}

/** Switch the active conversation for an agent+channel. Returns the activated conversation. */
export function activateConversation(agentFolder: string, conversationId: string): Conversation {
  const db = getDatabase();
  const target = getConversationById(conversationId);
  if (!target) throw new Error(`Conversation ${conversationId} not found`);

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE conversations SET is_active = 0
      WHERE agent_folder = ? AND channel = ? AND is_active = 1
    `).run(agentFolder, target.channel);
    db.prepare(`
      UPDATE conversations SET is_active = 1, updated_at = ?
      WHERE id = ? AND agent_folder = ?
    `).run(now, conversationId, agentFolder);
  })();
  return { ...target, isActive: true, updatedAt: now };
}

/** Link a session ID to a conversation. */
export function setConversationSession(conversationId: string, sessionId: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE conversations
    SET session_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(sessionId, conversationId);
}

/** Update conversation title. */
export function renameConversation(id: string, title: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE conversations
    SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(title, id);
}

const PREVIEW_MAX_LENGTH = 200;

/** Update conversation preview text (auto-truncated to 200 chars). */
export function updatePreview(id: string, preview: string): void {
  const db = getDatabase();
  const truncated = preview.length > PREVIEW_MAX_LENGTH ? preview.slice(0, PREVIEW_MAX_LENGTH) : preview;
  db.prepare(`
    UPDATE conversations
    SET preview = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(truncated, id);
}

/** Touch the updated_at timestamp of a conversation. */
export function touchConversation(id: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE conversations
    SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(id);
}

/** Upsert a conversation (for web channel). */
export function upsertConversation(id: string, title: string, preview: string, agentFolder = 'main', channel = 'web'): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO conversations (id, title, preview, agent_folder, channel)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      preview = excluded.preview,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(id, title, preview, agentFolder, channel);
}

/** Delete a conversation and its associated messages. */
export function deleteConversation(id: string): void {
  const db = getDatabase();
  const convo = getConversationById(id);
  if (!convo) return;
  const jid = convo.chatJid ?? `web:ui:${id}`;
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
  })();
}

/**
 * Bulk-delete conversations and their associated messages/chats.
 * Uses SQL subqueries to avoid N+1 per-row deletes.
 * @param whereClause  SQL fragment appended after `FROM conversations` (e.g. `WHERE agent_folder = ?`), or empty for all.
 * @param params       Bind parameters for the WHERE clause.
 */
function bulkDeleteConversations(whereClause: string, params: unknown[]): number {
  const db = getDatabase();
  const count = (db.prepare(`SELECT COUNT(*) as n FROM conversations ${whereClause}`).get(...params) as { n: number }).n;
  if (count === 0) return 0;

  // Subquery that resolves each conversation's JID (chat_jid or fallback web:ui:<id>)
  const jidSubquery = `
    SELECT COALESCE(chat_jid, 'web:ui:' || id) AS jid
    FROM conversations ${whereClause}
  `;

  db.transaction(() => {
    db.prepare(`DELETE FROM messages WHERE chat_jid IN (${jidSubquery})`).run(...params);
    db.prepare(`DELETE FROM chats WHERE jid IN (${jidSubquery})`).run(...params);
    db.prepare(`DELETE FROM conversations ${whereClause}`).run(...params);
  })();
  return count;
}

/** Delete all conversations (and associated messages/chats) for a given agent folder. */
export function deleteConversationsByFolder(agentFolder: string): number {
  return bulkDeleteConversations('WHERE agent_folder = ?', [agentFolder]);
}

/** Delete ALL conversations (and associated messages/chats) across all agents. */
export function deleteAllConversations(): number {
  return bulkDeleteConversations('', []);
}

/**
 * Check if an active conversation should be rotated (idle timeout or size exceeded).
 * When a MemoryStrategy is provided, per-agent overrides take precedence over globals.
 */
function needsRotation(active: Conversation, agentFolder: string, strategy?: MemoryStrategy): boolean {
  if (!CONVERSATION_ROTATION_ENABLED) return false;

  const mode = strategy?.mode ?? 'persistent';

  // Resolve thresholds based on strategy
  let idleTimeoutMs: number | null;
  let maxSizeKb: number;

  switch (mode) {
    case 'long-lived':
      // No idle timeout; size threshold is very high
      idleTimeoutMs = null;
      maxSizeKb = strategy?.rotationMaxSizeKb ?? LONG_LIVED_DEFAULT_MAX_SIZE_KB;
      break;
    case 'conversation-scoped':
    case 'persistent':
    default:
      idleTimeoutMs = strategy?.rotationIdleTimeoutMs ?? CONVERSATION_IDLE_TIMEOUT_MS;
      maxSizeKb = strategy?.rotationMaxSizeKb ?? CONVERSATION_MAX_SIZE_KB;
      break;
  }

  // Check idle timeout
  if (idleTimeoutMs !== null) {
    const idleMs = Date.now() - new Date(active.updatedAt).getTime();
    if (idleMs > idleTimeoutMs) return true;
  }

  // Check transcript size
  if (active.sessionId) {
    const transcriptPath = path.join(
      DATA_DIR, 'sessions', agentFolder, '.claude', 'projects',
      '-workspace-group', `${active.sessionId}.jsonl`,
    );
    try {
      const stat = fs.statSync(transcriptPath);
      if (stat.size > maxSizeKb * 1024) return true;
    } catch {
      // File doesn't exist yet — no rotation needed
    }
  }

  return false;
}

/** Create a transient (in-memory only) conversation for ephemeral agents. */
function createTransientConversation(agentFolder: string, channel: string, chatJid?: string): Conversation {
  return {
    id: randomUUID(),
    title: 'Ephemeral',
    preview: '',
    agentFolder,
    sessionId: null,
    channel,
    chatJid: chatJid ?? null,
    isActive: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Get or create the active conversation for an agent+channel, auto-rotating if needed.
 * This is the main entry point for all pipelines.
 *
 * Returns a ConversationResolution when a memoryStrategy is provided,
 * or a plain Conversation for backward compatibility when called without one.
 */
export function resolveActiveConversation(agentFolder: string, channel: string, chatJid?: string, memoryStrategy?: MemoryStrategy): ConversationResolution {
  const mode = memoryStrategy?.mode ?? 'persistent';

  // Ephemeral: no DB row, transient in-memory conversation
  if (mode === 'ephemeral') {
    return {
      conversation: createTransientConversation(agentFolder, channel, chatJid),
      isNew: true,
      isTransient: true,
    };
  }

  const active = getActiveConversation(agentFolder, channel);

  if (active) {
    if (needsRotation(active, agentFolder, memoryStrategy)) {
      const newConv = createConversation(agentFolder, channel, chatJid);
      return {
        conversation: newConv,
        rotatedFrom: active,
        isNew: true,
        isTransient: false,
      };
    }
    touchConversation(active.id);
    return {
      conversation: active,
      isNew: false,
      isTransient: false,
    };
  }

  return {
    conversation: createConversation(agentFolder, channel, chatJid),
    isNew: true,
    isTransient: false,
  };
}
