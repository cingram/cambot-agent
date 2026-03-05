#!/usr/bin/env tsx
import { applyUpdate, previewUpdate } from '../skills-engine/update.js';

// Parse CLI flags
const args = process.argv.slice(2);
let jsonMode = false;
let previewOnly = false;
let newCorePath: string | undefined;

for (const arg of args) {
  if (arg === '--json') {
    jsonMode = true;
  } else if (arg === '--preview-only') {
    previewOnly = true;
  } else if (!arg.startsWith('-')) {
    newCorePath = arg;
  }
}

if (!newCorePath) {
  console.error('Usage: tsx scripts/update-core.ts [--json] [--preview-only] <path-to-new-core>');
  process.exit(1);
}

// Preview
const preview = previewUpdate(newCorePath);

if (previewOnly) {
  if (jsonMode) {
    console.log(JSON.stringify(preview, null, 2));
  } else {
    console.log('=== Update Preview ===');
    console.log(`Current version: ${preview.currentVersion}`);
    console.log(`New version:     ${preview.newVersion}`);
    console.log(`Files changed:   ${preview.filesChanged.length}`);
    if (preview.filesChanged.length > 0) {
      for (const f of preview.filesChanged) {
        console.log(`  ${f}`);
      }
    }
    if (preview.conflictRisk.length > 0) {
      console.log(`Conflict risk:   ${preview.conflictRisk.join(', ')}`);
    }
    if (preview.customPatchesAtRisk.length > 0) {
      console.log(`Custom patches at risk: ${preview.customPatchesAtRisk.join(', ')}`);
    }
  }
  process.exit(0);
}

// Apply
if (!jsonMode) {
  console.log('=== Update Preview ===');
  console.log(`Current version: ${preview.currentVersion}`);
  console.log(`New version:     ${preview.newVersion}`);
  console.log(`Files changed:   ${preview.filesChanged.length}`);
  if (preview.filesChanged.length > 0) {
    for (const f of preview.filesChanged) {
      console.log(`  ${f}`);
    }
  }
  if (preview.conflictRisk.length > 0) {
    console.log(`Conflict risk:   ${preview.conflictRisk.join(', ')}`);
  }
  if (preview.customPatchesAtRisk.length > 0) {
    console.log(`Custom patches at risk: ${preview.customPatchesAtRisk.join(', ')}`);
  }
  console.log('');
  console.log('Applying update...');
}

const result = await applyUpdate(newCorePath);

if (jsonMode) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(JSON.stringify(result, null, 2));
}

if (!result.success) {
  process.exit(1);
}
