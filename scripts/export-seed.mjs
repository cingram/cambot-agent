#!/usr/bin/env node
/**
 * Export seed data from the local CamBot database.
 *
 * Dumps registered_agents, scheduled_tasks (active only), agent_templates,
 * registered_groups, provider_images, and mcp_servers to seed/db-seed.json.
 *
 * Usage:
 *   node scripts/export-seed.mjs
 *   node scripts/export-seed.mjs --db /path/to/cambot.sqlite
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const dbPath =
  getArg('--db') ||
  path.join(
    process.env.STORE_DIR || path.join(projectRoot, 'store'),
    'cambot.sqlite',
  );

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

function tableExists(name) {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
  return !!row;
}

function exportTable(name, query) {
  if (!tableExists(name)) return [];
  return db.prepare(query || `SELECT * FROM ${name}`).all();
}

const seed = {
  version: 1,
  exported_at: new Date().toISOString(),
  registered_agents: exportTable('registered_agents'),
  scheduled_tasks: exportTable(
    'scheduled_tasks',
    "SELECT * FROM scheduled_tasks WHERE status = 'active'",
  ),
  agent_templates: exportTable('agent_templates'),
  registered_groups: exportTable('registered_groups'),
  provider_images: exportTable('provider_images'),
  mcp_servers: exportTable('mcp_servers'),
};

const outPath = path.join(projectRoot, 'seed', 'db-seed.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(seed, null, 2) + '\n');

const counts = Object.entries(seed)
  .filter(([k]) => k !== 'version' && k !== 'exported_at')
  .map(([k, v]) => `  ${k}: ${v.length}`)
  .join('\n');

console.log(`Exported to ${outPath}\n${counts}`);
db.close();
