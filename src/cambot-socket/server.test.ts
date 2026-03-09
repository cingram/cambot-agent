import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Socket, Server } from 'net';
import { randomUUID } from 'node:crypto';

import { CambotSocketServer } from './server.js';
import type { CommandRegistry } from './handlers/registry.js';
import { encodeFrame } from './protocol/codec.js';
import type { SocketFrame, HandshakePayload } from './protocol/types.js';
import { FRAME_TYPES, HANDSHAKE_TIMEOUT_MS } from './protocol/types.js';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../config/config.js', () => ({
  CAMBOT_SOCKET_PORT: 0,
  MAIN_GROUP_FOLDER: 'main',
}));

// ── Helpers ──────────────────────────────────────────────────────────

/** Create a mock Socket as an EventEmitter with write/destroy/remoteAddress. */
function createMockSocket(): Socket & EventEmitter {
  const socket = new EventEmitter() as Socket & EventEmitter;
  socket.setMaxListeners(20);
  (socket as any).remoteAddress = '127.0.0.1';
  (socket as any).remotePort = 12345;
  (socket as any).destroyed = false;
  (socket as any).write = vi.fn().mockReturnValue(true);
  (socket as any).destroy = vi.fn(() => {
    (socket as any).destroyed = true;
    socket.emit('close');
  });
  (socket as any).removeListener = socket.removeListener.bind(socket);
  return socket;
}

function makeHandshakeBuffer(
  group: string,
  token: string,
): Buffer {
  const frame: SocketFrame<HandshakePayload> = {
    id: randomUUID(),
    type: FRAME_TYPES.HANDSHAKE,
    payload: { group, token },
  };
  return encodeFrame(frame);
}

function makeFrameBuffer(type: string, payload: unknown, id?: string): Buffer {
  return encodeFrame({ id: id ?? randomUUID(), type, payload });
}

