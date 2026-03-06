/**
 * Raw Content Repository — stores untrusted raw content for lazy retrieval.
 *
 * Raw content is kept in a separate table with TTL-based cleanup.
 * The agent sees sanitized envelopes by default and can request raw
 * content via the read_raw_content tool when needed.
 */

import type Database from 'better-sqlite3';
import type { SafetyFlag } from '../pipes/content-pipe.js';

export interface StoredRawContent {
  id: string;
  channel: string;
  source: string;
  body: string;
  metadata: Record<string, string>;
  safetyFlags: SafetyFlag[];
  receivedAt: string;
  expiresAt: string;
}

export interface RawContentRepository {
  store(raw: { id: string; channel: string; source: string; body: string; metadata: Record<string, string>; receivedAt: string }, flags: SafetyFlag[]): void;
  get(id: string): StoredRawContent | null;
  exists(id: string): boolean;
  getRecent(channel?: string, limit?: number): StoredRawContent[];
  cleanupExpired(): number;
}

interface RawContentRow {
  id: string;
  channel: string;
  source: string;
  body: string;
  metadata: string;
  safety_flags: string;
  received_at: string;
  expires_at: string;
}

const DEFAULT_TTL_DAYS = 7;

export function createRawContentRepository(
  db: Database.Database,
  ttlDays: number = DEFAULT_TTL_DAYS,
): RawContentRepository {
  // Ensure table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS raw_content (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      source TEXT NOT NULL,
      body TEXT NOT NULL,
      metadata TEXT NOT NULL,
      safety_flags TEXT NOT NULL,
      received_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_raw_content_channel ON raw_content(channel);
    CREATE INDEX IF NOT EXISTS idx_raw_content_expires ON raw_content(expires_at);
  `);

  const storeStmt = db.prepare(`
    INSERT OR REPLACE INTO raw_content (id, channel, source, body, metadata, safety_flags, received_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getStmt = db.prepare('SELECT * FROM raw_content WHERE id = ?');
  const existsStmt = db.prepare('SELECT 1 FROM raw_content WHERE id = ?');
  const recentStmt = db.prepare('SELECT * FROM raw_content WHERE channel = ? ORDER BY received_at DESC LIMIT ?');
  const recentAllStmt = db.prepare('SELECT * FROM raw_content ORDER BY received_at DESC LIMIT ?');
  const cleanupStmt = db.prepare('DELETE FROM raw_content WHERE expires_at < ?');

  function parseRow(row: RawContentRow): StoredRawContent {
    return {
      id: row.id,
      channel: row.channel,
      source: row.source,
      body: row.body,
      metadata: JSON.parse(row.metadata),
      safetyFlags: JSON.parse(row.safety_flags),
      receivedAt: row.received_at,
      expiresAt: row.expires_at,
    };
  }

  return {
    store(raw, flags) {
      const expiresAt = new Date(
        Date.now() + ttlDays * 24 * 60 * 60 * 1000,
      ).toISOString();

      storeStmt.run(
        raw.id,
        raw.channel,
        raw.source,
        raw.body,
        JSON.stringify(raw.metadata),
        JSON.stringify(flags),
        raw.receivedAt,
        expiresAt,
      );
    },

    get(id) {
      const row = getStmt.get(id) as RawContentRow | undefined;
      return row ? parseRow(row) : null;
    },

    exists(id) {
      return existsStmt.get(id) !== undefined;
    },

    getRecent(channel, limit = 20) {
      const rows = channel
        ? (recentStmt.all(channel, limit) as RawContentRow[])
        : (recentAllStmt.all(limit) as RawContentRow[]);
      return rows.map(parseRow);
    },

    cleanupExpired() {
      const now = new Date().toISOString();
      const result = cleanupStmt.run(now);
      return result.changes;
    },
  };
}
