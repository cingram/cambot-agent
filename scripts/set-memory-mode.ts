/**
 * Switch the MEMORY_MODE in .env and manage memory.md backup/restore per group.
 *
 * Usage: bun run scripts/set-memory-mode.ts <markdown|database|both>
 */
import fs from 'fs';
import path from 'path';

const VALID_MODES = ['markdown', 'database', 'both'] as const;
type MemoryMode = (typeof VALID_MODES)[number];

const PROJECT_ROOT = process.cwd();
const ENV_PATH = path.join(PROJECT_ROOT, '.env');
const GROUPS_DIR = path.join(PROJECT_ROOT, 'groups');

function updateEnvFile(mode: MemoryMode): void {
  let content: string;
  try {
    content = fs.readFileSync(ENV_PATH, 'utf-8');
  } catch {
    content = '';
  }

  const memoryModeLine = `MEMORY_MODE=${mode}`;
  const lines = content.split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith('MEMORY_MODE='));

  if (idx !== -1) {
    lines[idx] = memoryModeLine;
  } else {
    // Add after last non-empty line
    lines.push('', '# Memory mode: markdown (flat files only), database (SQLite facts only), both (default)');
    lines.push(memoryModeLine);
  }

  fs.writeFileSync(ENV_PATH, lines.join('\n'));
  console.log(`Updated .env: MEMORY_MODE=${mode}`);
}

function getGroupDirs(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  return fs
    .readdirSync(GROUPS_DIR)
    .filter((d) => {
      const full = path.join(GROUPS_DIR, d);
      return fs.statSync(full).isDirectory() && d !== 'global';
    });
}

function backupMemoryFiles(): void {
  for (const group of getGroupDirs()) {
    const memoryPath = path.join(GROUPS_DIR, group, 'memory.md');
    const backupPath = memoryPath + '.bak';

    if (fs.existsSync(memoryPath)) {
      fs.renameSync(memoryPath, backupPath);
      console.log(`  ${group}: memory.md -> memory.md.bak`);
    } else {
      console.log(`  ${group}: no memory.md (skipped)`);
    }
  }
}

function restoreMemoryFiles(): void {
  for (const group of getGroupDirs()) {
    const memoryPath = path.join(GROUPS_DIR, group, 'memory.md');
    const backupPath = memoryPath + '.bak';

    if (fs.existsSync(backupPath)) {
      fs.renameSync(backupPath, memoryPath);
      console.log(`  ${group}: memory.md.bak -> memory.md`);
    } else {
      console.log(`  ${group}: no backup to restore (skipped)`);
    }
  }
}

function main(): void {
  const mode = process.argv[2] as MemoryMode | undefined;

  if (!mode || !VALID_MODES.includes(mode)) {
    console.error(`Usage: bun run scripts/set-memory-mode.ts <${VALID_MODES.join('|')}>`);
    process.exit(1);
  }

  console.log(`\nSwitching memory mode to: ${mode}\n`);

  updateEnvFile(mode);

  switch (mode) {
    case 'database':
      console.log('\nBacking up memory.md files (database-only mode):');
      backupMemoryFiles();
      break;

    case 'markdown':
    case 'both':
      console.log('\nRestoring memory.md files:');
      restoreMemoryFiles();
      break;
  }

  console.log('\nRestart the agent to apply.');
}

main();
