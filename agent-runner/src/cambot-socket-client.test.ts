import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

import { encodeFrame } from './cambot-socket/codec.js';
import type { SocketFrame } from './cambot-socket/types.js';
import type { CambotSocketClient } from './cambot-socket-client.js';

// ── Mock socket state ────────────────────────────────────────────────

interface MockSocket extends EventEmitter {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
}

let sockets: MockSocket[] = [];

function createMockSocket(): MockSocket {
  const sock = new EventEmitter() as MockSocket;
  sock.write = vi.fn().mockReturnValue(true);
  sock.destroyed = false;
  sock.destroy = vi.fn(() => {
    sock.destroyed = true;
    sock.emit('close');
  });
  sockets.push(sock);
  return sock;
}

/** The latest mock socket created by createConnection. */
function latestSocket(): MockSocket {
  return sockets[sockets.length - 1];
}

vi.mock('net', () => ({
  default: {
    createConnection: vi.fn(
      (_port: number, _host: string, cb: () => void) => {
        const sock = createMockSocket();
        // Simulate async connect callback
        Promise.resolve().then(cb);
        return sock;
      },
    ),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Send a handshake ack (or reject) reply to the most recently written frame
 * on the given socket.
 */
function sendHandshakeReply(sock: MockSocket, accept: boolean): void {
  const lastCall = sock.write.mock.calls[sock.write.mock.calls.length - 1];
  if (!lastCall) return;
  const buf = lastCall[0] as Buffer;
  const sent = JSON.parse(buf.subarray(4).toString('utf-8')) as SocketFrame;

  const reply: SocketFrame = {
    type: accept ? 'handshake.ack' : 'handshake.reject',
    id: `reply-${sent.id}`,
    replyTo: sent.id,
    payload: accept ? { ok: true } : { error: 'bad token' },
  };
  sock.emit('data', encodeFrame(reply));
}

function makeInboundFrame(type: string, payload: unknown, id = 'srv-1', replyTo?: string): Buffer {
  const frame: SocketFrame = { type, id, payload, ...(replyTo ? { replyTo } : {}) };
  return encodeFrame(frame);
}

/**
 * Helper to connect a client. Automatically replies to the handshake.
 */
async function connectClient(): Promise<CambotSocketClient> {
  const { CambotSocketClient } = await import('./cambot-socket-client.js');

  const connectPromise = CambotSocketClient.connect('localhost', 9500, 'test-group', 'test-token');

  // Wait for the handshake frame to be sent, then reply
  await vi.waitFor(() => {
    const sock = latestSocket();
    expect(sock.write.mock.calls.length).toBeGreaterThan(0);
  }, { timeout: 500 });

  sendHandshakeReply(latestSocket(), true);

  return connectPromise;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CambotSocketClient', () => {
  beforeEach(() => {
    sockets = [];
  });

  afterEach(() => {
    // Clean up any remaining connections
    for (const s of sockets) {
      if (!s.destroyed) {
        s.destroyed = true;
        s.removeAllListeners();
      }
    }
    vi.restoreAllMocks();
  });

  // ── Connect with handshake ────────────────────────────────────

  it('connects and completes handshake', async () => {
    const client = await connectClient();

    expect(client.isConnected()).toBe(true);

    const firstWrite = latestSocket().write.mock.calls[0][0] as Buffer;
    const sentFrame = JSON.parse(firstWrite.subarray(4).toString('utf-8'));
    expect(sentFrame.type).toBe('handshake');
    expect(sentFrame.payload).toEqual(
      expect.objectContaining({ group: 'test-group', token: 'test-token' }),
    );

    client.close();
  });

  // ── waitForMessage() returns queued messages ──────────────────

  it('waitForMessage() returns messages from the queue', async () => {
    const client = await connectClient();
    const sock = latestSocket();

    sock.emit('data', makeInboundFrame('message.input', { text: 'hello' }, 'msg-1'));
    sock.emit('data', makeInboundFrame('message.input', { text: 'world' }, 'msg-2'));

    const msg1 = await client.waitForMessage();
    const msg2 = await client.waitForMessage();

    expect(msg1).toBe('hello');
    expect(msg2).toBe('world');

    client.close();
  });

  // ── waitForMessage() blocks until message ─────────────────────

  it('waitForMessage() resolves when message arrives later', async () => {
    const client = await connectClient();
    const sock = latestSocket();

    const msgPromise = client.waitForMessage();

    // Message arrives after wait
    await Promise.resolve();
    sock.emit('data', makeInboundFrame('message.input', { text: 'delayed' }));

    const msg = await msgPromise;
    expect(msg).toBe('delayed');

    client.close();
  });

  // ── waitForMessage() returns null on close ────────────────────

  it('waitForMessage() returns null when client closes', async () => {
    const client = await connectClient();

    const msgPromise = client.waitForMessage();
    await Promise.resolve();
    client.close();

    const msg = await msgPromise;
    expect(msg).toBeNull();
  });

  it('waitForMessage() returns null when already closed', async () => {
    const client = await connectClient();
    client.close();

    const msg = await client.waitForMessage();
    expect(msg).toBeNull();
  });

  // ── waitForMessage() with abort signal ────────────────────────

  it('waitForMessage() returns null on abort', async () => {
    const client = await connectClient();

    const ac = new AbortController();
    const msgPromise = client.waitForMessage(ac.signal);

    await Promise.resolve();
    ac.abort();

    const msg = await msgPromise;
    expect(msg).toBeNull();

    client.close();
  });

  // ── sendMessage() ─────────────────────────────────────────────

  it('sendMessage() sends correct frame', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    client.sendMessage('chat-123', 'Hey there', 'cam');

    expect(sock.write).toHaveBeenCalledOnce();
    const buf = sock.write.mock.calls[0][0] as Buffer;
    const frame = JSON.parse(buf.subarray(4).toString('utf-8'));

    expect(frame.type).toBe('message.outbound');
    expect(frame.payload).toEqual(
      expect.objectContaining({ chatJid: 'chat-123', text: 'Hey there', sender: 'cam' }),
    );

    client.close();
  });

  // ── sendOutput() ──────────────────────────────────────────────

  it('sendOutput() sends correct frame', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    client.sendOutput({ status: 'done', result: 'All good' });

    expect(sock.write).toHaveBeenCalledOnce();
    const buf = sock.write.mock.calls[0][0] as Buffer;
    const frame = JSON.parse(buf.subarray(4).toString('utf-8'));

    expect(frame.type).toBe('output');
    expect(frame.payload).toEqual({ status: 'done', result: 'All good' });

    client.close();
  });

  // ── request() correlates reply ────────────────────────────────

  it('request() resolves when reply arrives', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    const reqFrame: SocketFrame = {
      type: 'task.schedule',
      id: 'req-42',
      payload: { prompt: 'do stuff' },
    };

    const reqPromise = client.request(reqFrame, 5000);

    await Promise.resolve();
    const replyFrame: SocketFrame = {
      type: 'task.scheduled',
      id: 'rep-42',
      replyTo: 'req-42',
      payload: { taskId: 'T1' },
    };
    sock.emit('data', encodeFrame(replyFrame));

    const result = await reqPromise;
    expect(result.type).toBe('task.scheduled');
    expect(result.payload).toEqual({ taskId: 'T1' });

    client.close();
  });

  // ── request() timeout ─────────────────────────────────────────

  it('request() rejects on timeout', async () => {
    vi.useFakeTimers();

    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    const reqFrame: SocketFrame = {
      type: 'task.schedule',
      id: 'req-timeout',
      payload: {},
    };

    const reqPromise = client.request(reqFrame, 1000);

    // Catch the rejection before advancing timers so vitest doesn't see it
    // as "unhandled"
    const caughtPromise = reqPromise.catch((err) => err);

    await vi.advanceTimersByTimeAsync(1100);

    const err = await caughtPromise;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('timed out');

    client.close();
    vi.useRealTimers();
  });

  // ── Heartbeat ─────────────────────────────────────────────────

  it('startHeartbeat() sends heartbeat frames at interval', async () => {
    vi.useFakeTimers();

    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    client.startHeartbeat(1000);

    // Initial heartbeat sent immediately
    expect(sock.write).toHaveBeenCalledOnce();
    let buf = sock.write.mock.calls[0][0] as Buffer;
    let frame = JSON.parse(buf.subarray(4).toString('utf-8'));
    expect(frame.type).toBe('heartbeat');
    expect(frame.payload.phase).toBe('starting');

    // Advance to next interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(sock.write.mock.calls.length).toBeGreaterThanOrEqual(2);

    client.close();
    vi.useRealTimers();
  });

  it('stopHeartbeat() sends shutting-down heartbeat', async () => {
    vi.useFakeTimers();

    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    client.startHeartbeat(5000);
    sock.write.mockClear();

    client.stopHeartbeat();

    expect(sock.write).toHaveBeenCalledOnce();
    const buf = sock.write.mock.calls[0][0] as Buffer;
    const frame = JSON.parse(buf.subarray(4).toString('utf-8'));
    expect(frame.type).toBe('heartbeat');
    expect(frame.payload.phase).toBe('shutting-down');

    client.close();
    vi.useRealTimers();
  });

  it('setPhase() and incrementQueryCount() affect heartbeat payload', async () => {
    vi.useFakeTimers();

    const client = await connectClient();
    const sock = latestSocket();

    client.setPhase('processing');
    client.incrementQueryCount();
    client.incrementQueryCount();

    sock.write.mockClear();
    client.startHeartbeat(5000);

    const buf = sock.write.mock.calls[0][0] as Buffer;
    const frame = JSON.parse(buf.subarray(4).toString('utf-8'));
    expect(frame.payload.phase).toBe('processing');
    expect(frame.payload.queryCount).toBe(2);
    expect(frame.payload.uptimeMs).toBeGreaterThanOrEqual(0);

    client.close();
    vi.useRealTimers();
  });

  // ── Ping/pong ─────────────────────────────────────────────────

  it('replies to ping with pong', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    const pingFrame: SocketFrame = {
      type: 'ping',
      id: 'ping-1',
      payload: { timestamp: 12345 },
    };
    sock.emit('data', encodeFrame(pingFrame));

    expect(sock.write).toHaveBeenCalledOnce();
    const buf = sock.write.mock.calls[0][0] as Buffer;
    const pong = JSON.parse(buf.subarray(4).toString('utf-8'));
    expect(pong.type).toBe('pong');
    expect(pong.replyTo).toBe('ping-1');

    client.close();
  });

  // ── Session close ─────────────────────────────────────────────

  it('session.close causes disconnect', async () => {
    const client = await connectClient();
    const sock = latestSocket();

    const closeFrame: SocketFrame = {
      type: 'session.close',
      id: 'close-1',
      payload: { reason: 'done' },
    };
    sock.emit('data', encodeFrame(closeFrame));

    expect(client.isConnected()).toBe(false);
  });

  // ── close() ───────────────────────────────────────────────────

  it('close() destroys socket and marks as disconnected', async () => {
    const client = await connectClient();
    const sock = latestSocket();

    client.close();

    expect(client.isConnected()).toBe(false);
    expect(sock.destroy).toHaveBeenCalled();
  });

  it('close() is idempotent', async () => {
    const client = await connectClient();

    client.close();
    client.close(); // Should not throw

    expect(client.isConnected()).toBe(false);
  });

  // ── send() when closed ────────────────────────────────────────

  it('send() does nothing when closed', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    client.close();
    sock.write.mockClear();

    client.send({ type: 'test', id: 'x', payload: {} });

    expect(sock.write).not.toHaveBeenCalled();
  });

  // ── delegateWorker ────────────────────────────────────────────

  it('delegateWorker sends worker.delegate frame', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    const delegatePromise = client.delegateWorker('w1', 'do something', 'ctx');

    await Promise.resolve();
    const buf = sock.write.mock.calls[0][0] as Buffer;
    const sentFrame = JSON.parse(buf.subarray(4).toString('utf-8'));
    expect(sentFrame.type).toBe('worker.delegate');
    expect(sentFrame.payload.workerId).toBe('w1');
    expect(sentFrame.payload.prompt).toBe('do something');
    expect(sentFrame.payload.context).toBe('ctx');

    const reply: SocketFrame = {
      type: 'worker.result',
      id: 'wr-1',
      replyTo: sentFrame.id,
      payload: { result: 'done' },
    };
    sock.emit('data', encodeFrame(reply));

    const result = await delegatePromise;
    expect(result.payload).toEqual({ result: 'done' });

    client.close();
  });

  // ── sendToAgent ───────────────────────────────────────────────

  it('sendToAgent sends agent.send frame', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    const agentPromise = client.sendToAgent('req-1', 'email-agent', 'check mail');

    await Promise.resolve();
    const buf = sock.write.mock.calls[0][0] as Buffer;
    const sentFrame = JSON.parse(buf.subarray(4).toString('utf-8'));
    expect(sentFrame.type).toBe('agent.send');
    expect(sentFrame.payload.targetAgent).toBe('email-agent');

    const reply: SocketFrame = {
      type: 'agent.result',
      id: 'ar-1',
      replyTo: sentFrame.id,
      payload: { response: 'no mail' },
    };
    sock.emit('data', encodeFrame(reply));

    const result = await agentPromise;
    expect(result.payload).toEqual({ response: 'no mail' });

    client.close();
  });

  // ── Connection close resolves pending with error frames ───────

  it('socket close resolves pending requests with error frames', async () => {
    const client = await connectClient();
    const sock = latestSocket();
    sock.write.mockClear();

    const reqPromise = client.request(
      { type: 'test', id: 'pending-1', payload: {} },
      30000,
    );

    sock.emit('close');

    const result = await reqPromise;
    expect(result.type).toBe('error');
    expect(result.replyTo).toBe('pending-1');
  });

  // ── isConnected() ─────────────────────────────────────────────

  it('isConnected() returns true while open', async () => {
    const client = await connectClient();
    expect(client.isConnected()).toBe(true);
    client.close();
    expect(client.isConnected()).toBe(false);
  });
});
