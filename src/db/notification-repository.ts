/**
 * Notification Repository — CRUD for the admin_inbox table.
 *
 * Any agent can submit notifications; the admin assistant sweeps
 * pending items periodically and sends a consolidated report.
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

// ── Types ────────────────────────────────────────────────────

export type NotificationPriority = 'critical' | 'high' | 'normal' | 'low' | 'info';
export type NotificationStatus = 'pending' | 'acknowledged';

export interface Notification {
  id: string;
  sourceAgent: string;
  category: string;
  priority: NotificationPriority;
  summary: string;
  payload: Record<string, unknown>;
  status: NotificationStatus;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
  expiresAt: string;
}

export interface InsertNotificationInput {
  sourceAgent: string;
  category: string;
  priority?: NotificationPriority;
  summary: string;
  payload?: Record<string, unknown>;
  ttlDays?: number;
}

export interface GetPendingOptions {
  category?: string;
  priority?: NotificationPriority;
  limit?: number;
}

export interface NotificationRepository {
  ensureTable(): void;
  insert(input: InsertNotificationInput): Notification;
  getPending(options?: GetPendingOptions): Notification[];
  acknowledge(ids: string[], acknowledgedBy: string): number;
  purgeExpired(): number;
}

// ── Row type ─────────────────────────────────────────────────

interface NotificationRow {
  id: string;
  source_agent: string;
  category: string;
  priority: string;
  summary: string;
  payload: string;
  status: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  created_at: string;
  expires_at: string;
}

function parseRow(row: NotificationRow): Notification {
  return {
    id: row.id,
    sourceAgent: row.source_agent,
    category: row.category,
    priority: row.priority as NotificationPriority,
    summary: row.summary,
    payload: JSON.parse(row.payload),
    status: row.status as NotificationStatus,
    acknowledgedBy: row.acknowledged_by,
    acknowledgedAt: row.acknowledged_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

// ── Factory ──────────────────────────────────────────────────

const DEFAULT_TTL_DAYS = 30;

export function createNotificationRepository(db: Database.Database): NotificationRepository {
  // Statements are prepared lazily on first use (table must exist first).
  let prepared = false;
  let insertStmt!: Database.Statement;
  let getByIdStmt!: Database.Statement;
  let getPendingStmt!: Database.Statement;
  let purgeStmt!: Database.Statement;

  function ensureStatements(): void {
    if (prepared) return;
    insertStmt = db.prepare(`
      INSERT INTO admin_inbox (id, source_agent, category, priority, summary, payload, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    getByIdStmt = db.prepare('SELECT * FROM admin_inbox WHERE id = ?');
    getPendingStmt = db.prepare(`
      SELECT * FROM admin_inbox
      WHERE status = 'pending'
        AND expires_at > datetime('now')
        AND (? IS NULL OR category = ?)
        AND (? IS NULL OR priority = ?)
      ORDER BY
        CASE priority
          WHEN 'critical' THEN 0 WHEN 'high' THEN 1
          WHEN 'normal' THEN 2 WHEN 'low' THEN 3
          WHEN 'info' THEN 4 ELSE 2
        END,
        created_at ASC
      LIMIT ?
    `);
    purgeStmt = db.prepare("DELETE FROM admin_inbox WHERE expires_at <= datetime('now')");
    prepared = true;
  }

  return {
    ensureTable() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS admin_inbox (
          id              TEXT PRIMARY KEY,
          source_agent    TEXT NOT NULL,
          category        TEXT NOT NULL,
          priority        TEXT NOT NULL DEFAULT 'normal',
          summary         TEXT NOT NULL,
          payload         TEXT NOT NULL DEFAULT '{}',
          status          TEXT NOT NULL DEFAULT 'pending',
          acknowledged_by TEXT,
          acknowledged_at TEXT,
          created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          expires_at      TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_admin_inbox_status ON admin_inbox(status);
        CREATE INDEX IF NOT EXISTS idx_admin_inbox_priority ON admin_inbox(priority);
        CREATE INDEX IF NOT EXISTS idx_admin_inbox_expires ON admin_inbox(expires_at);
      `);
      ensureStatements();
    },

    insert(input) {
      ensureStatements();
      const id = randomUUID();
      const priority = input.priority ?? 'normal';
      const payload = JSON.stringify(input.payload ?? {});
      const ttlDays = input.ttlDays ?? DEFAULT_TTL_DAYS;
      const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();

      insertStmt.run(id, input.sourceAgent, input.category, priority, input.summary, payload, expiresAt);
      return parseRow(getByIdStmt.get(id) as NotificationRow);
    },

    getPending(options) {
      ensureStatements();
      const cat = options?.category ?? null;
      const pri = options?.priority ?? null;
      const limit = options?.limit ?? 100;

      const rows = getPendingStmt.all(cat, cat, pri, pri, limit) as NotificationRow[];
      return rows.map(parseRow);
    },

    acknowledge(ids, acknowledgedBy) {
      ensureStatements();
      if (ids.length === 0) return 0;

      const placeholders = ids.map(() => '?').join(',');
      const stmt = db.prepare(`
        UPDATE admin_inbox
        SET status = 'acknowledged',
            acknowledged_by = ?,
            acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id IN (${placeholders}) AND status = 'pending'
      `);
      return stmt.run(acknowledgedBy, ...ids).changes;
    },

    purgeExpired() {
      ensureStatements();
      return purgeStmt.run().changes;
    },
  };
}