function createMockRegistry(): CommandRegistry {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as CommandRegistry;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CambotSocketServer', () => {
  let server: CambotSocketServer;
  let registry: CommandRegistry;
  let connectionHandler: ((socket: Socket) => void) | null;

  // Capture the net.createServer callback so we can inject mock sockets
  beforeEach(() => {
    connectionHandler = null;
    registry = createMockRegistry();

    // Mock net.createServer to capture the connection handler
    const mockNetServer = new EventEmitter() as unknown as Server;
    (mockNetServer as any).listen = vi.fn(
      (_port: number, _host: string, callback: () => void) => {
        callback();
      },
    );
    (mockNetServer as any).close = vi.fn((cb: () => void) => cb());

    vi.doMock('net', () => ({
      createServer: vi.fn((handler: (socket: Socket) => void) => {
        connectionHandler = handler;
        return mockNetServer;
      }),
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Helper: create server, start, and inject a mock socket.
   * Returns both the server and mock socket.
   */
  async function startServerAndConnect(
    overrides?: { port?: number },
  ): Promise<{ srv: CambotSocketServer; socket: Socket & EventEmitter }> {
    // We need to dynamically import to pick up mocked net
    const { CambotSocketServer: ServerClass } = await import('./server.js');
    const srv = new ServerClass({ registry, port: overrides?.port ?? 0 });
    await srv.start();
    const socket = createMockSocket();
    connectionHandler!(socket);
    return { srv, socket };
  }

  // ── Test: Token registration and handshake ─────────────────────

  it('accepts valid handshake and registers connection', async () => {
    const { srv, socket } = await startServerAndConnect();
    const token = 'test-token-abc';
    const group = 'my-group';

    srv.registerToken(group, token);

    // Send handshake
    socket.emit('data', makeHandshakeBuffer(group, token));

    expect(srv.hasConnection(group)).toBe(true);
  });

  it('rejects invalid token and destroys socket', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('my-group', 'correct-token');

    socket.emit('data', makeHandshakeBuffer('my-group', 'wrong-token'));

    expect((socket.destroy as any)).toHaveBeenCalled();
    expect(srv.hasConnection('my-group')).toBe(false);
  });

  it('rejects mismatched group in token and destroys socket', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('expected-group', 'valid-token');

    socket.emit('data', makeHandshakeBuffer('wrong-group', 'valid-token'));

    expect((socket.destroy as any)).toHaveBeenCalled();
    expect(srv.hasConnection('wrong-group')).toBe(false);
  });

  it('consumes token after successful handshake (one-time use)', async () => {
    const { srv, socket } = await startServerAndConnect();
    const token = 'one-time-token';
    srv.registerToken('g1', token);

    // First handshake succeeds
    socket.emit('data', makeHandshakeBuffer('g1', token));
    expect(srv.hasConnection('g1')).toBe(true);

    // Second socket with same token should fail
    const socket2 = createMockSocket();
    connectionHandler!(socket2);
    socket2.emit('data', makeHandshakeBuffer('g1', token));

    // The new connection supersedes for group 'g1', but the token is consumed
    // so the second handshake fails (token no longer in pending)
    expect((socket2.destroy as any)).toHaveBeenCalled();
  });

  // ── Test: Handshake timeout ────────────────────────────────────

  it('closes connection on handshake timeout', async () => {
    vi.useFakeTimers();
    const { socket } = await startServerAndConnect();

    // Don't send any handshake — just advance timer
    vi.advanceTimersByTime(HANDSHAKE_TIMEOUT_MS + 100);

    expect((socket.destroy as any)).toHaveBeenCalled();

    vi.useRealTimers();
  });

  // ── Test: Connection supersession ──────────────────────────────

  it('supersedes existing connection for same group', async () => {
    const { srv, socket: socket1 } = await startServerAndConnect();
    srv.registerToken('g1', 'token-a');
    srv.registerToken('g1', 'token-b');

    // First connection
    socket1.emit('data', makeHandshakeBuffer('g1', 'token-a'));
    expect(srv.hasConnection('g1')).toBe(true);

    // Second connection supersedes
    const socket2 = createMockSocket();
    connectionHandler!(socket2);
    socket2.emit('data', makeHandshakeBuffer('g1', 'token-b'));

    // First socket should be destroyed
    expect((socket1.destroy as any)).toHaveBeenCalled();
    // New connection should be active
    expect(srv.hasConnection('g1')).toBe(true);
  });

  // ── Test: send() ───────────────────────────────────────────────

  it('send() writes to connected group', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('g1', 't1');
    socket.emit('data', makeHandshakeBuffer('g1', 't1'));

    const frame: SocketFrame = { id: randomUUID(), type: 'test.cmd', payload: { foo: 1 } };
    srv.send('g1', frame);

    expect(socket.write).toHaveBeenCalled();
  });

  it('send() to disconnected group logs warning and does not throw', async () => {
    const { srv } = await startServerAndConnect();

    // No connection for 'nonexistent' — should not throw
    const frame: SocketFrame = { id: randomUUID(), type: 'test.cmd', payload: {} };
    expect(() => srv.send('nonexistent', frame)).not.toThrow();
  });

  // ── Test: hasConnection() ──────────────────────────────────────

  it('hasConnection() returns false for unknown group', async () => {
    const { srv } = await startServerAndConnect();
    expect(srv.hasConnection('unknown')).toBe(false);
  });

  it('hasConnection() returns false after socket is destroyed', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('g1', 't1');
    socket.emit('data', makeHandshakeBuffer('g1', 't1'));

    expect(srv.hasConnection('g1')).toBe(true);

    // Destroy the socket
    (socket as any).destroyed = true;
    expect(srv.hasConnection('g1')).toBe(false);
  });

  // ── Test: Non-handshake first frame ────────────────────────────

  it('closes connection if first frame is not handshake', async () => {
    const { socket } = await startServerAndConnect();

    socket.emit('data', makeFrameBuffer('message.outbound', { text: 'hi' }));

    expect((socket.destroy as any)).toHaveBeenCalled();
  });

  // ── Test: Post-handshake dispatch ──────────────────────────────

  it('dispatches post-handshake frames to registry', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('g1', 't1');
    socket.emit('data', makeHandshakeBuffer('g1', 't1'));

    // Now send a command frame
    socket.emit('data', makeFrameBuffer('task.schedule', { prompt: 'test' }));

    // Give the promise micro-tick
    await new Promise((r) => setTimeout(r, 10));

    expect((registry.dispatch as any)).toHaveBeenCalled();
  });

  // ── Test: shutdown() ───────────────────────────────────────────

  it('shutdown() closes all connections and stops server', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('g1', 't1');
    socket.emit('data', makeHandshakeBuffer('g1', 't1'));

    await srv.shutdown();

    expect((socket.destroy as any)).toHaveBeenCalled();
    expect(srv.hasConnection('g1')).toBe(false);
  });

  // ── Test: revokeToken() ────────────────────────────────────────

  it('revokeToken() prevents subsequent handshake with that token', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('g1', 'revokable');
    srv.revokeToken('revokable');

    socket.emit('data', makeHandshakeBuffer('g1', 'revokable'));

    expect((socket.destroy as any)).toHaveBeenCalled();
    expect(srv.hasConnection('g1')).toBe(false);
  });

  // ── Test: Bus static token ─────────────────────────────────────

  it('accepts bus static token for _bus group', async () => {
    const { srv, socket } = await startServerAndConnect();

    socket.emit('data', makeHandshakeBuffer('_bus', 'cambot-bus-cli'));

    expect(srv.hasConnection('_bus')).toBe(true);
  });

  it('rejects bus static token for non-_bus group', async () => {
    const { srv, socket } = await startServerAndConnect();

    socket.emit('data', makeHandshakeBuffer('my-group', 'cambot-bus-cli'));

    expect((socket.destroy as any)).toHaveBeenCalled();
    expect(srv.hasConnection('my-group')).toBe(false);
  });

  // ── Test: Socket close removes from connection map ─────────────

  it('removes connection from map when socket closes', async () => {
    const { srv, socket } = await startServerAndConnect();
    srv.registerToken('g1', 't1');
    socket.emit('data', makeHandshakeBuffer('g1', 't1'));

    expect(srv.hasConnection('g1')).toBe(true);

    // Simulate socket close
    (socket as any).destroyed = true;
    socket.emit('close');

    expect(srv.hasConnection('g1')).toBe(false);
  });
});
