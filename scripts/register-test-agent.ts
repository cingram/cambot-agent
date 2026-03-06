/**
 * Register the persistent test agent in the database.
 *
 * Usage: bun run scripts/register-test-agent.ts
 */
import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', 'store');
const dbPath = path.join(STORE_DIR, 'cambot.sqlite');

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS registered_agents (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    folder        TEXT NOT NULL UNIQUE,
    channels      TEXT NOT NULL DEFAULT '[]',
    mcp_servers   TEXT NOT NULL DEFAULT '[]',
    capabilities  TEXT NOT NULL DEFAULT '[]',
    concurrency   INTEGER NOT NULL DEFAULT 1,
    timeout_ms    INTEGER NOT NULL DEFAULT 300000,
    is_main       INTEGER NOT NULL DEFAULT 0,
    agent_def_id  TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
`);

const existing = db.prepare('SELECT id FROM registered_agents WHERE id = ?').get('test-agent');
if (existing) {
  console.log('Test agent already registered.');
  db.close();
  process.exit(0);
}

const now = new Date().toISOString();
db.prepare(`
  INSERT INTO registered_agents
    (id, name, description, folder, channels, mcp_servers, capabilities, concurrency, timeout_ms, is_main, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'test-agent',
  'Test Agent',
  'Test agent for development and debugging',
  'test-agent',
  JSON.stringify(['cli']),
  JSON.stringify([]),
  JSON.stringify([]),
  1,
  300_000,
  0,
  now,
  now,
);

db.close();

console.log('Registered test agent:');
console.log('  id:          test-agent');
console.log('  folder:      test-agent');
console.log('  channels:    ["cli"]');
console.log('  mcpServers:  [] (none)');
