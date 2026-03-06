import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createRawContentRepository } from './raw-content-repository.js';
import type { SafetyFlag } from '../pipes/content-pipe.js';

function makeRaw(id = 'test-1') {
  return {
    id,
    channel: 'email',
    source: 'alice@example.com',
    body: 'Hello world',
    metadata: { Subject: 'Test' },
    receivedAt: new Date().toISOString(),
  };
}

const cleanFlags: SafetyFlag[] = [];
const flaggedFlags: SafetyFlag[] = [
  { severity: 'high', category: 'injection', description: 'Found injection' },
];

describe('createRawContentRepository', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('stores and retrieves raw content', () => {
    const repo = createRawContentRepository(db);

    repo.store(makeRaw(), cleanFlags);
    const result = repo.get('test-1');

    expect(result).not.toBeNull();
    expect(result!.id).toBe('test-1');
    expect(result!.channel).toBe('email');
    expect(result!.source).toBe('alice@example.com');
    expect(result!.body).toBe('Hello world');
    expect(result!.metadata).toEqual({ Subject: 'Test' });
    expect(result!.safetyFlags).toEqual([]);
  });

  it('returns null for nonexistent content', () => {
    const repo = createRawContentRepository(db);
    expect(repo.get('nonexistent')).toBeNull();
  });

  it('exists returns true for stored content', () => {
    const repo = createRawContentRepository(db);

    repo.store(makeRaw(), cleanFlags);

    expect(repo.exists('test-1')).toBe(true);
    expect(repo.exists('nope')).toBe(false);
  });

  it('stores safety flags', () => {
    const repo = createRawContentRepository(db);

    repo.store(makeRaw(), flaggedFlags);
    const result = repo.get('test-1');

    expect(result!.safetyFlags).toHaveLength(1);
    expect(result!.safetyFlags[0].severity).toBe('high');
    expect(result!.safetyFlags[0].category).toBe('injection');
  });

  it('getRecent returns entries ordered by receivedAt desc', () => {
    const repo = createRawContentRepository(db);

    repo.store(
      { ...makeRaw('a'), receivedAt: '2026-01-01T00:00:00Z' },
      cleanFlags,
    );
    repo.store(
      { ...makeRaw('b'), receivedAt: '2026-03-01T00:00:00Z' },
      cleanFlags,
    );

    const recent = repo.getRecent('email', 10);
    expect(recent).toHaveLength(2);
    expect(recent[0].id).toBe('b');
    expect(recent[1].id).toBe('a');
  });

  it('getRecent without channel returns all channels', () => {
    const repo = createRawContentRepository(db);

    repo.store(makeRaw('e1'), cleanFlags);
    repo.store({ ...makeRaw('r1'), channel: 'rss' }, cleanFlags);

    const recent = repo.getRecent(undefined, 10);
    expect(recent).toHaveLength(2);
  });

  it('cleanupExpired removes expired entries', () => {
    const repo = createRawContentRepository(db, 7);

    repo.store(makeRaw(), cleanFlags);

    // Manually set expires_at to the past to simulate expiration
    db.prepare("UPDATE raw_content SET expires_at = '2020-01-01T00:00:00Z' WHERE id = 'test-1'").run();

    const cleaned = repo.cleanupExpired();
    expect(cleaned).toBe(1);
    expect(repo.get('test-1')).toBeNull();
  });

  it('upserts on duplicate id', () => {
    const repo = createRawContentRepository(db);

    repo.store(makeRaw(), cleanFlags);
    repo.store({ ...makeRaw(), body: 'Updated body' }, flaggedFlags);

    const result = repo.get('test-1');
    expect(result!.body).toBe('Updated body');
    expect(result!.safetyFlags).toHaveLength(1);
  });
});
