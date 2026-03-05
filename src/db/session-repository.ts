import { getDatabase } from './connection.js';

export function getSession(sessionKey: string): string | undefined {
  const db = getDatabase();
  const row = db
    .prepare('SELECT session_id FROM auth_sessions WHERE group_folder = ?')
    .get(sessionKey) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(sessionKey: string, sessionId: string): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO auth_sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(sessionKey, sessionId);
}

export function getAllSessions(): Record<string, string> {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT group_folder, session_id FROM auth_sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

export function getRouterState(key: string): string | undefined {
  const db = getDatabase();
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}
