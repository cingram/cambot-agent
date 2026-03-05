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
  getConversation,
  deleteConversation,
  renameConversation,
  updatePreview,
} from './conversation-repository.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('upsertConversation', () => {
  it('inserts a new conversation', () => {
    upsertConversation('conv-1', 'Hello world', '');
    const row = getConversation('conv-1');
    expect(row).toBeDefined();
    expect(row!.id).toBe('conv-1');
    expect(row!.title).toBe('Hello world');
  });

  it('updates existing conversation on conflict', () => {
    upsertConversation('conv-1', 'First title', 'First preview');
    upsertConversation('conv-1', 'Updated title', 'Updated preview');
    const row = getConversation('conv-1');
    expect(row!.title).toBe('Updated title');
    expect(row!.preview).toBe('Updated preview');
  });
});

describe('listConversations', () => {
  it('returns conversations ordered by updated_at DESC', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO web_conversations (id, title, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run('old', 'Old', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    db.prepare(
      "INSERT INTO web_conversations (id, title, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run('new', 'New', '', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z');

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

describe('getConversation', () => {
  it('returns conversation by id', () => {
    upsertConversation('conv-1', 'Test', 'preview');
    const row = getConversation('conv-1');
    expect(row).toBeDefined();
    expect(row!.title).toBe('Test');
    expect(row!.preview).toBe('preview');
  });

  it('returns undefined for non-existent id', () => {
    expect(getConversation('nope')).toBeUndefined();
  });
});

describe('deleteConversation', () => {
  it('deletes conversation row', () => {
    upsertConversation('conv-1', 'Test', '');
    deleteConversation('conv-1');
    expect(getConversation('conv-1')).toBeUndefined();
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

  it('deletes associated chats entry', () => {
    const jid = 'web:ui:conv-1';
    storeChatMetadata(jid, '2026-01-01T00:00:00Z', 'Web', 'web');
    upsertConversation('conv-1', 'Test', '');

    deleteConversation('conv-1');

    const db = getDatabase();
    const chat = db.prepare("SELECT jid FROM chats WHERE jid = ?").get(jid);
    expect(chat).toBeUndefined();
  });

  it('is a no-op for non-existent id', () => {
    expect(() => deleteConversation('nope')).not.toThrow();
  });
});

describe('renameConversation', () => {
  it('updates title and updated_at', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO web_conversations (id, title, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run('conv-1', 'Old', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    renameConversation('conv-1', 'New Title');

    const row = getConversation('conv-1');
    expect(row!.title).toBe('New Title');
    expect(row!.updated_at).not.toBe('2026-01-01T00:00:00Z');
  });
});

describe('updatePreview', () => {
  it('updates preview text and updated_at', () => {
    const db = getDatabase();
    db.prepare(
      "INSERT INTO web_conversations (id, title, preview, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
    ).run('conv-1', 'Test', '', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');

    updatePreview('conv-1', 'Some preview text');

    const row = getConversation('conv-1');
    expect(row!.preview).toBe('Some preview text');
    expect(row!.updated_at).not.toBe('2026-01-01T00:00:00Z');
  });
});
