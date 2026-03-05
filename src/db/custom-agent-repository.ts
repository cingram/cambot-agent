import { getDatabase } from './connection.js';

export interface CustomAgentRow {
  id: string;
  name: string;
  description: string;
  provider: string;
  model: string;
  api_key_env_var: string;
  base_url: string | null;
  system_prompt: string;
  tools: string;
  trigger_pattern: string | null;
  group_folder: string;
  max_tokens: number | null;
  temperature: number | null;
  max_iterations: number;
  timeout_ms: number;
  created_at: string;
  updated_at: string;
}

export function createCustomAgent(agent: CustomAgentRow): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO custom_agents (id, name, description, provider, model, api_key_env_var, base_url, system_prompt, tools, trigger_pattern, group_folder, max_tokens, temperature, max_iterations, timeout_ms, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    agent.id, agent.name, agent.description, agent.provider, agent.model,
    agent.api_key_env_var, agent.base_url, agent.system_prompt, agent.tools,
    agent.trigger_pattern, agent.group_folder, agent.max_tokens, agent.temperature,
    agent.max_iterations, agent.timeout_ms, agent.created_at, agent.updated_at,
  );
}

export function getCustomAgent(id: string): CustomAgentRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM custom_agents WHERE id = ?').get(id) as CustomAgentRow | undefined;
}

export function getAllCustomAgents(): CustomAgentRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM custom_agents ORDER BY created_at DESC').all() as CustomAgentRow[];
}

export function getCustomAgentsByGroup(groupFolder: string): CustomAgentRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM custom_agents WHERE group_folder = ? ORDER BY created_at DESC',
  ).all(groupFolder) as CustomAgentRow[];
}

export function updateCustomAgent(
  id: string,
  updates: Partial<Omit<CustomAgentRow, 'id' | 'created_at'>>,
): void {
  const db = getDatabase();
  const fields: string[] = [];
  const values: unknown[] = [];

  const allowedFields = [
    'name', 'description', 'provider', 'model', 'api_key_env_var', 'base_url',
    'system_prompt', 'tools', 'trigger_pattern', 'group_folder', 'max_tokens',
    'temperature', 'max_iterations', 'timeout_ms',
  ] as const;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = ?`);
      values.push(updates[field]);
    }
  }

  if (fields.length === 0) return;

  fields.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE custom_agents SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteCustomAgent(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM custom_agents WHERE id = ?').run(id);
}

export function findCustomAgentByTrigger(messageContent: string): CustomAgentRow | undefined {
  const db = getDatabase();
  const agents = db.prepare(
    'SELECT * FROM custom_agents WHERE trigger_pattern IS NOT NULL',
  ).all() as CustomAgentRow[];

  for (const agent of agents) {
    if (!agent.trigger_pattern) continue;
    try {
      const regex = new RegExp(agent.trigger_pattern, 'i');
      if (regex.test(messageContent.trim())) {
        return agent;
      }
    } catch {
      // Invalid regex, skip
    }
  }
  return undefined;
}
