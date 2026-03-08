import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Socket } from 'net';

import { CambotSocketConnection, type ConnectionIdentity } from './connection.js';
import { encodeFrame } from './protocol/codec.js';
import type { SocketFrame } from './protocol/types.js';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ── Helpers ──────────────────────────────────────────────────────────

function createMockSocket(): Socket & EventEmitter {
  const socket = new EventEmitter() as Socket & EventEmitter;
  (socket as any).destroyed = false;
  (socket as any).write = vi.fn().mockReturnValue(true);
  (socket as any).destroy = vi.fn(() => {
    (socket as any).destroyed = true;
    socket.emit('close');
  });
  return socket;
}

const defaultIdentity: ConnectionIdentity = { group: 'test-group', isMain: false };

function makeFrame(type: string, payload: unknown = {}, id = 'frame-100'): SocketFrame {
  return { id, type, payload };
}

function makeReplyFrame(replyTo: string, payload: unknown = {}, id = 'frame-200'): SocketFrame {
  return { id, type: 'reply', replyTo, payload };
}

// ── Tests ────────────────────────────────────────────────────────────

describe('CambotSocketConnection', () => {
  let socket: Socket & EventEmitter;
  let conn: CambotSocketConnection;

  beforeEach(() => {
    socket = createMockSocket();
    conn = new CambotSocketConnection(socket, defaultIdentity);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Frame received and dispatched ──────────────────────────────

  it('dispatches received frames to the frame handler', () => {
    const handler = vi.fn();
    conn.onFrame(handler);

    const frame = makeFrame('test.cmd', { msg: 'hi' });
    socket.emit('data', encodeFrame(frame));

    expect(handler).toHaveBeenCalledWith(frame);
  });

  it('drops frames when no handler is registered', () => {
    // Should not throw, just warn
    const frame = makeFrame('test.cmd');
    socket.emit('data', encodeFrame(frame));
    // No handler registered — frame is dropped silently
  });

  // ── Reply correlation ──────────────────────────────────────────

  it('correlates reply frames to pending requests', async () => {
    vi.useFakeTimers();

    const requestPromise = conn.request({ type: 'query', payload: {} }, 5000);

    // The request was sent — extract the frame ID from the write call
    expect(socket.write).toHaveBeenCalledOnce();
    const writtenBuf = (socket.write as any).mock.calls[0][0] as Buffer;
    const sentFrame = JSON.parse(writtenBuf.subarray(4).toString('utf-8')) as SocketFrame;

    // Simulate reply arriving
    const reply = makeReplyFrame(sentFrame.id, { result: 'ok' });
    socket.emit('data', encodeFrame(reply));

    const result = await requestPromise;
    expect(result.payload).toEqual({ result: 'ok' });
    expect(result.replyTo).toBe(sentFrame.id);

    vi.useRealTimers();
  });

  // ── Request timeout ────────────────────────────────────────────

  it('rejects request promise on timeout', async () => {
    vi.useFakeTimers();

    const requestPromise = conn.request({ type: 'slow', payload: {} }, 1000);

    vi.advanceTimersByTime(1100);

    await expect(requestPromise).rejects.toThrow('timed out');

    vi.useRealTimers();
  });

  // ── close() rejects all pending requests ──────────────────────

  it('close() rejects all pending requests', async () => {
    vi.useFakeTimers();

    const p1 = conn.request({ type: 'a', payload: {} }, 30000);
    const p2 = conn.request({ type: 'b', payload: {} }, 30000);

    conn.close('test shutdown');

    await expect(p1).rejects.toThrow('Connection closed');
    await expect(p2).rejects.toThrow('Connection closed');

    vi.useRealTimers();
  });

  // ── send() when socket destroyed ──────────────────────────────

  it('send() does not write when socket is destroyed', () => {
    (socket as any).destroyed = true;

    conn.send(makeFrame('test.cmd'));

    expect(socket.write).not.toHaveBeenCalled();
  });

  it('send() writes encoded frame to socket', () => {
    const frame = makeFrame('test.cmd', { data: 1 });
    conn.send(frame);

    expect(socket.write).toHaveBeenCalledOnce();
    const writtenBuf = (socket.write as any).mock.calls[0][0] as Buffer;
    const decoded = JSON.parse(writtenBuf.subarray(4).toString('utf-8'));
    expect(decoded).toEqual(frame);
  });

  // ── isAlive() ──────────────────────────────────────────────────

  it('isAlive() returns true when socket is not destroyed', () => {
    expect(conn.isAlive()).toBe(true);
  });

  it('isAlive() returns false when socket is destroyed', () => {
    (socket as any).destroyed = true;
    expect(conn.isAlive()).toBe(false);
  });

  // ── reply() and replyError() ──────────────────────────────────

  it('reply() sends a frame with replyTo set', () => {
    const original = makeFrame('request.cmd', {}, 'frame-42');
    conn.reply(original, 'response.cmd', { status: 'ok' });

    expect(socket.write).toHaveBeenCalledOnce();
    const writtenBuf = (socket.write as any).mock.calls[0][0] as Buffer;
    const decoded = JSON.parse(writtenBuf.subarray(4).toString('utf-8')) as SocketFrame;

    expect(decoded.replyTo).toBe('frame-42');
    expect(decoded.type).toBe('response.cmd');
    expect(decoded.payload).toEqual({ status: 'ok' });
  });

  it('replyError() sends error payload with canonical ErrorPayload shape', () => {
    const original = makeFrame('bad.cmd', {}, 'frame-99');
    conn.replyError(original, 'TEST_ERROR', 'Something went wrong', { hint: 'retry' });

    expect(socket.write).toHaveBeenCalledOnce();
    const writtenBuf = (socket.write as any).mock.calls[0][0] as Buffer;
    const decoded = JSON.parse(writtenBuf.subarray(4).toString('utf-8')) as SocketFrame;

    expect(decoded.type).toBe('error');
    expect(decoded.replyTo).toBe('frame-99');
    expect(decoded.payload).toEqual({
      error: 'Something went wrong',
      details: { hint: 'retry' },
    });
  });

  // ── Socket close rejects pending ──────────────────────────────

  it('socket close event rejects pending requests', async () => {
    vi.useFakeTimers();

    const p = conn.request({ type: 'x', payload: {} }, 30000);

    // Simulate socket close
    socket.emit('close');

    await expect(p).rejects.toThrow('Socket closed');

    vi.useRealTimers();
  });

  // ── Decode error closes connection ────────────────────────────

  it('decode error closes the connection', () => {
    // Send garbage data that can't be decoded as a frame
    const badHeader = Buffer.alloc(4);
    badHeader.writeUInt32BE(3, 0); // 3 bytes of body
    const badBody = Buffer.from('xyz'); // not valid JSON
    const badData = Buffer.concat([badHeader, badBody]);

    socket.emit('data', badData);

    expect((socket.destroy as any)).toHaveBeenCalled();
  });

  // ── Reply with no pending request ─────────────────────────────

  it('handles reply with no pending request gracefully', () => {
    const handler = vi.fn();
    conn.onFrame(handler);

    const orphanReply = makeReplyFrame('frame-9999', { unexpected: true });
    socket.emit('data', encodeFrame(orphanReply));

    // Should not dispatch to handler — it's a reply, not a command
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Identity ──────────────────────────────────────────────────

  it('exposes identity on the connection', () => {
    expect(conn.identity).toEqual(defaultIdentity);
  });

  // ── Multiple frames in one chunk ──────────────────────────────

  it('dispatches multiple frames from a single data chunk', () => {
    const handler = vi.fn();
    conn.onFrame(handler);

    const frame1 = makeFrame('cmd.a', { n: 1 }, 'frame-1');
    const frame2 = makeFrame('cmd.b', { n: 2 }, 'frame-2');
    const combined = Buffer.concat([encodeFrame(frame1), encodeFrame(frame2)]);

    socket.emit('data', combined);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith(frame1);
    expect(handler).toHaveBeenCalledWith(frame2);
  });
});
