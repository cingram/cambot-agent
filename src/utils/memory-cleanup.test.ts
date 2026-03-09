import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { cleanupSdkMemory } from './memory-cleanup.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cambot-memory-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('cleanupSdkMemory', () => {
  it('removes memory directory contents', () => {
    const memoryDir = path.join(tmpDir, 'test-agent', '.claude', 'projects', '-workspace-group', 'memory');
    fs.mkdirSync(memoryDir, { recursive: true });
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Test memory');
    fs.writeFileSync(path.join(memoryDir, 'notes.md'), 'Some notes');

    cleanupSdkMemory('test-agent', tmpDir);

    expect(fs.existsSync(memoryDir)).toBe(false);
  });

  it('is a no-op when dir does not exist', () => {
    // Should not throw
    expect(() => cleanupSdkMemory('nonexistent-agent', tmpDir)).not.toThrow();
  });
});
