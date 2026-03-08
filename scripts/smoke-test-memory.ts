/**
 * Smoke test: verify memory_query works end-to-end against the live database.
 *
 * Tests both the host-side memory context builder and direct search engine
 * to confirm no timeouts occur after cambot-core changes.
 *
 * Usage: npx tsx scripts/smoke-test-memory.ts
 */

import Database from 'better-sqlite3';
import path from 'path';
import {
  createSearchEngine,
  createQueryContextBuilder,
  createFactLinkStore,
  createAccessTracker,
  createFactDecayService,
  loadSqliteVec,
} from 'cambot-core';

const STORE_DIR = path.resolve(process.cwd(), 'store');
const DB_PATH = path.join(STORE_DIR, 'cambot.sqlite');

async function main() {
  console.log('=== Memory Smoke Test ===\n');

  // 1. Open the database read-only
  console.log(`Opening database: ${DB_PATH}`);
  const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
  db.pragma('journal_mode = WAL');
  loadSqliteVec(db);

  const factCount = (db.prepare('SELECT COUNT(*) as cnt FROM facts WHERE is_active = 1').get() as any).cnt;
  console.log(`Active facts: ${factCount}\n`);

  // 2. Test search engine (FTS + SQL only, no vector — readonly DB can't embed)
  console.log('--- Test 1: Search Engine (FTS + SQL) ---');
  const searchEngine = createSearchEngine(null); // null = no embedding service
  const factDecay = createFactDecayService();
  const accessTracker = createAccessTracker(factDecay);

  const queries = ['Cameron', 'project', 'preferences'];

  for (const q of queries) {
    const start = Date.now();
    const results = await searchEngine.search(db, {
      text: q,
      modes: ['fts', 'sql'],
      limit: 10,
    });
    const elapsed = Date.now() - start;
    console.log(`  "${q}" → ${results.length} results (${elapsed}ms)`);
    if (results.length > 0) {
      console.log(`    Top: [${results[0].fact.type}] ${results[0].fact.content.slice(0, 80)}...`);
    }
  }

  // 3. Test query context builder (what host-side memory-context.ts uses)
  console.log('\n--- Test 2: Query Context Builder ---');
  const factLinkStore = createFactLinkStore();
  const contextBuilder = createQueryContextBuilder(searchEngine, factLinkStore);

  for (const q of queries) {
    const start = Date.now();
    const result = await contextBuilder.build(db, q);
    const elapsed = Date.now() - start;
    const contextLen = result.context?.length ?? 0;
    console.log(`  "${q}" → ${result.factIds.length} facts, ${contextLen} chars context (${elapsed}ms)`);
  }

  db.close();
  console.log('\n=== All tests passed ===');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
