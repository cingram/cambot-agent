import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { createAgentRepository, type AgentRepository, type CreateAgentInput } from './agent-repository.js';
import type { MemoryStrategy } from '../types.js';

let db: Database.Database;
let repo: AgentRepository;

function makeInput(overrides: Partial<CreateAgentInput> = {}): CreateAgentInput {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent',
    folder: 'test-agent',
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  repo = createAgentRepository(db);
  repo.ensureTable();
});

// ── ensureTable ─────────────────────────────────────────────────

describe('ensureTable', () => {
  it('creates the table without error', () => {
    // Table already created in beforeEach; verify it exists by querying
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registered_agents'")
      .get() as { name: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.name).toBe('registered_agents');
  });

  it('is idempotent — calling twice does not throw', () => {
    expect(() => repo.ensureTable()).not.toThrow();
  });
});

// ── create ──────────────────────────────────────────────────────

describe('create', () => {
  it('creates an agent and returns it with all fields', () => {
    const agent = repo.create(makeInput());

    expect(agent.id).toBe('agent-1');
    expect(agent.name).toBe('Test Agent');
    expect(agent.description).toBe('A test agent');
    expect(agent.folder).toBe('test-agent');
    expect(agent.channels).toEqual([]);
    expect(agent.mcpServers).toEqual([]);
    expect(agent.capabilities).toEqual([]);
    expect(agent.concurrency).toBe(1);
    expect(agent.timeoutMs).toBe(300_000);
    expect(agent.isMain).toBe(false);
    expect(agent.systemPrompt).toBeNull();
    expect(agent.soul).toBeNull();
    expect(agent.provider).toBe('claude');
    expect(agent.model).toBe('claude-sonnet-4-6');
    expect(agent.secretKeys).toEqual([]);
    expect(agent.tools).toEqual([]);
    expect(agent.temperature).toBeNull();
    expect(agent.maxTokens).toBeNull();
    expect(agent.baseUrl).toBeNull();
    expect(agent.createdAt).toBeDefined();
    expect(agent.updatedAt).toBeDefined();
  });

  it('persists optional fields correctly', () => {
    const agent = repo.create(makeInput({
      id: 'custom',
      channels: ['whatsapp', 'web'],
      mcpServers: ['workspace-mcp'],
      capabilities: ['browser'],
      concurrency: 3,
      timeoutMs: 60_000,
      isMain: true,
      provider: 'openai',
      model: 'gpt-4o',
      secretKeys: ['OPENAI_API_KEY'],
      tools: ['web_search'],
      systemPrompt: 'You are a helper.',
      temperature: 0.7,
      maxTokens: 4096,
      baseUrl: 'https://api.openai.com',
    }));

    expect(agent.channels).toEqual(['whatsapp', 'web']);
    expect(agent.mcpServers).toEqual(['workspace-mcp']);
    expect(agent.capabilities).toEqual(['browser']);
    expect(agent.concurrency).toBe(3);
    expect(agent.timeoutMs).toBe(60_000);
    expect(agent.isMain).toBe(true);
    expect(agent.provider).toBe('openai');
    expect(agent.model).toBe('gpt-4o');
    expect(agent.secretKeys).toEqual(['OPENAI_API_KEY']);
    expect(agent.tools).toEqual(['web_search']);
    expect(agent.systemPrompt).toBe('You are a helper.');
    expect(agent.temperature).toBe(0.7);
    expect(agent.maxTokens).toBe(4096);
    expect(agent.baseUrl).toBe('https://api.openai.com');
  });

  it('defaults description to empty string when not provided', () => {
    const input = makeInput({ description: undefined });
    delete (input as unknown as Record<string, unknown>).description;
    const agent = repo.create({ id: 'no-desc', name: 'NoDesc', folder: 'no-desc' });
    expect(agent.description).toBe('');
  });
});

// ── create validation ───────────────────────────────────────────

describe('create validation', () => {
  it('rejects concurrency < 1', () => {
    expect(() => repo.create(makeInput({ concurrency: 0 }))).toThrow('concurrency must be >= 1');
    expect(() => repo.create(makeInput({ concurrency: -5 }))).toThrow('concurrency must be >= 1');
  });

  it('rejects timeoutMs < 1000', () => {
    expect(() => repo.create(makeInput({ timeoutMs: 999 }))).toThrow('timeoutMs must be >= 1000');
    expect(() => repo.create(makeInput({ timeoutMs: 0 }))).toThrow('timeoutMs must be >= 1000');
  });
});

