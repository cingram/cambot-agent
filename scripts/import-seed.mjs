#!/usr/bin/env node
/**
 * Standalone seed importer — runs with plain Node.js + better-sqlite3.
 * Used by deploy/install.sh and deploy/update.sh.
 *
 * Usage:
 *   node scripts/import-seed.mjs --db /path/to/cambot.sqlite --seed /path/to/db-seed.json
 */
import Database from 'better-sqlite3';
import fs from 'fs';

const args = process.argv.slice(2);

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const dbPath = getArg('--db');
const seedPath = getArg('--seed');

if (!seedPath || !dbPath) {
  console.error('Usage: node import-seed.mjs --db <path> --seed <path>');
  process.exit(1);
}

if (!fs.existsSync(seedPath)) {
  console.log(`No seed file at ${seedPath} — skipping`);
  process.exit(0);
}

if (!fs.existsSync(dbPath)) {
  console.log(`Database not found at ${dbPath} — will seed on first run`);
  process.exit(0);
}

const seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = OFF');

function tableExists(name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row;
}

function upsertRows(tableName, rows) {
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

  const tx = db.transaction((items) => {
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
console.log(`Target database: ${dbPath}\n`);

const tables = [
  'provider_images',
  'agent_templates',
  'registered_groups',
  'registered_agents',
  'mcp_servers',
  'scheduled_tasks',
];

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
