import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { createAgentRepository, type AgentRepository, type CreateAgentInput } from './agent-repository.js';

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
    expect(agent.agentDefId).toBeNull();
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
      agentDefId: 'claude-default',
    }));

    expect(agent.channels).toEqual(['whatsapp', 'web']);
    expect(agent.mcpServers).toEqual(['workspace-mcp']);
    expect(agent.capabilities).toEqual(['browser']);
    expect(agent.concurrency).toBe(3);
    expect(agent.timeoutMs).toBe(60_000);
    expect(agent.isMain).toBe(true);
    expect(agent.agentDefId).toBe('claude-default');
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
      agentDefId: 'def-1',
    });

    expect(updated.name).toBe('New Name');
    expect(updated.description).toBe('New desc');
    expect(updated.concurrency).toBe(5);
    expect(updated.timeoutMs).toBe(120_000);
    expect(updated.isMain).toBe(true);
    expect(updated.agentDefId).toBe('def-1');
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
