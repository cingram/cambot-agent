import { describe, it, expect, beforeEach } from 'vitest';
import {
  _initTestDatabase,
  getDatabase,
  storeChatMetadata,
  storeMessage,
} from './index.js';
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
    const conv = resolveActiveConversation('web-agent', 'web');
    expect(conv.isActive).toBe(true);
    expect(conv.agentFolder).toBe('web-agent');
  });

  it('returns existing active conversation', () => {
    const first = resolveActiveConversation('web-agent', 'web');
    const second = resolveActiveConversation('web-agent', 'web');
    expect(first.id).toBe(second.id);
  });

  it('maintains separate active conversations per channel', () => {
    const web = resolveActiveConversation('my-agent', 'web');
    const wa = resolveActiveConversation('my-agent', 'whatsapp');
    expect(web.id).not.toBe(wa.id);
    expect(web.channel).toBe('web');
    expect(wa.channel).toBe('whatsapp');
    // Both should be active
    expect(getConversationById(web.id)!.isActive).toBe(true);
    expect(getConversationById(wa.id)!.isActive).toBe(true);
  });
});
