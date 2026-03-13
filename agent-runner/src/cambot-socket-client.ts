/**
 * CambotSocketClient — TCP socket transport for container-to-host communication.
 *
 * Replaces IpcChannel (file-based polling) and HeartbeatWriter (file writes)
 * with a single persistent TCP connection using length-prefixed JSON frames.
 *
 * Responsibilities:
 * - Connection with handshake and exponential backoff retry
 * - Bidirectional frame send/receive with replyTo correlation
 * - Inbound message queuing for waitForMessage()
 * - Periodic heartbeat frames (replaces HeartbeatWriter)
 * - Output frames (replaces stdout sentinel markers)
 * - Outbound messaging and request/response patterns
 */
import net from 'net';
import { encodeFrame, FrameDecoder } from './cambot-socket/codec.js';
import type { SocketFrame, HeartbeatPhase, OutputPayload, LogLevel } from './cambot-socket/types.js';
import { FRAME_TYPES } from './cambot-socket/types.js';
import { uuid } from './mcp-tools/helpers.js';

// ── Pending reply bookkeeping ───────────────────────────────────────

interface PendingReply {
  resolve: (frame: SocketFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── CambotSocketClient ──────────────────────────────────────────────

const MAX_MESSAGE_QUEUE = 1000;
const MAX_PENDING_REPLIES = 100;

export class CambotSocketClient {
  private readonly decoder = new FrameDecoder();
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly messageQueue: string[] = [];
  private messageResolve: ((msg: string | null) => void) | null = null;
  private closed = false;

  // Heartbeat state
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private phase: HeartbeatPhase = 'starting';
  private queryCount = 0;
  private readonly startedAt = Date.now();

  private constructor(private readonly socket: net.Socket) {
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          this.handleFrame(frame);
        }
      } catch {
        this.close();
      }
    });

    socket.on('close', () => {
      this.closed = true;
      this.resolveMessageWaiter(null);
      this.rejectAllPending('Connection closed');
    });

    socket.on('error', () => {
      this.closed = true;
    });
  }

  // ── Static Factory ──────────────────────────────────────────────

  /**
   * Connect to the cambot-socket server and perform handshake.
   * Retries with exponential backoff: 100ms, 200ms, 400ms, 800ms, 1600ms, 3200ms.
   */
  static async connect(
    host: string,
    port: number,
    group: string,
    token: string,
  ): Promise<CambotSocketClient> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const socket = await createTcpConnection(host, port);
        const client = new CambotSocketClient(socket);

        const reply = await client.request(
          { type: FRAME_TYPES.HANDSHAKE, id: uuid(), payload: { group, token } },
          5_000,
        );

        if (reply.type === FRAME_TYPES.HANDSHAKE_REJECT) {
          socket.destroy();
          const errorMsg = (reply.payload as { error: string }).error;
          throw new Error(`Handshake rejected: ${errorMsg}`);
        }

        return client;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await delay(100 * Math.pow(2, attempt));
      }
    }

    throw lastError ?? new Error('CambotSocket connection failed');
  }

  // ── Frame Handling ──────────────────────────────────────────────

  private handleFrame(frame: SocketFrame): void {
    // Reply correlation — resolve pending request
    if (frame.replyTo && this.pendingReplies.has(frame.replyTo)) {
      const pending = this.pendingReplies.get(frame.replyTo)!;
      clearTimeout(pending.timer);
      this.pendingReplies.delete(frame.replyTo);
      pending.resolve(frame);
      return;
    }

    switch (frame.type) {
      case FRAME_TYPES.MESSAGE_INPUT:
        this.deliverMessage((frame.payload as { text: string }).text);
        break;
      case FRAME_TYPES.SESSION_CLOSE:
        this.close();
        break;
      case FRAME_TYPES.PING:
        this.send({
          type: FRAME_TYPES.PONG,
          id: uuid(),
          replyTo: frame.id,
          payload: { timestamp: Date.now() },
        });
        break;
    }
  }

  // ── Message Delivery ────────────────────────────────────────────

  private deliverMessage(text: string): void {
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve(text);
    } else {
      if (this.messageQueue.length >= MAX_MESSAGE_QUEUE) {
        this.messageQueue.shift(); // Drop oldest
        console.warn('[CambotSocket] Message queue overflow, dropping oldest message');
      }
      this.messageQueue.push(text);
    }
  }

  private resolveMessageWaiter(value: string | null): void {
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve(value);
    }
  }

  /**
   * Wait for the next inbound message. Returns null on close or abort.
   * Messages that arrive before anyone is waiting are queued internally.
   */
  waitForMessage(signal?: AbortSignal): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);

    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }

    return new Promise((resolve) => {
      this.messageResolve = resolve;
      signal?.addEventListener('abort', () => {
        this.messageResolve = null;
        resolve(null);
      }, { once: true });
    });
  }

  // ── Heartbeat (replaces HeartbeatWriter) ────────────────────────

  startHeartbeat(intervalMs = 5000): void {
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.phase = 'shutting-down';
    this.sendHeartbeat();
  }

  setPhase(phase: HeartbeatPhase): void {
    this.phase = phase;
  }

  incrementQueryCount(): void {
    this.queryCount++;
  }

  private sendHeartbeat(): void {
    this.send({
      type: FRAME_TYPES.HEARTBEAT,
      id: uuid(),
      payload: {
        phase: this.phase,
        queryCount: this.queryCount,
        uptimeMs: Date.now() - this.startedAt,
      },
    });
  }

  // ── Output (replaces stdout sentinel markers) ───────────────────

  sendOutput(output: OutputPayload): void {
    this.send({ type: FRAME_TYPES.OUTPUT, id: uuid(), payload: output });
  }

  // ── Structured Logging ──────────────────────────────────────────

  sendLog(level: LogLevel, message: string): void {
    this.send({ type: FRAME_TYPES.LOG, id: uuid(), payload: { level, message } });
  }

  // ── Outbound Messages ──────────────────────────────────────────

  sendMessage(chatJid: string, text: string, opts?: { sender?: string; channel?: string }): void {
    this.send({
      type: FRAME_TYPES.MESSAGE_OUTBOUND,
      id: uuid(),
      payload: { chatJid, text, ...opts },
    });
  }

  // ── Request / Response ─────────────────────────────────────────

  /**
   * Send a frame and return a promise that resolves when the reply arrives.
   * Uses replyTo correlation on the frame ID.
   */
  request(frame: SocketFrame, timeoutMs = 30_000): Promise<SocketFrame> {
    if (this.pendingReplies.size >= MAX_PENDING_REPLIES) {
      return Promise.reject(
        new Error(`CambotSocket: too many pending requests (${MAX_PENDING_REPLIES})`),
      );
    }
    this.send(frame);
    return new Promise<SocketFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(frame.id);
        reject(new Error(`CambotSocket request timed out: ${frame.type}`));
      }, timeoutMs);
      this.pendingReplies.set(frame.id, { resolve, reject, timer });
    });
  }

  /** Delegate to a worker container and await the result. */
  async delegateWorker(
    workerId: string,
    prompt: string,
    context?: string,
  ): Promise<SocketFrame> {
    return this.request({
      type: FRAME_TYPES.WORKER_DELEGATE,
      id: uuid(),
      payload: { delegationId: uuid(), workerId, prompt, context },
    }, 300_000);
  }

  /** Send to another persistent agent and await the result. */
  async sendToAgent(
    requestId: string,
    targetAgent: string,
    prompt: string,
  ): Promise<SocketFrame> {
    return this.request({
      type: FRAME_TYPES.AGENT_SEND,
      id: uuid(),
      payload: { requestId, targetAgent, prompt },
    }, 300_000);
  }

  // ── Notifications ─────────────────────────────────────────

  /** Submit a notification to the admin inbox. */
  async sendNotification(
    category: string,
    summary: string,
    priority?: 'critical' | 'high' | 'normal' | 'low' | 'info',
    payload?: Record<string, unknown>,
  ): Promise<SocketFrame> {
    return this.request({
      type: FRAME_TYPES.NOTIFICATION_SUBMIT,
      id: uuid(),
      payload: { category, summary, priority, payload },
    }, 30_000);
  }

  // ── Low-level Send ─────────────────────────────────────────────

  send(frame: SocketFrame): void {
    if (!this.closed) {
      this.socket.write(encodeFrame(frame));
    }
  }

  // ── Connection State ───────────────────────────────────────────

  isConnected(): boolean {
    return !this.closed;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    this.resolveMessageWaiter(null);
    this.rejectAllPending('Connection closed');
    this.socket.destroy();
  }

  // ── Helpers ────────────────────────────────────────────────────

  private rejectAllPending(reason: string): void {
    for (const [, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingReplies.clear();
  }
}

// ── Module-level helpers ──────────────────────────────────────────

function createTcpConnection(host: string, port: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection(port, host, () => resolve(socket));
    socket.on('error', reject);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
