#!/usr/bin/env bun
/**
 * Migrate 3 SQLite databases into a single unified database.
 *
 * Source databases:
 *   store/messages.db       → agent tables (chats, messages, scheduled_tasks, etc.)
 *   store/cambot-core.sqlite → memory/telemetry tables (facts, entities, etc.)
 *   store/cambot-ui-logs.sqlite → logs table
 *
 * Target: store/cambot.sqlite
 *
 * After migration, source databases are renamed to .bak for rollback safety.
 *
 * Usage: bun run scripts/migrate-to-unified-db.ts
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createSchemaManager } from 'cambot-core';

const STORE_DIR = path.resolve(import.meta.dirname, '..', 'store');

const MESSAGES_DB = path.join(STORE_DIR, 'messages.db');
const CORE_DB = path.join(STORE_DIR, 'cambot-core.sqlite');
const LOGS_DB = path.join(STORE_DIR, 'cambot-ui-logs.sqlite');
const TARGET_DB = path.join(STORE_DIR, 'cambot.sqlite');

function log(msg: string) {
  console.log(`[migrate] ${msg}`);
}

function fail(msg: string): never {
  console.error(`[migrate] ERROR: ${msg}`);
  process.exit(1);
}

function dbExists(p: string): boolean {
  return fs.existsSync(p);
}

function getTableNames(db: Database.Database): string[] {
  return (db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all() as Array<{ name: string }>).map(r => r.name);
}

function getRowCount(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT COUNT(*) as cnt FROM "${table}"`).get() as { cnt: number }).cnt;
}

function isVirtualOrShadowTable(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(table) as { sql: string | null } | undefined;
  if (!row?.sql) return true; // Virtual tables and shadow tables have null sql
  if (row.sql.includes('VIRTUAL TABLE') || row.sql.includes('virtual table')) return true;
  // vec0 shadow tables: fact_embeddings_* (chunks, rowids, info, vector_chunks00, etc.)
  if (table.startsWith('fact_embeddings_')) return true;
  // FTS5 shadow tables
  if (table.startsWith('facts_fts_')) return true;
  return false;
}

function tableExistsIn(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    "SELECT COUNT(*) as cnt FROM sqlite_master WHERE type='table' AND name = ?"
  ).get(table) as { cnt: number };
  return row.cnt > 0;
}

function copyTableData(
  source: Database.Database,
  target: Database.Database,
  sourceTable: string,
  targetTable: string,
) {
  if (!tableExistsIn(target, targetTable)) {
    // Create the table in target using source schema
    const schemaRow = source.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name = ?"
    ).get(sourceTable) as { sql: string } | undefined;
    if (schemaRow?.sql) {
      const createSql = schemaRow.sql.replace(`"${sourceTable}"`, `"${targetTable}"`).replace(sourceTable, targetTable);
      try {
        target.exec(createSql);
        log(`  created table ${targetTable} from source schema`);
      } catch (err) {
        log(`  ${sourceTable}: skipped (cannot create ${targetTable}: ${err instanceof Error ? err.message : String(err)})`);
        return;
      }
    } else {
      log(`  ${sourceTable}: skipped (no schema found and table ${targetTable} does not exist in target)`);
      return;
    }
  }

  const count = getRowCount(source, sourceTable);
  if (count === 0) {
    log(`  ${sourceTable} → ${targetTable}: 0 rows (skip)`);
    return;
  }

  const rows = source.prepare(`SELECT * FROM "${sourceTable}"`).all();
  if (rows.length === 0) return;

  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const placeholders = columns.map(() => '?').join(', ');
  const colList = columns.map(c => `"${c}"`).join(', ');

  const insert = target.prepare(
    `INSERT OR IGNORE INTO "${targetTable}" (${colList}) VALUES (${placeholders})`
  );

  const batch = target.transaction((data: unknown[]) => {
    for (const row of data) {
      const values = columns.map(c => (row as Record<string, unknown>)[c]);
      insert.run(...values);
    }
  });

  batch(rows);
  log(`  ${sourceTable} → ${targetTable}: ${count} rows`);
}

function main() {
  log('=== CamBot Database Consolidation ===');
  log(`Store directory: ${STORE_DIR}`);

  // Preflight checks
  if (dbExists(TARGET_DB)) {
    fail(`Target database already exists: ${TARGET_DB}\nRemove it first or rename to continue.`);
  }

  const hasMessages = dbExists(MESSAGES_DB);
  const hasCore = dbExists(CORE_DB);
  const hasLogs = dbExists(LOGS_DB);

  if (!hasMessages && !hasCore) {
    fail('No source databases found. Nothing to migrate.');
  }

  log(`Source databases:`);
  log(`  messages.db:           ${hasMessages ? 'found' : 'not found'}`);
  log(`  cambot-core.sqlite:    ${hasCore ? 'found' : 'not found'}`);
  log(`  cambot-ui-logs.sqlite: ${hasLogs ? 'found' : 'not found'}`);

  // Step 1: Create target database with unified schema
  log('\nCreating target database with unified schema...');
  const target = new Database(TARGET_DB);
  target.pragma('journal_mode = WAL');
  target.pragma('foreign_keys = OFF'); // Disable during migration
  target.pragma('busy_timeout = 5000');
  target.pragma('synchronous = NORMAL');
  target.pragma('cache_size = -64000');

  // Load sqlite-vec if available
  try {
    target.loadExtension('vec0');
    log('  sqlite-vec loaded (vec0)');
  } catch {
    try {
      target.loadExtension('sqlite-vec');
      log('  sqlite-vec loaded (sqlite-vec)');
    } catch {
      log('  sqlite-vec not available (vector search will be disabled)');
    }
  }

  const schema = createSchemaManager();
  schema.initialize(target);
  log('  Schema initialized (version ' + schema.getSchemaVersion(target) + ')');

  // Step 2: Copy data from cambot-core.sqlite (main memory/telemetry DB)
  if (hasCore) {
    log('\nMigrating cambot-core.sqlite...');
    const core = new Database(CORE_DB, { readonly: true });

    const coreTables = getTableNames(core);
    const skipTables = new Set(['schema_migrations', 'meta', 'facts_fts', 'fact_embeddings']);

    for (const table of coreTables) {
      if (skipTables.has(table)) {
        log(`  ${table}: skipped (managed by schema manager)`);
        continue;
      }
      if (isVirtualOrShadowTable(core, table)) {
        log(`  ${table}: skipped (virtual table)`);
        continue;
      }
      copyTableData(core, target, table, table);
    }

    // Copy meta values (except schema_version which is managed)
    const metaRows = core.prepare(
      "SELECT key, value FROM meta WHERE key != 'schema_version'"
    ).all() as Array<{ key: string; value: string }>;
    for (const { key, value } of metaRows) {
      target.prepare(
        'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'
      ).run(key, value);
    }
    log(`  meta: ${metaRows.length} values`);

    // Copy schema_migrations records
    const migrations = core.prepare('SELECT * FROM schema_migrations').all() as Array<{
      version: number; name: string; applied_at: string; checksum: string;
    }>;
    for (const m of migrations) {
      target.prepare(
        'INSERT OR IGNORE INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)'
      ).run(m.version, m.name, m.applied_at, m.checksum);
    }
    log(`  schema_migrations: ${migrations.length} records`);

    // Copy vec0 embeddings if they exist
    try {
      const embeddings = core.prepare('SELECT fact_id, embedding FROM fact_embeddings').all() as Array<{
        fact_id: number; embedding: Buffer;
      }>;
      if (embeddings.length > 0) {
        const insertEmb = target.prepare('INSERT OR IGNORE INTO fact_embeddings (fact_id, embedding) VALUES (?, ?)');
        const batchEmb = target.transaction((data: typeof embeddings) => {
          for (const row of data) {
            insertEmb.run(row.fact_id, row.embedding);
          }
        });
        batchEmb(embeddings);
        log(`  fact_embeddings: ${embeddings.length} vectors`);
      }
    } catch {
      log('  fact_embeddings: skipped (table not available)');
    }

    core.close();
  }

  // Step 3: Copy data from messages.db (agent tables)
  if (hasMessages) {
    log('\nMigrating messages.db...');
    const messages = new Database(MESSAGES_DB, { readonly: true });

    const msgTables = getTableNames(messages);
    const renameMap: Record<string, string> = {
      sessions: 'auth_sessions', // Rename to avoid conflict with core sessions
    };

    // Tables that already exist in core (skip)
    const coreOwnedTables = new Set(['meta', 'schema_migrations']);

    for (const table of msgTables) {
      if (coreOwnedTables.has(table)) {
        log(`  ${table}: skipped (core-owned)`);
        continue;
      }
      const targetTable = renameMap[table] ?? table;
      copyTableData(messages, target, table, targetTable);
    }

    messages.close();
  }

  // Step 4: Copy logs from cambot-ui-logs.sqlite
  if (hasLogs) {
    log('\nMigrating cambot-ui-logs.sqlite...');
    const logs = new Database(LOGS_DB, { readonly: true });

    try {
      copyTableData(logs, target, 'logs', 'logs');
    } catch (err) {
      log(`  logs: failed (${err instanceof Error ? err.message : String(err)})`);
    }

    logs.close();
  }

  // Step 5: Rebuild FTS5 index
  log('\nRebuilding FTS5 index...');
  try {
    target.prepare("INSERT INTO facts_fts(facts_fts) VALUES('rebuild')").run();
    log('  FTS5 rebuild complete');
  } catch (err) {
    log(`  FTS5 rebuild: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 6: Re-enable foreign keys and verify
  target.pragma('foreign_keys = ON');

  log('\nVerifying target database...');
  const issues = schema.verify(target);
  if (issues.length > 0) {
    log('  Verification issues:');
    for (const issue of issues) {
      log(`    - ${issue}`);
    }
  } else {
    log('  All checks passed');
  }

  const targetTables = getTableNames(target);
  log(`  Total tables: ${targetTables.length}`);

  // Purge old logs (30-day retention)
  try {
    const purged = target.prepare(
      `DELETE FROM logs WHERE timestamp < datetime('now', '-30 days')`
    ).run();
    if (purged.changes > 0) {
      log(`  Purged ${purged.changes} old log entries`);
    }
  } catch { /* logs table may not have data */ }

  target.close();

  // Step 7: Rename source databases to .bak
  log('\nRenaming source databases to .bak...');
  const renameDb = (p: string) => {
    if (!dbExists(p)) return;
    const bak = p + '.bak';
    try {
      if (dbExists(bak)) fs.unlinkSync(bak);
      fs.renameSync(p, bak);
      // Also rename WAL/SHM files if present
      for (const ext of ['-wal', '-shm']) {
        if (dbExists(p + ext)) {
          const bakExt = bak + ext;
          if (dbExists(bakExt)) fs.unlinkSync(bakExt);
          fs.renameSync(p + ext, bakExt);
        }
      }
      log(`  ${path.basename(p)} → ${path.basename(bak)}`);
    } catch (err) {
      log(`  ${path.basename(p)}: rename failed (${err instanceof Error ? err.message : String(err)})`);
      log(`    You can manually rename or delete it later.`);
    }
  };

  renameDb(MESSAGES_DB);
  renameDb(CORE_DB);
  renameDb(LOGS_DB);

  // Delete empty cambot-agent.db
  const agentDb = path.join(STORE_DIR, 'cambot-agent.db');
  if (dbExists(agentDb)) {
    try {
      fs.unlinkSync(agentDb);
      log('  Deleted empty cambot-agent.db');
    } catch {
      log('  cambot-agent.db: delete failed (file in use). Remove manually.');
    }
  }

  log('\n=== Migration complete ===');
  log(`Unified database: ${TARGET_DB}`);
  log('Source databases preserved as .bak files for rollback.');
  log('After verifying everything works, you can delete the .bak files.');
}

main();
