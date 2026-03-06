import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createPersistentAgentBootstrap } from './persistent-agent-bootstrap.js';
import type { RegisteredAgent } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────────

let tmpDir: string;

function makeAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'agent-1',
    name: 'Test Agent',
    description: 'A test agent description',
    folder: 'test-agent',
    channels: [],
    mcpServers: [],
    capabilities: [],
    concurrency: 1,
    timeoutMs: 300_000,
    isMain: false,
    agentDefId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  // Create a real temp directory for each test
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cambot-bootstrap-test-'));
});

// ── bootstrapAgent ──────────────────────────────────────────────

describe('bootstrapAgent', () => {
  it('creates folder and CLAUDE.md for a new agent', () => {
    const bootstrap = createPersistentAgentBootstrap(tmpDir);
    const agent = makeAgent({ name: 'My Bot', description: 'Bot description', folder: 'my-bot' });

    bootstrap.bootstrapAgent(agent);

    const agentDir = path.join(tmpDir, 'my-bot');
    expect(fs.existsSync(agentDir)).toBe(true);

    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    expect(fs.existsSync(claudeMdPath)).toBe(true);

    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toBe('# My Bot\n\nBot description\n');
  });

  it('does not overwrite an existing CLAUDE.md', () => {
    const bootstrap = createPersistentAgentBootstrap(tmpDir);
    const agent = makeAgent({ folder: 'existing' });

    // Pre-create the directory and CLAUDE.md with custom content
    const agentDir = path.join(tmpDir, 'existing');
    fs.mkdirSync(agentDir, { recursive: true });
    const claudeMdPath = path.join(agentDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMdPath, 'Custom content\n', 'utf-8');

    bootstrap.bootstrapAgent(agent);

    // Should NOT be overwritten
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toBe('Custom content\n');
  });

  it('creates nested directory structure', () => {
    const bootstrap = createPersistentAgentBootstrap(tmpDir);
    const agent = makeAgent({ folder: 'deep/nested/agent' });

    bootstrap.bootstrapAgent(agent);

    const agentDir = path.join(tmpDir, 'deep', 'nested', 'agent');
    expect(fs.existsSync(agentDir)).toBe(true);
    expect(fs.existsSync(path.join(agentDir, 'CLAUDE.md'))).toBe(true);
  });

  it('is idempotent — calling twice for the same agent is safe', () => {
    const bootstrap = createPersistentAgentBootstrap(tmpDir);
    const agent = makeAgent({ folder: 'idempotent' });

    bootstrap.bootstrapAgent(agent);
    bootstrap.bootstrapAgent(agent);

    const claudeMdPath = path.join(tmpDir, 'idempotent', 'CLAUDE.md');
    expect(fs.existsSync(claudeMdPath)).toBe(true);
  });
});

// ── bootstrapAll ────────────────────────────────────────────────

describe('bootstrapAll', () => {
  it('processes multiple agents', () => {
    const bootstrap = createPersistentAgentBootstrap(tmpDir);
    const agents = [
      makeAgent({ id: 'a1', name: 'Alpha', folder: 'alpha' }),
      makeAgent({ id: 'a2', name: 'Beta', folder: 'beta' }),
      makeAgent({ id: 'a3', name: 'Gamma', folder: 'gamma' }),
    ];

    bootstrap.bootstrapAll(agents);

    for (const agent of agents) {
      const dir = path.join(tmpDir, agent.folder);
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(true);
    }
  });

  it('handles empty agents list without error', () => {
    const bootstrap = createPersistentAgentBootstrap(tmpDir);
    expect(() => bootstrap.bootstrapAll([])).not.toThrow();
  });

  it('preserves existing CLAUDE.md while creating new ones', () => {
    const bootstrap = createPersistentAgentBootstrap(tmpDir);

    // Pre-create one agent's directory with custom CLAUDE.md
    const existingDir = path.join(tmpDir, 'existing-agent');
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, 'CLAUDE.md'), 'Keep me!\n', 'utf-8');

    const agents = [
      makeAgent({ id: 'existing', name: 'Existing', folder: 'existing-agent' }),
      makeAgent({ id: 'new', name: 'New Agent', description: 'Brand new', folder: 'new-agent' }),
    ];

    bootstrap.bootstrapAll(agents);

    // Existing CLAUDE.md should be preserved
    const existingContent = fs.readFileSync(path.join(existingDir, 'CLAUDE.md'), 'utf-8');
    expect(existingContent).toBe('Keep me!\n');

    // New agent should have generated CLAUDE.md
    const newContent = fs.readFileSync(path.join(tmpDir, 'new-agent', 'CLAUDE.md'), 'utf-8');
    expect(newContent).toBe('# New Agent\n\nBrand new\n');
  });
});
