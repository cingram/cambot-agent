/**
 * Quick script to dump the assembled context for debugging.
 * Usage: npx tsx scripts/check-context.ts
 */
import path from 'path';
import fs from 'fs';
import { createCamBotCore, createStandaloneConfig } from 'cambot-core';
import { readEnvFile } from '../src/env.js';

const OUT = path.join(process.cwd(), 'context-dump.txt');

try {
  const env = readEnvFile(['GEMINI_API_KEY', 'ANTHROPIC_API_KEY']);

  const config = createStandaloneConfig({
    dbPath: path.resolve('store/cambot.sqlite'),
    geminiApiKey: env.GEMINI_API_KEY,
    anthropicApiKey: env.ANTHROPIC_API_KEY,
  });

  const core = createCamBotCore(config);

  async function main() {
    const bootCtx = await core.buildContext();
    const queryCtx = await core.buildContext('What does Cameron like?');

    const output = [
      '=== BOOT CONTEXT (no query) ===',
      bootCtx,
      `--- ${bootCtx.length} chars ---`,
      '',
      '=== QUERY CONTEXT (What does Cameron like?) ===',
      queryCtx,
      `--- ${queryCtx.length} chars ---`,
    ].join('\n');

    fs.writeFileSync(OUT, output);
    console.log('Written to ' + OUT + ' (' + output.length + ' chars total)');
    core.close();
  }

  main().catch(e => {
    console.error('Error in main:', e);
    core.close();
    process.exit(1);
  });
} catch (e) {
  console.error('Init error:', e);
  process.exit(1);
}
