import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  getDatabase,
  storeChatMetadata,
  storeMessage,
} from './index.js';
import type { MemoryStrategy } from '../types.js';
import {
  upsertConversation,
  listConversations,
  getConversationById,
  deleteConversation,
  renameConversation,
  updatePreview,
  createConversation,
  getActiveConversation,
  activateConversation,
  listAgentConversations,
  setConversationSession,
  resolveActiveConversation,
} from './conversation-repository.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('upsertConversation', () => {
  it('inserts a new conversation', () => {
    upsertConversation('conv-1', 'Hello world', '');
    const row = getConversationById('conv-1');
    expect(row).toBeDefined();
    expect(row!.id).toBe('conv-1');
    expect(row!.title).toBe('Hello world');
  });

  it('updates existing conversation on conflict', () => {
    upsertConversation('conv-1', 'First title', 'First preview');
    upsertConversation('conv-1', 'Updated title', 'Updated preview');
    const row = getConversationById('conv-1');
    expect(row!.title).toBe('Updated title');
    expect(row!.preview).toBe('Updated preview');
  });
});

describe('createConversation', () => {
  it('creates an active conversation', () => {
    const conv = createConversation('web-agent', 'web');
    expect(conv.isActive).toBe(true);
    expect(conv.agentFolder).toBe('web-agent');
    expect(conv.channel).toBe('web');
  });

  it('deactivates previous active conversation on same channel', () => {
    const first = createConversation('web-agent', 'web');
    const second = createConversation('web-agent', 'web');
    const firstRefresh = getConversationById(first.id);
    expect(firstRefresh!.isActive).toBe(false);
    expect(second.isActive).toBe(true);
  });

  it('does not deactivate conversation on different channel', () => {
    const webConv = createConversation('my-agent', 'web');
    const waConv = createConversation('my-agent', 'whatsapp');
    const webRefresh = getConversationById(webConv.id);
    expect(webRefresh!.isActive).toBe(true);
    expect(waConv.isActive).toBe(true);
  });
});

describe('getActiveConversation', () => {
  it('returns active conversation for agent+channel', () => {
    createConversation('web-agent', 'web');
    const active = getActiveConversation('web-agent', 'web');
    expect(active).toBeDefined();
    expect(active!.isActive).toBe(true);
  });

  it('returns undefined when no active conversation', () => {
    expect(getActiveConversation('nonexistent', 'web')).toBeUndefined();
  });

  it('scopes by channel', () => {
    createConversation('my-agent', 'web');
    expect(getActiveConversation('my-agent', 'web')).toBeDefined();
    expect(getActiveConversation('my-agent', 'whatsapp')).toBeUndefined();
  });

  it('falls back to any active when channel not specified', () => {
    createConversation('my-agent', 'web');
    const active = getActiveConversation('my-agent');
    expect(active).toBeDefined();
    expect(active!.channel).toBe('web');
  });
});

describe('activateConversation', () => {
  it('switches active conversation within same channel', () => {
    const first = createConversation('web-agent', 'web');
    const second = createConversation('web-agent', 'web');

    activateConversation('web-agent', first.id);

    const firstRefresh = getConversationById(first.id);
    const secondRefresh = getConversationById(second.id);
    expect(firstRefresh!.isActive).toBe(true);
    expect(secondRefresh!.isActive).toBe(false);
  });

  it('does not deactivate conversation on different channel', () => {
    const webConv = createConversation('my-agent', 'web');
    const waConv = createConversation('my-agent', 'whatsapp');
    const oldWeb = createConversation('my-agent', 'web');

    // Activate the first web conversation — should only deactivate oldWeb, not waConv
    activateConversation('my-agent', webConv.id);

    expect(getConversationById(webConv.id)!.isActive).toBe(true);
    expect(getConversationById(oldWeb.id)!.isActive).toBe(false);
    expect(getConversationById(waConv.id)!.isActive).toBe(true);
  });

  it('throws for non-existent conversation', () => {
    expect(() => activateConversation('web-agent', 'nope')).toThrow();
  });
});

describe('setConversationSession', () => {
  it('links session ID to conversation', () => {
    const conv = createConversation('web-agent', 'web');
    setConversationSession(conv.id, 'session-123');
    const updated = getConversationById(conv.id);
    expect(updated!.sessionId).toBe('session-123');
  });
});

describe('listAgentConversations', () => {
  it('lists conversations for a specific agent', () => {
    createConversation('agent-a', 'web');
    createConversation('agent-a', 'web');
    createConversation('agent-b', 'web');

    const listA = listAgentConversations('agent-a');
    const listB = listAgentConversations('agent-b');
    expect(listA).toHaveLength(2);
    expect(listB).toHaveLength(1);
  });
});

