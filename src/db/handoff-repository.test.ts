import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { createHandoffRepository, type HandoffRepository } from './handoff-repository.js';

// Mock config to control timeout
vi.mock('../config/config.js', () => ({
  HANDOFF_IDLE_TIMEOUT_MS: 600_000,
}));

let db: Database.Database;
let repo: HandoffRepository;

function createTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS handoff_sessions (
      id           TEXT PRIMARY KEY,
      channel      TEXT NOT NULL,
      chat_jid     TEXT NOT NULL,
      gateway_id   TEXT NOT NULL,
      active_agent TEXT NOT NULL,
      intent       TEXT,
      turn_count   INTEGER NOT NULL DEFAULT 1,
      task_context TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_lookup
      ON handoff_sessions(channel, chat_jid, gateway_id);
    CREATE INDEX IF NOT EXISTS idx_handoff_expires
      ON handoff_sessions(expires_at);
  `);
}

beforeEach(() => {
  db = new Database(':memory:');
  createTable(db);
  repo = createHandoffRepository(db);
});

// ── upsert ──────────────────────────────────────────────────

describe('upsert', () => {
  it('creates a new handoff session', () => {
    const session = repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gateway-1',
      activeAgent: 'email-agent',
      intent: 'organize inbox',
    });

    expect(session.id).toBeDefined();
    expect(session.channel).toBe('web');
    expect(session.chatJid).toBe('web:ui');
    expect(session.gatewayId).toBe('gateway-1');
    expect(session.activeAgent).toBe('email-agent');
    expect(session.intent).toBe('organize inbox');
    expect(session.turnCount).toBe(1);
    expect(session.taskContext).toBeNull();
    expect(session.expiresAt).toBeDefined();
  });

  it('replaces existing session on conflict (same channel/chatJid/gatewayId)', () => {
    const first = repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw',
      activeAgent: 'agent-a',
      intent: 'task A',
    });

    const second = repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw',
      activeAgent: 'agent-b',
      intent: 'task B',
    });

    // Should have same id (upsert preserves the original row id on conflict)
    expect(second.id).toBe(first.id);
    expect(second.activeAgent).toBe('agent-b');
    expect(second.intent).toBe('task B');
    expect(second.turnCount).toBe(1); // Reset on upsert
  });

  it('allows different gateways on the same conversation', () => {
    repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw-1',
      activeAgent: 'agent-a',
    });
    repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw-2',
      activeAgent: 'agent-b',
    });

    const a = repo.findActive('web', 'web:ui', 'gw-1');
    const b = repo.findActive('web', 'web:ui', 'gw-2');

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.activeAgent).toBe('agent-a');
    expect(b!.activeAgent).toBe('agent-b');
  });
});

// ── findActive ──────────────────────────────────────────────

describe('findActive', () => {
  it('returns an active session', () => {
    repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw',
      activeAgent: 'email-agent',
    });

    const session = repo.findActive('web', 'web:ui', 'gw');
    expect(session).toBeDefined();
    expect(session!.activeAgent).toBe('email-agent');
  });

  it('returns undefined when no session exists', () => {
    const session = repo.findActive('web', 'web:ui', 'gw');
    expect(session).toBeUndefined();
  });

  it('returns undefined for expired session', () => {
    // Insert a session that's already expired
    db.prepare(`
      INSERT INTO handoff_sessions (id, channel, chat_jid, gateway_id, active_agent, expires_at)
      VALUES ('expired-1', 'web', 'web:ui', 'gw', 'agent-a', datetime('now', '-1 hour'))
    `).run();

    const session = repo.findActive('web', 'web:ui', 'gw');
    expect(session).toBeUndefined();
  });
});

// ── incrementTurn ────────────────────────────────────────────

describe('incrementTurn', () => {
  it('increments turn count and updates expires_at', () => {
    const session = repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw',
      activeAgent: 'agent-a',
    });

    expect(session.turnCount).toBe(1);

    repo.incrementTurn(session.id);
    const updated = repo.findActive('web', 'web:ui', 'gw')!;
    expect(updated.turnCount).toBe(2);

    repo.incrementTurn(session.id);
    const again = repo.findActive('web', 'web:ui', 'gw')!;
    expect(again.turnCount).toBe(3);
  });
});

// ── clear ────────────────────────────────────────────────────

describe('clear', () => {
  it('removes the session', () => {
    const session = repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw',
      activeAgent: 'agent-a',
    });

    repo.clear(session.id);

    const found = repo.findActive('web', 'web:ui', 'gw');
    expect(found).toBeUndefined();
  });

  it('does not throw for non-existent id', () => {
    expect(() => repo.clear('nonexistent')).not.toThrow();
  });
});

// ── clearExpired ─────────────────────────────────────────────

describe('clearExpired', () => {
  it('deletes expired sessions and returns count', () => {
    // Insert two expired sessions
    db.prepare(`
      INSERT INTO handoff_sessions (id, channel, chat_jid, gateway_id, active_agent, expires_at)
      VALUES ('exp-1', 'web', 'web:c1', 'gw', 'a1', datetime('now', '-1 hour'))
    `).run();
    db.prepare(`
      INSERT INTO handoff_sessions (id, channel, chat_jid, gateway_id, active_agent, expires_at)
      VALUES ('exp-2', 'web', 'web:c2', 'gw', 'a2', datetime('now', '-2 hours'))
    `).run();

    // Insert one valid session
    repo.upsert({
      channel: 'whatsapp',
      chatJid: '123@g.us',
      gatewayId: 'gw',
      activeAgent: 'agent-a',
    });

    const cleaned = repo.clearExpired();
    expect(cleaned).toBe(2);

    // Valid session still exists
    const valid = repo.findActive('whatsapp', '123@g.us', 'gw');
    expect(valid).toBeDefined();
  });

  it('returns 0 when nothing expired', () => {
    repo.upsert({
      channel: 'web',
      chatJid: 'web:ui',
      gatewayId: 'gw',
      activeAgent: 'agent-a',
    });

    expect(repo.clearExpired()).toBe(0);
  });
});
