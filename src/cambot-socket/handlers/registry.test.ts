import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

import { CommandRegistry, type FrameHandler } from './registry.js';
import type { SocketFrame, AuthLevel } from '../protocol/types.js';
import type { CambotSocketConnection, ConnectionIdentity } from '../connection.js';
import type { SocketDeps } from '../deps.js';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────

function createMockDeps(): SocketDeps {
  return {
    bus: { emit: vi.fn() } as any,
    registeredGroups: vi.fn().mockReturnValue({}),
    registerGroup: vi.fn(),
    syncGroupMetadata: vi.fn(),
    getAvailableGroups: vi.fn().mockReturnValue([]),
    writeGroupsSnapshot: vi.fn(),
    resolveAgentImage: vi.fn(),
    getAgentDefinition: vi.fn(),
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

function nonMainConnection(group = 'worker-1'): CambotSocketConnection {
  return createMockConnection({ group, isMain: false });
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CommandRegistry', () => {
  let registry: CommandRegistry;
  let deps: SocketDeps;

  beforeEach(() => {
    deps = createMockDeps();
    registry = new CommandRegistry(deps);
  });

  // ── Registration & dispatch ────────────────────────────────────

  it('registers and dispatches a handler', async () => {
    const handler = vi.fn();
    const schema = z.object({ msg: z.string() });

    registry.register('test.cmd', schema, 'any', handler);

    const conn = mainConnection();
    const frame = makeFrame('test.cmd', { msg: 'hello' });

    await registry.dispatch(frame, conn);

    expect(handler).toHaveBeenCalledWith(
      { msg: 'hello' },
      expect.objectContaining({ type: 'test.cmd', payload: { msg: 'hello' } }),
      conn,
      deps,
    );
  });

  it('rejects duplicate handler registration', () => {
    const schema = z.object({});
    registry.register('dup.cmd', schema, 'any', vi.fn());
    expect(() => registry.register('dup.cmd', schema, 'any', vi.fn())).toThrow(
      'Handler already registered',
    );
  });

  it('multiple handlers for different types coexist', async () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    registry.register('cmd.a', z.object({}), 'any', handler1);
    registry.register('cmd.b', z.object({}), 'any', handler2);

    const conn = mainConnection();
    await registry.dispatch(makeFrame('cmd.a'), conn);
    await registry.dispatch(makeFrame('cmd.b'), conn);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  // ── Unknown frame type ────────────────────────────────────────

  it('sends error reply for unknown command type', async () => {
    const conn = mainConnection();
    const frame = makeFrame('nonexistent.cmd');

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'UNKNOWN_COMMAND',
      expect.stringContaining('nonexistent.cmd'),
    );
  });

  // ── Auth: main-only ────────────────────────────────────────────

  it('main-only auth allows main group', async () => {
    const handler = vi.fn();
    registry.register('admin.cmd', z.object({}), 'main-only', handler);

    const conn = mainConnection();
    await registry.dispatch(makeFrame('admin.cmd'), conn);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('main-only auth blocks non-main groups', async () => {
    const handler = vi.fn();
    registry.register('admin.cmd', z.object({}), 'main-only', handler);

    const conn = nonMainConnection();
    const frame = makeFrame('admin.cmd');
    await registry.dispatch(frame, conn);

    expect(handler).not.toHaveBeenCalled();
    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'UNAUTHORIZED',
      expect.any(String),
    );
  });

  // ── Auth: self-or-main ────────────────────────────────────────

  it('self-or-main auth allows main group', async () => {
    const handler = vi.fn();
    registry.register('self.cmd', z.object({}), 'self-or-main', handler);

    const conn = mainConnection();
    await registry.dispatch(makeFrame('self.cmd'), conn);

    expect(handler).toHaveBeenCalledOnce();
  });

  it('self-or-main auth allows self group (non-main)', async () => {
    const handler = vi.fn();
    registry.register('self.cmd', z.object({}), 'self-or-main', handler);

    const conn = nonMainConnection('worker-1');
    await registry.dispatch(makeFrame('self.cmd'), conn);

    // The registry passes auth for self-or-main; actual self-check is in handler
    expect(handler).toHaveBeenCalledOnce();
  });

  // ── Auth: any ─────────────────────────────────────────────────

  it('any auth allows any group', async () => {
    const handler = vi.fn();
    registry.register('open.cmd', z.object({}), 'any', handler);

    const conn = nonMainConnection('random-group');
    await registry.dispatch(makeFrame('open.cmd'), conn);

    expect(handler).toHaveBeenCalledOnce();
  });

  // ── Schema validation ─────────────────────────────────────────

  it('rejects invalid payload with VALIDATION_ERROR', async () => {
    const handler = vi.fn();
    const schema = z.object({
      name: z.string(),
      count: z.number().int().positive(),
    });

    registry.register('validated.cmd', schema, 'any', handler);

    const conn = mainConnection();
    const frame = makeFrame('validated.cmd', { name: 123, count: -1 });

    await registry.dispatch(frame, conn);

    expect(handler).not.toHaveBeenCalled();
    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'VALIDATION_ERROR',
      expect.any(String),
      expect.objectContaining({ issues: expect.any(Array) }),
    );
  });

  it('passes validated payload to handler', async () => {
    const handler = vi.fn();
    const schema = z.object({ value: z.string().min(1) });

    registry.register('val.cmd', schema, 'any', handler);

    const conn = mainConnection();
    await registry.dispatch(makeFrame('val.cmd', { value: 'ok', extra: 'ignored' }), conn);

    // Zod strips extra keys by default
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ value: 'ok' }),
      expect.any(Object),
      conn,
      deps,
    );
  });

  // ── Handler errors ────────────────────────────────────────────

  it('catches handler errors and sends error reply', async () => {
    const handler = vi.fn().mockRejectedValue(new Error('handler boom'));
    registry.register('fail.cmd', z.object({}), 'any', handler);

    const conn = mainConnection();
    const frame = makeFrame('fail.cmd');

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'HANDLER_ERROR',
      'handler boom',
    );
  });

  it('catches non-Error throws and sends error reply', async () => {
    const handler = vi.fn().mockRejectedValue('string error');
    registry.register('fail2.cmd', z.object({}), 'any', handler);

    const conn = mainConnection();
    const frame = makeFrame('fail2.cmd');

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'HANDLER_ERROR',
      'string error',
    );
  });

  it('catches sync handler errors and sends error reply', async () => {
    const handler = vi.fn(() => {
      throw new Error('sync boom');
    });
    registry.register('sync-fail.cmd', z.object({}), 'any', handler);

    const conn = mainConnection();
    const frame = makeFrame('sync-fail.cmd');

    await registry.dispatch(frame, conn);

    expect(conn.replyError).toHaveBeenCalledWith(
      frame,
      'HANDLER_ERROR',
      'sync boom',
    );
  });
});
