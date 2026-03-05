import { getDatabase } from './connection.js';

export interface IntegrationStateRow {
  id: string;
  enabled: number;
  status: string;
  last_error: string | null;
  last_health_check: string | null;
  updated_at: string;
}

export function getIntegrationState(id: string): IntegrationStateRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM integrations WHERE id = ?').get(id) as IntegrationStateRow | undefined;
}

export function upsertIntegrationState(
  id: string,
  updates: { enabled?: boolean; status?: string; lastError?: string | null },
): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  const existing = getIntegrationState(id);
  if (existing) {
    const fields: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];
    if (updates.enabled !== undefined) {
      fields.push('enabled = ?');
      values.push(updates.enabled ? 1 : 0);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.lastError !== undefined) {
      fields.push('last_error = ?');
      values.push(updates.lastError);
    }
    values.push(id);
    db.prepare(`UPDATE integrations SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  } else {
    db.prepare(
      `INSERT INTO integrations (id, enabled, status, last_error, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      id,
      updates.enabled === false ? 0 : 1,
      updates.status ?? 'unconfigured',
      updates.lastError ?? null,
      now,
    );
  }
}

export function updateIntegrationHealthCheck(id: string): void {
  const db = getDatabase();
  const now = new Date().toISOString();
  db.prepare('UPDATE integrations SET last_health_check = ?, updated_at = ? WHERE id = ?').run(now, now, id);
}

export function getAllIntegrationStates(): IntegrationStateRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM integrations').all() as IntegrationStateRow[];
}

export function getEmailState(key: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT value FROM email_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setEmailState(key: string, value: string): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO email_state (key, value, updated_at) VALUES (?, ?, ?)`,
  ).run(key, value, new Date().toISOString());
}
