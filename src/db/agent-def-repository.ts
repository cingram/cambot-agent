import { getDatabase } from './connection.js';
import { WorkerDefinition } from '../types.js';

export function setAgentDefinition(def: WorkerDefinition): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO agent_definitions (id, provider, model, personality, secret_keys) VALUES (?, ?, ?, ?, ?)',
  ).run(def.id, def.provider, def.model, def.personality ?? null, JSON.stringify(def.secretKeys));
}

export function getAgentDefinition(id: string): WorkerDefinition | undefined {
  const db = getDatabase();
  const row = db
    .prepare('SELECT * FROM agent_definitions WHERE id = ?')
    .get(id) as {
      id: string;
      provider: string;
      model: string;
      personality: string | null;
      secret_keys: string;
    } | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    provider: row.provider,
    model: row.model,
    personality: row.personality ?? undefined,
    secretKeys: JSON.parse(row.secret_keys),
  };
}

export function getAllAgentDefinitions(): WorkerDefinition[] {
  const db = getDatabase();
  const rows = db
    .prepare('SELECT * FROM agent_definitions')
    .all() as Array<{
      id: string;
      provider: string;
      model: string;
      personality: string | null;
      secret_keys: string;
    }>;
  return rows.map((row) => ({
    id: row.id,
    provider: row.provider,
    model: row.model,
    personality: row.personality ?? undefined,
    secretKeys: JSON.parse(row.secret_keys),
  }));
}

export function deleteAgentDefinition(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM agent_definitions WHERE id = ?').run(id);
}

export function setProviderImage(provider: string, containerImage: string): void {
  const db = getDatabase();
  db.prepare(
    'INSERT OR REPLACE INTO provider_images (provider, container_image) VALUES (?, ?)',
  ).run(provider, containerImage);
}

export function getProviderImage(provider: string): string | undefined {
  const db = getDatabase();
  const row = db
    .prepare('SELECT container_image FROM provider_images WHERE provider = ?')
    .get(provider) as { container_image: string } | undefined;
  return row?.container_image;
}
