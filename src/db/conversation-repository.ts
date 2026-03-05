import { getDatabase } from './connection.js';

export interface WebConversation {
  id: string;
  title: string;
  preview: string;
  created_at: string;
  updated_at: string;
}

export function upsertConversation(id: string, title: string, preview: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO web_conversations (id, title, preview)
    VALUES (?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      preview = excluded.preview,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  `).run(id, title, preview);
}

export function listConversations(limit = 100): WebConversation[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, title, preview, created_at, updated_at
    FROM web_conversations
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(limit) as WebConversation[];
}

export function getConversation(id: string): WebConversation | undefined {
  const db = getDatabase();
  return db.prepare(`
    SELECT id, title, preview, created_at, updated_at
    FROM web_conversations
    WHERE id = ?
  `).get(id) as WebConversation | undefined;
}

export function deleteConversation(id: string): void {
  const db = getDatabase();
  const jid = `web:ui:${id}`;
  db.transaction(() => {
    db.prepare('DELETE FROM messages WHERE chat_jid = ?').run(jid);
    db.prepare('DELETE FROM chats WHERE jid = ?').run(jid);
    db.prepare('DELETE FROM web_conversations WHERE id = ?').run(id);
  })();
}

export function renameConversation(id: string, title: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE web_conversations
    SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(title, id);
}

export function updatePreview(id: string, preview: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE web_conversations
    SET preview = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(preview, id);
}
