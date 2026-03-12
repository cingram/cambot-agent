import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';

import { CommandRegistry } from './registry.js';
import { registerNotificationHandlers } from './notification.js';
import { FRAME_TYPES } from '../protocol/types.js';
import {
  createNotificationRepository,
  type NotificationRepository,
} from '../../db/notification-repository.js';
import type { SocketFrame } from '../protocol/types.js';
import type { CambotSocketConnection, ConnectionIdentity } from '../connection.js';
import type { SocketDeps } from '../deps.js';

// ── Mocks ────────────────────────────────────────────────────

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ──────────────────────────────────────────────────

let db: Database.Database;
let notificationRepo: NotificationRepository;

function createMockDeps(overrides: Partial<SocketDeps> = {}): SocketDeps {
  return {
    bus: { emit: vi.fn() } as any,
    registeredGroups: vi.fn().mockReturnValue({}),
    registerGroup: vi.fn(),
    syncGroupMetadata: vi.fn(),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
    resolveAgentImage: vi.fn(),
    getAgentDefinition: vi.fn(),
    notificationRepo,
    ...overrides,
  };
}

function createMockConnection(identity: ConnectionIdentity): CambotSocketConnection {
  return {
    identity,
    reply: vi.fn(),
    replyError: vi.fn(),
    send: vi.fn(),
    isAlive: vi.fn().mockReturnValue(true),
    close: vi.fn(),
    socket: {} as any,
  } as unknown as CambotSocketConnection;
}

function makeFrame(type: string, payload: unknown = {}, id = 'frame-1'): SocketFrame {
  return { id, type, payload };
}

function mainConnection(): CambotSocketConnection {
  return createMockConnection({ group: 'main', isMain: true });
}

function agentConnection(group = 'email-agent'): CambotSocketConnection {
  return createMockConnection({ group, isMain: false });
}

// ── Setup ────────────────────────────────────────────────────

beforeEach(() => {
  db = new Database(':memory:');
  notificationRepo = createNotificationRepository(db);
  notificationRepo.ensureTable();
});

// ── Tests ────────────────────────────────────────────────────

describe('notification.submit', () => {
  it('inserts a notification from any agent', async () => {
    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = agentConnection('email-agent');
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_SUBMIT, {
      category: 'email-priority',
      summary: '3 urgent emails',
      priority: 'high',
    });

    await registry.dispatch(frame, conn);

    expect(conn.reply).toHaveBeenCalledWith(
      frame,
      FRAME_TYPES.NOTIFICATION_RESULT,
      expect.objectContaining({ status: 'ok' }),
    );

    // Verify it was actually stored
    const pending = notificationRepo.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].sourceAgent).toBe('email-agent');
    expect(pending[0].category).toBe('email-priority');
    expect(pending[0].priority).toBe('high');
    expect(pending[0].summary).toBe('3 urgent emails');
  });

  it('uses source agent from connection identity', async () => {
    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = agentConnection('research-agent');
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_SUBMIT, {
      category: 'monitoring',
      summary: 'alert',
    });

    await registry.dispatch(frame, conn);

    const pending = notificationRepo.getPending();
    expect(pending[0].sourceAgent).toBe('research-agent');
  });

  it('returns error when repo not configured', async () => {
    const deps = createMockDeps({ notificationRepo: undefined });
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = agentConnection();
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_SUBMIT, {
      category: 'cat',
      summary: 'test',
    });

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'NOT_AVAILABLE',
      expect.any(String),
    );
  });
});

describe('notification.get', () => {
  it('returns pending notifications for main group', async () => {
    notificationRepo.insert({
      sourceAgent: 'email-agent',
      category: 'email-priority',
      summary: 'urgent emails',
      priority: 'high',
    });
    notificationRepo.insert({
      sourceAgent: 'scheduler',
      category: 'workflow-failure',
      summary: 'backup failed',
      priority: 'critical',
    });

    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = mainConnection();
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_GET, {});

    await registry.dispatch(frame, conn);

    expect(conn.reply).toHaveBeenCalledWith(
      frame,
      FRAME_TYPES.NOTIFICATION_RESULT,
      expect.objectContaining({ status: 'ok' }),
    );

    const result = JSON.parse(
      (conn.reply as any).mock.calls[0][2].result,
    );
    expect(result).toHaveLength(2);
    // critical should come first
    expect(result[0].priority).toBe('critical');
  });

  it('blocks non-main groups', async () => {
    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = agentConnection();
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_GET, {});

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'UNAUTHORIZED',
      expect.any(String),
    );
  });

  it('filters by category', async () => {
    notificationRepo.insert({ sourceAgent: 'a', category: 'email', summary: 'email' });
    notificationRepo.insert({ sourceAgent: 'a', category: 'workflow', summary: 'workflow' });

    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = mainConnection();
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_GET, { category: 'email' });

    await registry.dispatch(frame, conn);

    const result = JSON.parse((conn.reply as any).mock.calls[0][2].result);
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe('email');
  });
});

describe('notification.ack', () => {
  it('acknowledges notifications for main group', async () => {
    const n1 = notificationRepo.insert({ sourceAgent: 'a', category: 'cat', summary: 'one' });
    const n2 = notificationRepo.insert({ sourceAgent: 'b', category: 'cat', summary: 'two' });

    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = mainConnection();
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_ACK, { ids: [n1.id, n2.id] });

    await registry.dispatch(frame, conn);

    expect(conn.reply).toHaveBeenCalledWith(
      frame,
      FRAME_TYPES.NOTIFICATION_RESULT,
      expect.objectContaining({ status: 'ok' }),
    );

    const result = JSON.parse((conn.reply as any).mock.calls[0][2].result);
    expect(result.acknowledged).toBe(2);

    // Nothing pending anymore
    expect(notificationRepo.getPending()).toHaveLength(0);
  });

  it('blocks non-main groups', async () => {
    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = agentConnection();
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_ACK, { ids: ['some-id'] });

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'UNAUTHORIZED',
      expect.any(String),
    );
  });

  it('rejects empty ids array via schema validation', async () => {
    const deps = createMockDeps();
    const registry = new CommandRegistry(deps);
    registerNotificationHandlers(registry);

    const conn = mainConnection();
    const frame = makeFrame(FRAME_TYPES.NOTIFICATION_ACK, { ids: [] });

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'VALIDATION_ERROR',
      expect.any(String),
      expect.any(Object),
    );
  });
});
