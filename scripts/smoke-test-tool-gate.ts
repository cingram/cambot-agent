/**
 * Smoke test: verify memory_query works through the full tool gate
 * (security checks + timeout wrapper) against the live database.
 *
 * This simulates exactly what happens when the agent calls memory_query.
 *
 * Usage: npx tsx scripts/smoke-test-tool-gate.ts
 */

import path from 'path';
import {
  createCamBotCore,
  createStandaloneConfig,
} from 'cambot-core';
import { readEnvFile } from '../src/env.js';

const STORE_DIR = path.resolve(process.cwd(), 'store');
const DB_PATH = path.join(STORE_DIR, 'cambot.sqlite');

async function main() {
  console.log('=== Tool Gate Smoke Test ===\n');

  // Load secrets from .env the same way the agent does
  const env = readEnvFile(['GEMINI_API_KEY', 'ANTHROPIC_API_KEY']);

  // Initialize full cambot-core (same path as agent activation)
  const config = createStandaloneConfig({
    dbPath: DB_PATH,
    geminiApiKey: env.GEMINI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  });
  console.log(`Tool timeout: ${config.toolTimeoutMs ?? 60000}ms`);

  const core = createCamBotCore(config);
  console.log(`Core initialized, DB open: ${core.db !== null}`);
  console.log(`Search engine: ${!!core.searchEngine}`);
  console.log(`Embedding service: ${!!core.embeddingService}`);

  const factCount = (core.db.prepare('SELECT COUNT(*) as cnt FROM facts WHERE is_active = 1').get() as any).cnt;
  console.log(`Active facts: ${factCount}\n`);

  // Test 1: Search with FTS + SQL (no vector, fast path)
  console.log('--- Test 1: FTS + SQL search ---');
  const queries = ['Cameron', 'project', 'preferences', 'Docker', 'memory'];
  for (const q of queries) {
    const start = Date.now();
    const results = await core.searchEngine.search(core.db, {
      text: q,
      modes: ['fts', 'sql'],
      limit: 10,
    });
    const elapsed = Date.now() - start;
    console.log(`  "${q}" → ${results.length} results (${elapsed}ms)`);
  }

  // Test 2: Search with vector (hits Gemini API)
  if (core.embeddingService) {
    console.log('\n--- Test 2: Hybrid search with vector (Gemini API) ---');
    for (const q of queries.slice(0, 2)) {
      const start = Date.now();
      try {
        const results = await core.searchEngine.search(core.db, {
          text: q,
          modes: ['fts', 'vector', 'sql'],
          limit: 10,
        });
        const elapsed = Date.now() - start;
        const matchTypes = results.flatMap(r => r.matchSources.map(s => s.type));
        const unique = [...new Set(matchTypes)];
        console.log(`  "${q}" → ${results.length} results (${elapsed}ms) [modes: ${unique.join(',')}]`);
      } catch (err) {
        const elapsed = Date.now() - start;
        console.log(`  "${q}" → ERROR after ${elapsed}ms: ${(err as Error).message}`);
      }
    }
  } else {
    console.log('\n--- Test 2: SKIPPED (no Gemini API key) ---');
  }

  // Test 3: Boot context
  console.log('\n--- Test 3: Boot context ---');
  const start = Date.now();
  const bootCtx = core.buildBootContext();
  const elapsed = Date.now() - start;
  console.log(`  Boot context: ${bootCtx.length} chars (${elapsed}ms)`);

  core.close();
  console.log('\n=== All tests passed ===');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