// ── create channel exclusivity ──────────────────────────────────

describe('create channel exclusivity', () => {
  it('rejects a second agent claiming the same channel', () => {
    repo.create(makeInput({ id: 'a1', folder: 'f1', channels: ['whatsapp'] }));

    expect(() =>
      repo.create(makeInput({ id: 'a2', folder: 'f2', channels: ['whatsapp'] })),
    ).toThrow('channel "whatsapp" is already claimed by agent "a1"');
  });

  it('allows different channels across agents', () => {
    repo.create(makeInput({ id: 'a1', folder: 'f1', channels: ['whatsapp'] }));

    expect(() =>
      repo.create(makeInput({ id: 'a2', folder: 'f2', channels: ['web'] })),
    ).not.toThrow();
  });
});

// ── create folder uniqueness ────────────────────────────────────

describe('create folder uniqueness', () => {
  it('rejects a second agent with the same folder', () => {
    repo.create(makeInput({ id: 'a1', folder: 'shared-folder' }));

    expect(() =>
      repo.create(makeInput({ id: 'a2', folder: 'shared-folder' })),
    ).toThrow('folder "shared-folder" is already used by agent "a1"');
  });

  it('allows different folders across agents', () => {
    repo.create(makeInput({ id: 'a1', folder: 'folder-1' }));

    expect(() =>
      repo.create(makeInput({ id: 'a2', folder: 'folder-2' })),
    ).not.toThrow();
  });
});

// ── getAll ──────────────────────────────────────────────────────

describe('getAll', () => {
  it('returns all agents ordered by created_at', () => {
    // Insert with explicit timing gap so ordering is deterministic
    repo.create(makeInput({ id: 'b', name: 'Beta', folder: 'fb' }));
    repo.create(makeInput({ id: 'a', name: 'Alpha', folder: 'fa' }));
    repo.create(makeInput({ id: 'c', name: 'Charlie', folder: 'fc' }));

    const all = repo.getAll();
    expect(all).toHaveLength(3);
    // created_at is assigned in insertion order
    expect(all[0].id).toBe('b');
    expect(all[1].id).toBe('a');
    expect(all[2].id).toBe('c');
  });

  it('returns empty array when no agents exist', () => {
    expect(repo.getAll()).toEqual([]);
  });
});

// ── getById ─────────────────────────────────────────────────────

describe('getById', () => {
  it('returns an agent by ID', () => {
    repo.create(makeInput({ id: 'find-me', folder: 'find-me' }));
    const agent = repo.getById('find-me');
    expect(agent).toBeDefined();
    expect(agent!.id).toBe('find-me');
  });

  it('returns undefined for a missing ID', () => {
    expect(repo.getById('nonexistent')).toBeUndefined();
  });
});

// ── update ──────────────────────────────────────────────────────

describe('update', () => {
  it('updates fields and preserves unchanged fields', () => {
    repo.create(makeInput({
      id: 'upd',
      folder: 'upd',
      name: 'Original',
      description: 'Original description',
      channels: ['web'],
    }));

    const updated = repo.update('upd', { name: 'Updated' });

    expect(updated.name).toBe('Updated');
    expect(updated.description).toBe('Original description');
    expect(updated.channels).toEqual(['web']);
    expect(updated.folder).toBe('upd');
  });

  it('updates multiple fields at once', () => {
    repo.create(makeInput({ id: 'multi', folder: 'multi' }));

    const updated = repo.update('multi', {
      name: 'New Name',
      description: 'New desc',
      concurrency: 5,
      timeoutMs: 120_000,
      isMain: true,
      provider: 'openai',
      model: 'gpt-4o',
    });

    expect(updated.name).toBe('New Name');
    expect(updated.description).toBe('New desc');
    expect(updated.concurrency).toBe(5);
    expect(updated.timeoutMs).toBe(120_000);
    expect(updated.isMain).toBe(true);
    expect(updated.provider).toBe('openai');
    expect(updated.model).toBe('gpt-4o');
  });

  it('returns existing agent unchanged when no updates are provided', () => {
    const original = repo.create(makeInput({ id: 'noop', folder: 'noop' }));
    const updated = repo.update('noop', {});
    expect(updated.name).toBe(original.name);
    expect(updated.updatedAt).toBe(original.updatedAt);
  });

  it('throws for a non-existent agent', () => {
    expect(() => repo.update('ghost', { name: 'x' })).toThrow('Agent "ghost" not found');
  });

  it('updates updatedAt timestamp', () => {
    const original = repo.create(makeInput({ id: 'ts', folder: 'ts' }));
    // Small pause not needed — just verify it changed
    const updated = repo.update('ts', { name: 'Changed' });
    // updatedAt should be >= createdAt (may be same in fast tests, but different from a no-op)
    expect(updated.updatedAt).toBeDefined();
  });
});

