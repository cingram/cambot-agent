#!/usr/bin/env bun
/**
 * Import seed data into a CamBot database.
 *
 * Reads seed/db-seed.json and upserts rows into the target DB.
 * Safe to run multiple times — uses INSERT OR REPLACE so existing
 * rows are updated and new rows are added.
 *
 * Does NOT touch conversation data (messages, chats, sessions, etc.).
 *
 * Usage:
 *   bun scripts/import-seed.ts
 *   bun scripts/import-seed.ts --db /path/to/cambot.sqlite
 *   bun scripts/import-seed.ts --seed /path/to/db-seed.json
 *
 * For deploy/install scripts (no bun), use the standalone node version:
 *   node scripts/import-seed.mjs --db ... --seed ...
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);

function getArg(flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const dbPath =
  getArg('--db') ||
  path.join(
    process.env.STORE_DIR || path.join(process.cwd(), 'store'),
    'cambot.sqlite',
  );

const seedPath =
  getArg('--seed') || path.join(process.cwd(), 'seed', 'db-seed.json');

if (!fs.existsSync(seedPath)) {
  console.log(`No seed file at ${seedPath} — skipping`);
  process.exit(0);
}

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  console.error('Run the application once to create the schema, then re-run import.');
  process.exit(1);
}

const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF'); // Temporarily off for upsert order

function tableExists(name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

function upsertRows(tableName: string, rows: Record<string, unknown>[]): number {
  if (!rows?.length) return 0;
  if (!tableExists(tableName)) {
    console.warn(`  Table ${tableName} does not exist — skipping`);
    return 0;
  }

  const columns = Object.keys(rows[0]);
  const placeholders = columns.map(() => '?').join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`,
  );

  const tx = db.transaction((items: Record<string, unknown>[]) => {
    let count = 0;
    for (const row of items) {
      stmt.run(...columns.map((c) => row[c] ?? null));
      count++;
    }
    return count;
  });

  return tx(rows);
}

console.log(`Importing seed data from ${seedPath}`);
console.log(`Target database: ${dbPath}`);
console.log(`Seed exported at: ${seed.exported_at || 'unknown'}\n`);

// Import in dependency order (groups before tasks, agents before tasks)
const tables = [
  'provider_images',
  'agent_templates',
  'registered_groups',
  'registered_agents',
  'mcp_servers',
  'scheduled_tasks',
] as const;

for (const table of tables) {
  const rows = seed[table];
  if (!rows?.length) {
    console.log(`  ${table}: no data`);
    continue;
  }
  const count = upsertRows(table, rows);
  console.log(`  ${table}: ${count} rows`);
}

db.pragma('foreign_keys = ON');
db.close();
console.log('\nSeed import complete.');
