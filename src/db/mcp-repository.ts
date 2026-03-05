import { getDatabase } from './connection.js';

export interface McpServerRow {
  id: string;
  name: string;
  transport: string;
  url: string | null;
  command: string | null;
  args: string | null;
  env_vars: string | null;
  description: string | null;
  port: number | null;
  created_at: string;
}

export function getMcpServer(id: string): McpServerRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as McpServerRow | undefined;
}

export function getAllMcpServers(): McpServerRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM mcp_servers ORDER BY created_at').all() as McpServerRow[];
}

export function insertMcpServer(server: McpServerRow): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO mcp_servers (id, name, transport, url, command, args, env_vars, description, port, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    server.id, server.name, server.transport, server.url, server.command,
    server.args, server.env_vars, server.description, server.port, server.created_at,
  );
}

export function deleteMcpServer(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}
