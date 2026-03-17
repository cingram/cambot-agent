#!/usr/bin/env bun
/**
 * Export seed data from the local CamBot database.
 *
 * Dumps registered_agents, scheduled_tasks (active only), agent_templates,
 * registered_groups, provider_images, and mcp_servers to seed/db-seed.json.
 *
 * Usage:
 *   bun scripts/export-seed.ts
 *   bun scripts/export-seed.ts --db /path/to/cambot.sqlite
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const dbPath =
  process.argv.includes('--db')
    ? process.argv[process.argv.indexOf('--db') + 1]
    : path.join(
        process.env.STORE_DIR || path.join(process.cwd(), 'store'),
        'cambot.sqlite',
      );

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });

function tableExists(name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { name: string } | undefined;
  return !!row;
}

function exportTable(name: string, query?: string): unknown[] {
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

const outPath = path.join(process.cwd(), 'seed', 'db-seed.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(seed, null, 2) + '\n');

const counts = Object.entries(seed)
  .filter(([k]) => k !== 'version' && k !== 'exported_at')
  .map(([k, v]) => `  ${k}: ${(v as unknown[]).length}`)
  .join('\n');

console.log(`Exported to ${outPath}\n${counts}`);
db.close();
