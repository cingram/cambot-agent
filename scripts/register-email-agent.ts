/**
 * Register the persistent email agent in the database.
 *
 * Usage: bun run scripts/register-email-agent.ts
 */
import { Database } from 'bun:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_DIR = path.resolve(__dirname, '..', 'store');
const dbPath = path.join(STORE_DIR, 'cambot.sqlite');

const db = new Database(dbPath);
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA foreign_keys = ON');

// Ensure table exists
db.run(`
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
    tool_policy   TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
  );
`);

// Check if already registered
const existing = db.query('SELECT id FROM registered_agents WHERE id = ?').get('email-agent');
if (existing) {
  console.log('Email agent already registered.');
  db.close();
  process.exit(0);
}

const now = new Date().toISOString();
db.run(
  `INSERT INTO registered_agents
    (id, name, description, folder, channels, mcp_servers, capabilities, concurrency, timeout_ms, is_main, tool_policy, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [
    'email-agent',
    'Email Agent',
    'Handles inbound emails and composes replies',
    'email-agent',
    JSON.stringify(['email']),
    JSON.stringify([]),
    JSON.stringify([]),
    1,
    300_000,
    0,
    JSON.stringify({ preset: 'minimal' }),
    now,
    now,
  ],
);

db.close();

console.log('Registered email agent:');
console.log('  id:          email-agent');
console.log('  folder:      email-agent');
console.log('  channels:    ["email"]');
console.log('  mcpServers:  [] (none)');