describe('listConversations', () => {
  it('returns conversations ordered by updated_at DESC', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO conversations (id, title, preview, agent_folder, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('old', 'Old', '', 'main', 'web', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.prepare(
      "INSERT INTO conversations (id, title, preview, agent_folder, channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run('new', 'New', '', 'main', 'web', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

    const list = listConversations();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe('new');
    expect(list[1].id).toBe('old');
  });

  it('respects limit parameter', () => {
    upsertConversation('a', 'A', '');
    upsertConversation('b', 'B', '');
    upsertConversation('c', 'C', '');

    const list = listConversations(2);
    expect(list).toHaveLength(2);
  });

  it('returns empty array when no conversations', () => {
    const list = listConversations();
    expect(list).toEqual([]);
  });
});

describe('getConversationById', () => {
  it('returns conversation by id', () => {
    upsertConversation('conv-1', 'Test', 'preview');
    const row = getConversationById('conv-1');
    expect(row).toBeDefined();
    expect(row!.title).toBe('Test');
    expect(row!.preview).toBe('preview');
  });

  it('returns undefined for non-existent id', () => {
    expect(getConversationById('nope')).toBeUndefined();
  });
});

describe('deleteConversation', () => {
  it('deletes conversation row', () => {
    upsertConversation('conv-1', 'Test', '');
    deleteConversation('conv-1');
    expect(getConversationById('conv-1')).toBeUndefined();
  });

  it('deletes associated messages (composite JID)', () => {
    const jid = 'web:ui:conv-1';
    storeChatMetadata(jid, '2026-01-01T00:00:00Z', 'Web', 'web');
    storeMessage({
      id: 'msg-1',
      chat_jid: jid,
      sender: 'web:user',
      sender_name: 'User',
      content: 'Hello',
      timestamp: '2026-01-01T00:00:00Z',
      is_from_me: false,
    });
    upsertConversation('conv-1', 'Test', '');

    deleteConversation('conv-1');

    const db = getDatabase();
    const msgs = db.prepare("SELECT id FROM messages WHERE chat_jid = ?").all(jid);
    expect(msgs).toHaveLength(0);
  });

  it('is a no-op for non-existent id', () => {
    expect(() => deleteConversation('nope')).not.toThrow();
  });
});

describe('renameConversation', () => {
  it('updates title', () => {
    createConversation('web-agent', 'web');
    const convs = listAgentConversations('web-agent');
    renameConversation(convs[0].id, 'New Title');

    const row = getConversationById(convs[0].id);
    expect(row!.title).toBe('New Title');
  });
});

describe('updatePreview', () => {
  it('updates preview text', () => {
    const conv = createConversation('web-agent', 'web');
    updatePreview(conv.id, 'Some preview text');

    const row = getConversationById(conv.id);
    expect(row!.preview).toBe('Some preview text');
  });
});

describe('resolveActiveConversation', () => {
  it('creates new conversation when none exists', () => {
    const result = resolveActiveConversation('web-agent', 'web');
    expect(result.conversation.isActive).toBe(true);
    expect(result.conversation.agentFolder).toBe('web-agent');
  });

  it('returns existing active conversation', () => {
    const first = resolveActiveConversation('web-agent', 'web');
    const second = resolveActiveConversation('web-agent', 'web');
    expect(first.conversation.id).toBe(second.conversation.id);
  });

  it('maintains separate active conversations per channel', () => {
    const web = resolveActiveConversation('my-agent', 'web');
    const wa = resolveActiveConversation('my-agent', 'whatsapp');
    expect(web.conversation.id).not.toBe(wa.conversation.id);
    expect(web.conversation.channel).toBe('web');
    expect(wa.conversation.channel).toBe('whatsapp');
    // Both should be active
    expect(getConversationById(web.conversation.id)!.isActive).toBe(true);
    expect(getConversationById(wa.conversation.id)!.isActive).toBe(true);
  });
});

describe('resolveActiveConversation with memoryStrategy', () => {
  it('ephemeral: returns transient conversation, no DB row', () => {
    const strategy: MemoryStrategy = { mode: 'ephemeral' };
    const result = resolveActiveConversation('eph-agent', 'web', undefined, strategy);
    expect(result.isTransient).toBe(true);
    expect(result.conversation.agentFolder).toBe('eph-agent');
    expect(result.conversation.channel).toBe('web');
    // No DB row
    const db = getDatabase();
    const rows = db.prepare('SELECT id FROM conversations WHERE agent_folder = ?').all('eph-agent');
    expect(rows).toHaveLength(0);
  });

  it('ephemeral: returns different conversation each call', () => {
    const strategy: MemoryStrategy = { mode: 'ephemeral' };
    const r1 = resolveActiveConversation('eph-agent2', 'web', undefined, strategy);
    const r2 = resolveActiveConversation('eph-agent2', 'web', undefined, strategy);
    expect(r1.conversation.id).not.toBe(r2.conversation.id);
  });

  it('ephemeral: transient conversation has isTransient=true', () => {
    const strategy: MemoryStrategy = { mode: 'ephemeral' };
    const result = resolveActiveConversation('eph3', 'web', undefined, strategy);
    expect(result.isTransient).toBe(true);
    expect(result.isNew).toBe(true);
  });

  it('persistent: uses per-agent rotation override when set', () => {
    // Create a conversation, manually set its updatedAt to be old
    const conv = createConversation('persist-agent', 'web');
    const db = getDatabase();
    // Set updatedAt to 10 seconds ago
    const oldTime = new Date(Date.now() - 10_000).toISOString();
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(oldTime, conv.id);

    // Strategy with 5-second idle timeout (override)
    const strategy: MemoryStrategy = { mode: 'persistent', rotationIdleTimeoutMs: 5000 };
    const result = resolveActiveConversation('persist-agent', 'web', undefined, strategy);
    // Should have rotated due to per-agent idle override (5s < 10s idle)
    expect(result.conversation.id).not.toBe(conv.id);
    expect(result.rotatedFrom).toBeDefined();
    expect(result.rotatedFrom!.id).toBe(conv.id);
  });

  it('persistent: falls back to global when no override', () => {
    // Create a conversation, set updatedAt to 1 second ago (within global timeout)
    const conv = createConversation('persist-nooverride', 'web');
    const db = getDatabase();
    const recentTime = new Date(Date.now() - 1000).toISOString();
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(recentTime, conv.id);

    // Strategy with no overrides — should use global (4 hours)
    const strategy: MemoryStrategy = { mode: 'persistent' };
    const result = resolveActiveConversation('persist-nooverride', 'web', undefined, strategy);
    // Should NOT rotate (1s idle << 4h global timeout)
    expect(result.conversation.id).toBe(conv.id);
    expect(result.rotatedFrom).toBeUndefined();
  });

  it('conversation-scoped: uses per-agent rotation override', () => {
    const conv = createConversation('scoped-agent', 'web');
    const db = getDatabase();
    const oldTime = new Date(Date.now() - 10_000).toISOString();
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(oldTime, conv.id);

    const strategy: MemoryStrategy = { mode: 'conversation-scoped', rotationIdleTimeoutMs: 5000 };
    const result = resolveActiveConversation('scoped-agent', 'web', undefined, strategy);
    expect(result.conversation.id).not.toBe(conv.id);
    expect(result.rotatedFrom).toBeDefined();
  });

  it('long-lived: disables idle timeout', () => {
    const conv = createConversation('longlived-agent', 'web');
    const db = getDatabase();
    // Set updatedAt to 24 hours ago — would trigger any normal timeout
    const oldTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(oldTime, conv.id);

    const strategy: MemoryStrategy = { mode: 'long-lived' };
    const result = resolveActiveConversation('longlived-agent', 'web', undefined, strategy);
    // Should NOT rotate — long-lived disables idle timeout
    expect(result.conversation.id).toBe(conv.id);
    expect(result.rotatedFrom).toBeUndefined();
  });

  it('returns rotatedFrom when rotation occurs', () => {
    const conv = createConversation('rot-agent', 'web');
    const db = getDatabase();
    const oldTime = new Date(Date.now() - 10_000).toISOString();
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(oldTime, conv.id);

    const strategy: MemoryStrategy = { mode: 'persistent', rotationIdleTimeoutMs: 5000 };
    const result = resolveActiveConversation('rot-agent', 'web', undefined, strategy);
    expect(result.rotatedFrom).toBeDefined();
    expect(result.rotatedFrom!.id).toBe(conv.id);
    expect(result.isNew).toBe(true);
  });

  it('returns isNew=true on first conversation', () => {
    const strategy: MemoryStrategy = { mode: 'persistent' };
    const result = resolveActiveConversation('fresh-agent', 'web', undefined, strategy);
    expect(result.isNew).toBe(true);
    expect(result.rotatedFrom).toBeUndefined();
  });

  it('returns isNew=false on existing conversation', () => {
    createConversation('existing-agent', 'web');
    const strategy: MemoryStrategy = { mode: 'persistent' };
    const result = resolveActiveConversation('existing-agent', 'web', undefined, strategy);
    expect(result.isNew).toBe(false);
  });

  it('undefined strategy defaults to persistent behavior', () => {
    const conv = createConversation('default-agent', 'web');
    // No strategy passed — should behave like persistent (current behavior)
    const result = resolveActiveConversation('default-agent', 'web');
    expect(result.conversation.id).toBe(conv.id);
    expect(result.isTransient).toBe(false);
  });
});