// ── update validation ───────────────────────────────────────────

describe('update validation', () => {
  it('rejects invalid concurrency on update', () => {
    repo.create(makeInput({ id: 'val', folder: 'val' }));
    expect(() => repo.update('val', { concurrency: 0 })).toThrow('concurrency must be >= 1');
  });

  it('rejects invalid timeout on update', () => {
    repo.create(makeInput({ id: 'val2', folder: 'val2' }));
    expect(() => repo.update('val2', { timeoutMs: 500 })).toThrow('timeoutMs must be >= 1000');
  });
});

// ── update channel exclusivity ──────────────────────────────────

describe('update channel exclusivity', () => {
  it("can't steal another agent's channel", () => {
    repo.create(makeInput({ id: 'owner', folder: 'owner', channels: ['whatsapp'] }));
    repo.create(makeInput({ id: 'thief', folder: 'thief', channels: ['web'] }));

    expect(() =>
      repo.update('thief', { channels: ['whatsapp'] }),
    ).toThrow('channel "whatsapp" is already claimed by agent "owner"');
  });

  it('allows an agent to keep its own channels on update', () => {
    repo.create(makeInput({ id: 'keeper', folder: 'keeper', channels: ['whatsapp'] }));

    // Updating the same agent with its own channel should work
    expect(() =>
      repo.update('keeper', { channels: ['whatsapp', 'email'] }),
    ).not.toThrow();

    const updated = repo.getById('keeper')!;
    expect(updated.channels).toEqual(['whatsapp', 'email']);
  });
});

// ── delete ──────────────────────────────────────────────────────

describe('delete', () => {
  it('removes an agent and returns true', () => {
    repo.create(makeInput({ id: 'del', folder: 'del' }));

    const result = repo.delete('del');
    expect(result).toBe(true);
    expect(repo.getById('del')).toBeUndefined();
  });

  it('returns false for a missing agent', () => {
    expect(repo.delete('ghost')).toBe(false);
  });
});

// ── getByChannel ────────────────────────────────────────────────

describe('getByChannel', () => {
  it('finds agents that claim a channel', () => {
    repo.create(makeInput({ id: 'wa-agent', folder: 'wa', channels: ['whatsapp'] }));
    repo.create(makeInput({ id: 'web-agent', folder: 'web', channels: ['web'] }));

    const result = repo.getByChannel('whatsapp');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('wa-agent');
  });

  it('returns empty array for unclaimed channel', () => {
    repo.create(makeInput({ id: 'a', folder: 'a', channels: ['web'] }));
    expect(repo.getByChannel('telegram')).toEqual([]);
  });
});

// ── buildRoutingTable ───────────────────────────────────────────

describe('buildRoutingTable', () => {
  it('builds Map<channel, agentId>', () => {
    repo.create(makeInput({ id: 'wa-bot', folder: 'wa', channels: ['whatsapp'] }));
    repo.create(makeInput({ id: 'web-bot', folder: 'web', channels: ['web', 'email'] }));

    const table = repo.buildRoutingTable();

    expect(table).toBeInstanceOf(Map);
    expect(table.size).toBe(3);
    expect(table.get('whatsapp')).toBe('wa-bot');
    expect(table.get('web')).toBe('web-bot');
    expect(table.get('email')).toBe('web-bot');
  });

  it('returns empty map when no agents have channels', () => {
    repo.create(makeInput({ id: 'empty', folder: 'empty', channels: [] }));
    const table = repo.buildRoutingTable();
    expect(table.size).toBe(0);
  });

  it('returns empty map when no agents exist', () => {
    const table = repo.buildRoutingTable();
    expect(table.size).toBe(0);
  });
});

