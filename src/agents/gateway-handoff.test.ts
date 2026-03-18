import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';

import { createPersistentAgentSpawner, type PersistentAgentSpawnerDeps, type ContainerSpawner } from './persistent-agent-spawner.js';
import type { GatewayRouter, AgentRegistryEntry } from './gateway-router.js';
import { scoreRoute, scoreContinuation } from './gateway-router.js';
import { createHandoffRepository, type HandoffRepository } from '../db/handoff-repository.js';
import type { RegisteredAgent, MessageBus } from '../types.js';

// Mock dependencies
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config/config.js', () => ({
  HANDOFF_IDLE_TIMEOUT_MS: 600_000,
  HANDOFF_FREE_TURNS: 3,
  HANDOFF_REEVAL_INTERVAL: 4,
  HANDOFF_CONFIDENCE_THRESHOLD: 0.7,
  GATEWAY_PRESET: 'gateway',
}));

// Mock local scoring to return low confidence by default (forces API path).
// Individual tests can override via mockReturnValueOnce.
vi.mock('./gateway-router.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    scoreRoute: vi.fn(() => ({ confidence: 0, decision: { action: 'delegate' } })),
    scoreContinuation: vi.fn(() => ({ confidence: 0, decision: { action: 'continue' } })),
  };
});

vi.mock('../container/runner.js', () => ({
  runContainerAgent: vi.fn(),
}));

vi.mock('../container/runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
}));

vi.mock('../tools/tool-policy.js', () => ({
  resolveToolList: vi.fn(() => []),
  resolveDisallowedTools: vi.fn(() => []),
  resolveMcpToolList: vi.fn(() => []),
  applySafetyDenials: vi.fn(() => []),
  qualifyMcpToolList: vi.fn(() => []),
}));

vi.mock('../utils/memory-cleanup.js', () => ({
  cleanupSdkMemory: vi.fn(),
}));

vi.mock('../db/conversation-repository.js', () => ({
  resolveActiveConversation: vi.fn(() => ({
    conversation: { id: 'conv-1', sessionId: null },
    isTransient: true,
    rotatedFrom: null,
  })),
  setConversationSession: vi.fn(),
  updatePreview: vi.fn(),
}));

vi.mock('../utils/channel-from-jid.js', () => ({
  channelFromJid: vi.fn((jid: string) => {
    if (jid?.startsWith('web:')) return 'web';
    if (jid?.startsWith('cli:')) return 'cli';
    return 'unknown';
  }),
}));

// ── Helpers ──────────────────────────────────────────────────

function createTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS handoff_sessions (
      id           TEXT PRIMARY KEY,
      channel      TEXT NOT NULL,
      chat_jid     TEXT NOT NULL,
      gateway_id   TEXT NOT NULL,
      active_agent TEXT NOT NULL,
      intent       TEXT,
      turn_count   INTEGER NOT NULL DEFAULT 1,
      task_context TEXT,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      expires_at   TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_handoff_lookup
      ON handoff_sessions(channel, chat_jid, gateway_id);
    CREATE INDEX IF NOT EXISTS idx_handoff_expires
      ON handoff_sessions(expires_at);
  `);
}

function makeGatewayAgent(overrides: Partial<RegisteredAgent> = {}): RegisteredAgent {
  return {
    id: 'gateway-1',
    name: 'Gateway',
    description: 'Routes requests',
    folder: 'gateway',
    channels: ['web'],
    mcpServers: [],
    capabilities: [],
    concurrency: 1,
    timeoutMs: 30_000,
    isMain: false,
    system: false,
    provider: 'claude',
    model: 'claude-haiku-4-5-20251001',
    secretKeys: [],
    tools: [],
    skills: [],
    systemPrompt: null,
    soul: null,
    temperature: null,
    maxTokens: null,
    baseUrl: null,
    toolPolicy: { preset: 'gateway' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  } as RegisteredAgent;
}

function makeTargetAgent(id: string): RegisteredAgent {
  return {
    id,
    name: `Agent ${id}`,
    description: `Handles ${id} tasks`,
    folder: id,
    channels: [],
    mcpServers: [],
    capabilities: [],
    concurrency: 1,
    timeoutMs: 300_000,
    isMain: false,
    system: false,
    provider: 'claude',
    model: 'claude-sonnet-4-6',
    secretKeys: [],
    tools: [],
    skills: [],
    systemPrompt: null,
    soul: null,
    temperature: null,
    maxTokens: null,
    baseUrl: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as RegisteredAgent;
}

function makeRegistry(): AgentRegistryEntry[] {
  return [
    { id: 'gateway-1', name: 'Gateway', description: 'Routes', capabilities: [] },
    { id: 'email-agent', name: 'Email', description: 'Email management', capabilities: ['email'] },
    { id: 'search-agent', name: 'Search', description: 'Web search', capabilities: ['WebSearch'] },
  ];
}

let db: Database.Database;
let handoffRepo: HandoffRepository;
let mockRouter: GatewayRouter;
let mockBus: MessageBus;
let agentMap: Map<string, RegisteredAgent>;

beforeEach(() => {
  db = new Database(':memory:');
  createTable(db);
  handoffRepo = createHandoffRepository(db);

  agentMap = new Map();
  agentMap.set('email-agent', makeTargetAgent('email-agent'));
  agentMap.set('search-agent', makeTargetAgent('search-agent'));

  mockBus = {
    emit: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as MessageBus;

  mockRouter = {
    route: vi.fn(),
    classifyContinuation: vi.fn(),
  } as unknown as GatewayRouter;
});

function createSpawner(): ContainerSpawner {
  const deps: PersistentAgentSpawnerDeps = {
    getActiveMcpServers: () => [],
    getAgentOptions: () => ({ secretKeys: [], image: 'test', timeout: 300_000 }) as any,
    messageBus: mockBus,
    getTemplateValue: () => undefined,
    assembleContext: () => '',
    gatewayRouter: mockRouter,
    getAgentRegistry: makeRegistry,
    getAgentById: (id) => agentMap.get(id),
    handoffRepo,
  };

  return createPersistentAgentSpawner(deps);
}

// ── Integration Tests ────────────────────────────────────────

describe('gateway handoff', () => {
  const gateway = makeGatewayAgent();
  const callerGroup = 'web:ui';

  it('creates handoff session on delegate', async () => {
    (mockRouter.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'delegate',
      targetAgent: 'email-agent',
      prompt: 'Organize your inbox from last week',
    });

    const spawner = createSpawner();
    // The spawner will try to spawn the target agent which will fail (no container)
    // but we only care about the handoff session being created
    try {
      await spawner.spawn(gateway, 'organize my inbox', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail in test
    }

    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1');
    expect(session).toBeDefined();
    expect(session!.activeAgent).toBe('email-agent');
    expect(session!.intent).toBe('Organize your inbox from last week');
    expect(session!.turnCount).toBe(1);
  });

  it('does NOT create handoff on respond', async () => {
    (mockRouter.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'respond',
      response: 'Hello! How can I help you?',
    });

    const spawner = createSpawner();
    const result = await spawner.spawn(gateway, 'hello', callerGroup, 30_000);

    expect(result.status).toBe('success');
    expect(result.content).toBe('Hello! How can I help you?');

    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1');
    expect(session).toBeUndefined();
  });

  it('routes directly to handoff agent on free turns (no API call)', async () => {
    // Pre-create a handoff session
    handoffRepo.upsert({
      channel: 'web',
      chatJid: callerGroup,
      gatewayId: 'gateway-1',
      activeAgent: 'email-agent',
      intent: 'organize inbox',
    });

    const spawner = createSpawner();
    try {
      await spawner.spawn(gateway, 'archive those from last week', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail
    }

    // Should NOT have called route() — handoff bypasses gateway
    expect(mockRouter.route).not.toHaveBeenCalled();
    // Should NOT have called classifyContinuation — still in free turns
    expect(mockRouter.classifyContinuation).not.toHaveBeenCalled();

    // Turn count should be incremented
    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1');
    expect(session!.turnCount).toBe(2);
  });

  it('runs continuation classifier after free turns', async () => {
    // Pre-create a handoff session with 4 turns (past free turns threshold of 3)
    handoffRepo.upsert({
      channel: 'web',
      chatJid: callerGroup,
      gatewayId: 'gateway-1',
      activeAgent: 'email-agent',
      intent: 'organize inbox',
    });
    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1')!;
    // Bump to turn 4
    handoffRepo.incrementTurn(session.id);
    handoffRepo.incrementTurn(session.id);
    handoffRepo.incrementTurn(session.id);

    (mockRouter.classifyContinuation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'continue',
    });

    const spawner = createSpawner();
    try {
      await spawner.spawn(gateway, 'now mark them as read', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail
    }

    // Should have called classifyContinuation
    expect(mockRouter.classifyContinuation).toHaveBeenCalledWith(
      'now mark them as read',
      'email-agent',
      'organize inbox',
    );
    // Should NOT have called route() — continuation said continue
    expect(mockRouter.route).not.toHaveBeenCalled();
  });

  it('clears handoff and re-routes on pivot', async () => {
    // Pre-create handoff session past free turns
    handoffRepo.upsert({
      channel: 'web',
      chatJid: callerGroup,
      gatewayId: 'gateway-1',
      activeAgent: 'email-agent',
      intent: 'organize inbox',
    });
    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1')!;
    handoffRepo.incrementTurn(session.id);
    handoffRepo.incrementTurn(session.id);
    handoffRepo.incrementTurn(session.id);

    (mockRouter.classifyContinuation as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'pivot',
    });
    (mockRouter.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'delegate',
      targetAgent: 'search-agent',
      prompt: 'Search for weather forecast today',
    });

    const spawner = createSpawner();
    try {
      await spawner.spawn(gateway, 'what is the weather today?', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail
    }

    // Old handoff should be cleared, new one created
    const newSession = handoffRepo.findActive('web', callerGroup, 'gateway-1');
    expect(newSession).toBeDefined();
    expect(newSession!.activeAgent).toBe('search-agent');
    expect(newSession!.turnCount).toBe(1);
  });

  it('treats expired handoff as no-handoff (full routing)', async () => {
    // Insert an expired handoff directly
    db.prepare(`
      INSERT INTO handoff_sessions (id, channel, chat_jid, gateway_id, active_agent, intent, expires_at)
      VALUES ('expired-1', 'web', ?, 'gateway-1', 'email-agent', 'old task', datetime('now', '-1 hour'))
    `).run(callerGroup);

    (mockRouter.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'respond',
      response: 'No active session, how can I help?',
    });

    const spawner = createSpawner();
    const result = await spawner.spawn(gateway, 'hello again', callerGroup, 30_000);

    // Should have done full routing (no handoff found)
    expect(mockRouter.route).toHaveBeenCalled();
    expect(result.status).toBe('success');
  });

  it('greeting then task: no handoff on respond, handoff created on delegate', async () => {
    // Step 1: Greeting — respond action, no handoff
    (mockRouter.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'respond',
      response: 'Hello! What can I do for you?',
    });

    const spawner = createSpawner();
    const greetingResult = await spawner.spawn(gateway, 'hello', callerGroup, 30_000);
    expect(greetingResult.status).toBe('success');
    expect(handoffRepo.findActive('web', callerGroup, 'gateway-1')).toBeUndefined();

    // Step 2: Task — delegate action, handoff created
    (mockRouter.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'delegate',
      targetAgent: 'email-agent',
      prompt: 'Organize and categorize inbox emails',
    });

    try {
      await spawner.spawn(gateway, 'organize my inbox', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail
    }

    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1');
    expect(session).toBeDefined();
    expect(session!.activeAgent).toBe('email-agent');
  });

  it('returns error when handoff target agent no longer exists', async () => {
    // Create handoff pointing to non-existent agent
    handoffRepo.upsert({
      channel: 'web',
      chatJid: callerGroup,
      gatewayId: 'gateway-1',
      activeAgent: 'deleted-agent',
      intent: 'task',
    });

    const spawner = createSpawner();
    const result = await spawner.spawn(gateway, 'follow up', callerGroup, 30_000);

    expect(result.status).toBe('error');
    expect(result.content).toContain('deleted-agent');

    // Handoff should be cleared
    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1');
    expect(session).toBeUndefined();
  });

  it('uses local scoring when confidence is above threshold (skips API)', async () => {
    // Make local scorer return high confidence
    (scoreRoute as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      confidence: 0.85,
      decision: {
        action: 'delegate',
        targetAgent: 'email-agent',
        prompt: 'check my inbox for unread emails',
      },
    });

    const spawner = createSpawner();
    try {
      await spawner.spawn(gateway, 'check my inbox for unread emails', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail
    }

    // API route() should NOT have been called — local scoring was confident enough
    expect(mockRouter.route).not.toHaveBeenCalled();

    // Handoff session should still be created
    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1');
    expect(session).toBeDefined();
    expect(session!.activeAgent).toBe('email-agent');
  });

  it('uses local continuation scoring when confident (skips API)', async () => {
    // Pre-create handoff past free turns
    handoffRepo.upsert({
      channel: 'web',
      chatJid: callerGroup,
      gatewayId: 'gateway-1',
      activeAgent: 'email-agent',
      intent: 'organize inbox',
    });
    const session = handoffRepo.findActive('web', callerGroup, 'gateway-1')!;
    handoffRepo.incrementTurn(session.id);
    handoffRepo.incrementTurn(session.id);
    handoffRepo.incrementTurn(session.id);

    // Make local continuation scorer return high confidence
    (scoreContinuation as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      confidence: 0.92,
      decision: { action: 'continue' },
    });

    const spawner = createSpawner();
    try {
      await spawner.spawn(gateway, 'yes do it', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail
    }

    // API classifyContinuation should NOT have been called
    expect(mockRouter.classifyContinuation).not.toHaveBeenCalled();
  });

  it('defers to API when local scoring is below threshold', async () => {
    // Default mock returns confidence 0 — should defer to API
    (mockRouter.route as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      action: 'delegate',
      targetAgent: 'email-agent',
      prompt: 'Handle this ambiguous request about email and weather',
    });

    const spawner = createSpawner();
    try {
      await spawner.spawn(gateway, 'find that email about the weather report', callerGroup, 30_000);
    } catch {
      // Container spawn expected to fail
    }

    // Low confidence → should have called the API
    expect(mockRouter.route).toHaveBeenCalled();
  });
});
