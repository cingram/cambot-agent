#!/usr/bin/env npx tsx
/**
 * Database Maintenance — Run all cleanup, decay, dedup, and optimization.
 *
 * Steps (in order):
 *   1. Fact decay        — age out stale facts (exponential half-life)
 *   2. Fact purge        — remove low-quality facts
 *   3. Entity dedup      — merge duplicate entities (fuzzy token match)
 *   4. Orphan cleanup    — remove dangling junction rows
 *   5. Hard delete       — physically remove inactive facts older than N days
 *   6. FTS rebuild       — rebuild full-text search index
 *   7. VACUUM + ANALYZE  — reclaim space and update query planner stats
 *
 * Usage:
 *   npx tsx scripts/run-maintenance.ts [db-path]
 *   bun run scripts/run-maintenance.ts [db-path]
 */

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import {
  createFactDecayService,
  createFactPurgerService,
  createOrphanCleanerService,
  createFactHardDeleteService,
  createSqliteMaintenanceService,
  runEntityDedup,
  createSchemaManager,
  createEntityStore,
} from 'cambot-core';

// ── Load .env ─────────────────────────────────────────────────────────────

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

const agentRoot = path.resolve(import.meta.dirname, '..');
loadEnvFile(path.join(agentRoot, '.env'));

// ── Database ──────────────────────────────────────────────────────────────

const dbPath = process.argv[2]
  ?? process.env.CAMBOT_DB_PATH
  ?? path.join(agentRoot, 'store', 'cambot.sqlite');

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

console.log(`\n=== CamBot Database Maintenance ===`);
console.log(`Database: ${dbPath}\n`);

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schemaManager = createSchemaManager();
schemaManager.initialize(db);

// ── Pre-flight ────────────────────────────────────────────────────────────

const activeFacts = (db.prepare('SELECT COUNT(*) AS cnt FROM facts WHERE is_active = 1').get() as { cnt: number }).cnt;
const inactiveFacts = (db.prepare('SELECT COUNT(*) AS cnt FROM facts WHERE is_active = 0').get() as { cnt: number }).cnt;
const totalEntities = (db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt;

console.log('Pre-flight:');
console.log(`  Active facts:   ${activeFacts}`);
console.log(`  Inactive facts: ${inactiveFacts}`);
console.log(`  Entities:       ${totalEntities}`);
console.log('');

const INACTIVE_DAYS = 30; // hard-delete facts inactive for 30+ days

// ── Step 1: Fact Decay ────────────────────────────────────────────────────

console.log('[1/8] Running fact decay...');
const decayService = createFactDecayService();
const decayResult = decayService.batchUpdate(db);
console.log(`  Updated: ${decayResult.updated}, Archived: ${decayResult.archived}`);

// ── Step 2: Fact Purge ────────────────────────────────────────────────────

console.log('[2/8] Running fact quality purge...');
const purger = createFactPurgerService();
const purgeResult = purger.runPurge(db);
console.log(`  Scanned: ${purgeResult.scanned}, Rejected: ${purgeResult.rejected}, Accepted: ${purgeResult.accepted}`);
console.log(`  Orphan entities deleted: ${purgeResult.orphanEntitiesDeleted}`);

// ── Step 3: Entity Dedup ──────────────────────────────────────────────────

console.log('[3/8] Running entity dedup...');
const entityStore = createEntityStore();
const entityDedupResult = runEntityDedup(db, entityStore);
console.log(`  Before: ${entityDedupResult.entitiesBefore}, Merged: ${entityDedupResult.merged}, Orphans cleaned: ${entityDedupResult.orphansCleaned}`);

// ── Step 4: Orphan Cleanup ────────────────────────────────────────────────

console.log('[4/8] Cleaning orphaned records...');
const orphanCleaner = createOrphanCleanerService();
const orphanResult = orphanCleaner.cleanAll(db);
console.log(`  Embeddings: ${orphanResult.factEmbeddings}, Entity-facts: ${orphanResult.entityFacts}`);
console.log(`  Sources: ${orphanResult.factSources}, Links: ${orphanResult.factLinks}`);
console.log(`  Reflections: ${orphanResult.reflectionSources}, Access logs: ${orphanResult.factAccessLog}`);
console.log(`  Orphan entities: ${orphanResult.orphanEntities}`);

// ── Step 5: Hard Delete ───────────────────────────────────────────────────

console.log(`[5/8] Hard-deleting facts inactive for ${INACTIVE_DAYS}+ days...`);
const hardDeleter = createFactHardDeleteService();
const hardDeleteResult = hardDeleter.deleteInactiveFacts(db, INACTIVE_DAYS);
console.log(`  Facts: ${hardDeleteResult.factsDeleted}, Embeddings: ${hardDeleteResult.embeddingsCleaned}`);

// ── Step 6: FTS Rebuild ───────────────────────────────────────────────────

console.log('[6/8] Rebuilding full-text search index...');
const sqliteMaint = createSqliteMaintenanceService();
const ftsResult = sqliteMaint.ftsRebuild(db);
console.log(`  Duration: ${ftsResult.durationMs}ms`);

// ── Step 7: VACUUM + ANALYZE ──────────────────────────────────────────────

console.log('[7/8] Running VACUUM and ANALYZE...');
const analyzeResult = sqliteMaint.analyze(db);
console.log(`  ANALYZE: ${analyzeResult.durationMs}ms`);
const vacuumResult = sqliteMaint.vacuum(db);
const sizeMB = (n: number) => (n / 1024 / 1024).toFixed(1) + 'MB';
console.log(`  VACUUM: ${vacuumResult.durationMs}ms (${sizeMB(vacuumResult.sizeBefore)} → ${sizeMB(vacuumResult.sizeAfter)})`);

// ── Step 8: Backup ──────────────────────────────────────────────────────

console.log('[8/8] Creating database backup...');
const backupDir = path.join(path.dirname(dbPath), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = path.join(backupDir, `cambot-${timestamp}.sqlite`);
db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
const backupSize = fs.statSync(backupPath).size;
console.log(`  Backup: ${backupPath} (${sizeMB(backupSize)})`);

// Rotate — keep 7 most recent
const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.sqlite')).sort().reverse();
let rotated = 0;
for (let i = 7; i < backups.length; i++) {
  fs.unlinkSync(path.join(backupDir, backups[i]));
  rotated++;
}
if (rotated) console.log(`  Rotated: ${rotated} old backups removed`);

// ── Post-flight ───────────────────────────────────────────────────────────

const finalActive = (db.prepare('SELECT COUNT(*) AS cnt FROM facts WHERE is_active = 1').get() as { cnt: number }).cnt;
const finalInactive = (db.prepare('SELECT COUNT(*) AS cnt FROM facts WHERE is_active = 0').get() as { cnt: number }).cnt;
const finalEntities = (db.prepare('SELECT COUNT(*) AS cnt FROM entities').get() as { cnt: number }).cnt;

console.log('\nPost-flight:');
console.log(`  Active facts:   ${finalActive} (was ${activeFacts})`);
console.log(`  Inactive facts: ${finalInactive} (was ${inactiveFacts})`);
console.log(`  Entities:       ${finalEntities} (was ${totalEntities})`);

db.close();
console.log('\nDone.');
