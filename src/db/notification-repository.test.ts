import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import {
  createNotificationRepository,
  type NotificationRepository,
} from './notification-repository.js';

let db: Database.Database;
let repo: NotificationRepository;

beforeEach(() => {
  db = new Database(':memory:');
  repo = createNotificationRepository(db);
  repo.ensureTable();
});

// ── insert ──────────────────────────────────────────────────

describe('insert', () => {
  it('creates a notification with defaults', () => {
    const n = repo.insert({
      sourceAgent: 'email-agent',
      category: 'email-priority',
      summary: 'You have 3 urgent emails',
    });

    expect(n.id).toBeDefined();
    expect(n.sourceAgent).toBe('email-agent');
    expect(n.category).toBe('email-priority');
    expect(n.priority).toBe('normal');
    expect(n.summary).toBe('You have 3 urgent emails');
    expect(n.payload).toEqual({});
    expect(n.status).toBe('pending');
    expect(n.acknowledgedBy).toBeNull();
    expect(n.acknowledgedAt).toBeNull();
    expect(n.createdAt).toBeDefined();
    expect(n.expiresAt).toBeDefined();
  });

  it('respects explicit priority', () => {
    const n = repo.insert({
      sourceAgent: 'scheduler',
      category: 'workflow-failure',
      priority: 'critical',
      summary: 'Backup workflow failed',
    });

    expect(n.priority).toBe('critical');
  });

  it('stores and retrieves JSON payload', () => {
    const n = repo.insert({
      sourceAgent: 'research-agent',
      category: 'monitoring-alert',
      summary: 'API latency spike',
      payload: { endpoint: '/api/data', p99Ms: 1200, threshold: 500 },
    });

    expect(n.payload).toEqual({
      endpoint: '/api/data',
      p99Ms: 1200,
      threshold: 500,
    });
  });

  it('respects custom TTL', () => {
    const n1 = repo.insert({
      sourceAgent: 'agent',
      category: 'test',
      summary: 'default TTL',
    });
    const n2 = repo.insert({
      sourceAgent: 'agent',
      category: 'test',
      summary: 'short TTL',
      ttlDays: 1,
    });

    const exp1 = new Date(n1.expiresAt).getTime();
    const exp2 = new Date(n2.expiresAt).getTime();

    // Default (30 days) should expire much later than 1-day TTL
    expect(exp1 - exp2).toBeGreaterThan(28 * 86_400_000);
  });
});

// ── getPending ──────────────────────────────────────────────

describe('getPending', () => {
  it('returns pending notifications', () => {
    repo.insert({ sourceAgent: 'a', category: 'cat', summary: 'one' });
    repo.insert({ sourceAgent: 'b', category: 'cat', summary: 'two' });

    const pending = repo.getPending();
    expect(pending).toHaveLength(2);
  });

  it('excludes acknowledged notifications', () => {
    const n = repo.insert({ sourceAgent: 'a', category: 'cat', summary: 'one' });
    repo.acknowledge([n.id], 'admin');

    const pending = repo.getPending();
    expect(pending).toHaveLength(0);
  });

  it('excludes expired notifications', () => {
    // Insert an already-expired notification
    db.prepare(`
      INSERT INTO admin_inbox (id, source_agent, category, summary, expires_at)
      VALUES ('expired-1', 'agent', 'cat', 'old', datetime('now', '-1 hour'))
    `).run();

    repo.insert({ sourceAgent: 'agent', category: 'cat', summary: 'fresh' });

    const pending = repo.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].summary).toBe('fresh');
  });

  it('filters by category', () => {
    repo.insert({ sourceAgent: 'a', category: 'email', summary: 'email thing' });
    repo.insert({ sourceAgent: 'a', category: 'workflow', summary: 'workflow thing' });

    const emails = repo.getPending({ category: 'email' });
    expect(emails).toHaveLength(1);
    expect(emails[0].category).toBe('email');
  });

  it('filters by priority', () => {
    repo.insert({ sourceAgent: 'a', category: 'cat', priority: 'critical', summary: 'urgent' });
    repo.insert({ sourceAgent: 'a', category: 'cat', priority: 'low', summary: 'meh' });

    const critical = repo.getPending({ priority: 'critical' });
    expect(critical).toHaveLength(1);
    expect(critical[0].priority).toBe('critical');
  });

  it('respects limit', () => {
    for (let i = 0; i < 5; i++) {
      repo.insert({ sourceAgent: 'a', category: 'cat', summary: `item ${i}` });
    }

    const limited = repo.getPending({ limit: 3 });
    expect(limited).toHaveLength(3);
  });

  it('sorts by priority rank then by age', () => {
    repo.insert({ sourceAgent: 'a', category: 'cat', priority: 'low', summary: 'low' });
    repo.insert({ sourceAgent: 'a', category: 'cat', priority: 'critical', summary: 'critical' });
    repo.insert({ sourceAgent: 'a', category: 'cat', priority: 'normal', summary: 'normal' });

    const pending = repo.getPending();
    expect(pending.map(n => n.priority)).toEqual(['critical', 'normal', 'low']);
  });

  it('returns empty array when nothing pending', () => {
    expect(repo.getPending()).toEqual([]);
  });
});