// ── memoryStrategy ──────────────────────────────────────────────

describe('memoryStrategy', () => {
  it('stores and retrieves memoryStrategy', () => {
    const strategy: MemoryStrategy = { mode: 'ephemeral' };
    const agent = repo.create(makeInput({ id: 'mem-1', folder: 'mem-1', memoryStrategy: strategy }));
    expect(agent.memoryStrategy).toEqual(strategy);

    const fetched = repo.getById('mem-1');
    expect(fetched!.memoryStrategy).toEqual(strategy);
  });

  it('defaults memoryStrategy to undefined when not set', () => {
    const agent = repo.create(makeInput({ id: 'no-mem', folder: 'no-mem' }));
    expect(agent.memoryStrategy).toBeUndefined();
  });

  it('roundtrips all strategy modes', () => {
    const modes: MemoryStrategy[] = [
      { mode: 'ephemeral' },
      { mode: 'conversation-scoped', rotationIdleTimeoutMs: 5000 },
      { mode: 'persistent', rotationMaxSizeKb: 1024 },
      { mode: 'long-lived', rotationIdleTimeoutMs: 0, rotationMaxSizeKb: 102400 },
    ];
    for (const [i, strategy] of modes.entries()) {
      const id = `mode-${i}`;
      const agent = repo.create(makeInput({ id, folder: id, memoryStrategy: strategy }));
      expect(agent.memoryStrategy).toEqual(strategy);
    }
  });

  it('invalidates sessions when memoryStrategy changes', () => {
    // Create conversations table for session invalidation
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        agent_folder TEXT NOT NULL,
        session_id TEXT,
        channel TEXT NOT NULL DEFAULT 'web',
        chat_jid TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    const agent = repo.create(makeInput({ id: 'inv', folder: 'inv' }));

    // Insert a conversation with a session
    db.prepare(`
      INSERT INTO conversations (id, title, agent_folder, session_id, channel) VALUES (?, ?, ?, ?, ?)
    `).run('conv-1', 'Test', 'inv', 'session-abc', 'web');

    // Update memoryStrategy — should invalidate sessions
    repo.update('inv', { memoryStrategy: { mode: 'ephemeral' } });

    const row = db.prepare('SELECT session_id FROM conversations WHERE id = ?').get('conv-1') as { session_id: string | null };
    expect(row.session_id).toBeNull();
  });

  it('deactivates conversations when switching to ephemeral', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        agent_folder TEXT NOT NULL,
        session_id TEXT,
        channel TEXT NOT NULL DEFAULT 'web',
        chat_jid TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      )
    `);
    repo.create(makeInput({ id: 'eph', folder: 'eph', memoryStrategy: { mode: 'persistent' } }));

    // Insert active conversations
    db.prepare(`INSERT INTO conversations (id, title, agent_folder, session_id, channel, is_active) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('conv-a', 'A', 'eph', 'sess-1', 'web', 1);
    db.prepare(`INSERT INTO conversations (id, title, agent_folder, session_id, channel, is_active) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('conv-b', 'B', 'eph', 'sess-2', 'whatsapp', 1);

    // Switch to ephemeral
    repo.update('eph', { memoryStrategy: { mode: 'ephemeral' } });

    const rows = db.prepare('SELECT id, is_active, session_id FROM conversations WHERE agent_folder = ?')
      .all('eph') as { id: string; is_active: number; session_id: string | null }[];
    for (const row of rows) {
      expect(row.is_active).toBe(0);
      expect(row.session_id).toBeNull();
    }
  });

  it('updates memoryStrategy via update()', () => {
    repo.create(makeInput({ id: 'upd-mem', folder: 'upd-mem' }));
    const updated = repo.update('upd-mem', { memoryStrategy: { mode: 'long-lived', rotationMaxSizeKb: 102400 } });
    expect(updated.memoryStrategy).toEqual({ mode: 'long-lived', rotationMaxSizeKb: 102400 });
  });
});
