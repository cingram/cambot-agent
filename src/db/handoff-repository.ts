/**
 * Handoff Repository — CRUD for gateway handoff sessions.
 *
 * A handoff session tracks when a gateway has delegated a conversation
 * to a specialist agent, enabling session stickiness for follow-up
 * messages without re-classifying through the gateway.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

import { HANDOFF_IDLE_TIMEOUT_MS } from '../config/config.js';

// ── Types ────────────────────────────────────────────────────

export interface HandoffSession {
  id: string;
  channel: string;
  chatJid: string;
  gatewayId: string;
  activeAgent: string;
  intent: string | null;
  turnCount: number;
  taskContext: string | null;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface CreateHandoffInput {
  channel: string;
  chatJid: string;
  gatewayId: string;
  activeAgent: string;
  intent?: string;
  taskContext?: string;
  idleTimeoutMs?: number;
}

export interface HandoffRepository {
  findActive(channel: string, chatJid: string, gatewayId: string): HandoffSession | undefined;
  upsert(input: CreateHandoffInput): HandoffSession;
  incrementTurn(id: string, idleTimeoutMs?: number): void;
  clear(id: string): void;
  clearExpired(): number;
}

// ── Row type ─────────────────────────────────────────────────

interface HandoffRow {
  id: string;
  channel: string;
  chat_jid: string;
  gateway_id: string;
  active_agent: string;
  intent: string | null;
  turn_count: number;
  task_context: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

function parseRow(row: HandoffRow): HandoffSession {
  return {
    id: row.id,
    channel: row.channel,
    chatJid: row.chat_jid,
    gatewayId: row.gateway_id,
    activeAgent: row.active_agent,
    intent: row.intent,
    turnCount: row.turn_count,
    taskContext: row.task_context,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function computeExpiresAt(timeoutMs: number): string {
  return new Date(Date.now() + timeoutMs).toISOString();
}

// ── Factory ──────────────────────────────────────────────────

export function createHandoffRepository(db: Database.Database): HandoffRepository {
  const findActiveStmt = db.prepare(`
    SELECT * FROM handoff_sessions
    WHERE channel = ? AND chat_jid = ? AND gateway_id = ?
      AND expires_at > datetime('now')
    LIMIT 1
  `);

  const upsertStmt = db.prepare(`
    INSERT INTO handoff_sessions (id, channel, chat_jid, gateway_id, active_agent, intent, task_context, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel, chat_jid, gateway_id) DO UPDATE SET
      active_agent = excluded.active_agent,
      intent = excluded.intent,
      task_context = excluded.task_context,
      turn_count = 1,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
      expires_at = excluded.expires_at
  `);

  const getByIdStmt = db.prepare('SELECT * FROM handoff_sessions WHERE id = ?');

  const incrementStmt = db.prepare(`
    UPDATE handoff_sessions
    SET turn_count = turn_count + 1,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        expires_at = ?
    WHERE id = ?
  `);

  const clearStmt = db.prepare('DELETE FROM handoff_sessions WHERE id = ?');

  const clearExpiredStmt = db.prepare(
    "DELETE FROM handoff_sessions WHERE expires_at <= datetime('now')",
  );

  return {
    findActive(channel, chatJid, gatewayId) {
      const row = findActiveStmt.get(channel, chatJid, gatewayId) as HandoffRow | undefined;
      return row ? parseRow(row) : undefined;
    },

    upsert(input) {
      const id = randomUUID();
      const timeoutMs = input.idleTimeoutMs ?? HANDOFF_IDLE_TIMEOUT_MS;
      const expiresAt = computeExpiresAt(timeoutMs);

      upsertStmt.run(
        id,
        input.channel,
        input.chatJid,
        input.gatewayId,
        input.activeAgent,
        input.intent ?? null,
        input.taskContext ?? null,
        expiresAt,
      );

      // On conflict the id remains the original — fetch the actual row
      const row = findActiveStmt.get(input.channel, input.chatJid, input.gatewayId) as HandoffRow;
      return parseRow(row);
    },

    incrementTurn(id, idleTimeoutMs) {
      const timeoutMs = idleTimeoutMs ?? HANDOFF_IDLE_TIMEOUT_MS;
      const expiresAt = computeExpiresAt(timeoutMs);
      incrementStmt.run(expiresAt, id);
    },

    clear(id) {
      clearStmt.run(id);
    },

    clearExpired() {
      const result = clearExpiredStmt.run();
      return result.changes;
    },
  };
}