// ── acknowledge ─────────────────────────────────────────────

describe('acknowledge', () => {
  it('marks notifications as acknowledged', () => {
    const n1 = repo.insert({ sourceAgent: 'a', category: 'cat', summary: 'one' });
    const n2 = repo.insert({ sourceAgent: 'b', category: 'cat', summary: 'two' });

    const count = repo.acknowledge([n1.id, n2.id], 'admin-assistant');
    expect(count).toBe(2);

    const pending = repo.getPending();
    expect(pending).toHaveLength(0);
  });

  it('returns 0 for empty ids', () => {
    expect(repo.acknowledge([], 'admin')).toBe(0);
  });

  it('returns 0 for non-existent ids', () => {
    expect(repo.acknowledge(['nonexistent'], 'admin')).toBe(0);
  });

  it('skips already acknowledged notifications', () => {
    const n = repo.insert({ sourceAgent: 'a', category: 'cat', summary: 'one' });
    repo.acknowledge([n.id], 'admin');

    const count = repo.acknowledge([n.id], 'admin');
    expect(count).toBe(0);
  });

  it('handles mixed existing and non-existing ids', () => {
    const n = repo.insert({ sourceAgent: 'a', category: 'cat', summary: 'one' });

    const count = repo.acknowledge([n.id, 'nonexistent'], 'admin');
    expect(count).toBe(1);
  });
});

// ── purgeExpired ────────────────────────────────────────────

describe('purgeExpired', () => {
  it('deletes expired notifications and returns count', () => {
    db.prepare(`
      INSERT INTO admin_inbox (id, source_agent, category, summary, expires_at)
      VALUES ('exp-1', 'agent', 'cat', 'old', datetime('now', '-1 hour'))
    `).run();
    db.prepare(`
      INSERT INTO admin_inbox (id, source_agent, category, summary, expires_at)
      VALUES ('exp-2', 'agent', 'cat', 'older', datetime('now', '-2 hours'))
    `).run();

    repo.insert({ sourceAgent: 'agent', category: 'cat', summary: 'fresh' });

    const purged = repo.purgeExpired();
    expect(purged).toBe(2);

    // Fresh notification still exists
    const pending = repo.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].summary).toBe('fresh');
  });

  it('returns 0 when nothing expired', () => {
    repo.insert({ sourceAgent: 'agent', category: 'cat', summary: 'fresh' });
    expect(repo.purgeExpired()).toBe(0);
  });
});

// ── ensureTable idempotency ─────────────────────────────────

describe('ensureTable', () => {
  it('is idempotent', () => {
    expect(() => repo.ensureTable()).not.toThrow();
    expect(() => repo.ensureTable()).not.toThrow();
  });
});
