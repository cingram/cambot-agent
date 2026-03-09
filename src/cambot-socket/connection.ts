/**
 * CambotSocketConnection — one per connected container.
 *
 * Wraps a raw TCP socket with frame encoding/decoding, request/reply
 * correlation, and dead-connection detection.
 */

import { randomUUID } from 'node:crypto';
import type { Socket } from 'net';

import { encodeFrame, FrameDecoder } from './protocol/codec.js';
import type { SocketFrame, ErrorPayload } from './protocol/types.js';
import { logger } from '../logger.js';

export interface PendingRequest {
  resolve: (frame: SocketFrame) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ConnectionIdentity {
  group: string;
  isMain: boolean;
}

const MAX_PENDING_REQUESTS = 100;

export class CambotSocketConnection {
  private decoder = new FrameDecoder();
  private pending = new Map<string, PendingRequest>();
  private frameHandlers: Array<(frame: SocketFrame) => void> = [];

  constructor(
    readonly socket: Socket,
    readonly identity: ConnectionIdentity,
  ) {
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.onClose());
    socket.on('error', (err) => {
      logger.warn({ group: identity.group, err }, 'Socket error');
    });
  }

  /** Register a handler called for every non-reply frame. Multiple handlers are supported. */
  onFrame(handler: (frame: SocketFrame) => void): void {
    this.frameHandlers.push(handler);
  }

  /** Send a frame and await its reply within `timeoutMs`. */
  request<T = unknown>(frame: Omit<SocketFrame, 'id'>, timeoutMs = 30_000): Promise<SocketFrame<T>> {
    if (this.pending.size >= MAX_PENDING_REQUESTS) {
      return Promise.reject(
        new Error(`Too many pending requests (${MAX_PENDING_REQUESTS}) for group "${this.identity.group}"`),
      );
    }
    const id = randomUUID();
    const fullFrame: SocketFrame = { ...frame, id };

    return new Promise<SocketFrame<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Request ${id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(id, {
        resolve: resolve as (f: SocketFrame) => void,
        reject,
        timer,
      });

      this.send(fullFrame);
    });
  }

  /** Send a reply frame matching an incoming frame's id. */
  reply(originalFrame: SocketFrame, type: string, payload: unknown): void {
    const frame: SocketFrame = {
      id: randomUUID(),
      type,
      replyTo: originalFrame.id,
      payload,
    };
    this.send(frame);
  }

  /** Send a typed error reply. */
  replyError(originalFrame: SocketFrame, _code: string, message: string, details?: unknown): void {
    const payload: ErrorPayload = { error: message, details };
    this.reply(originalFrame, 'error', payload);
  }

  /** Write an encoded frame to the socket. */
  send(frame: SocketFrame): void {
    if (this.socket.destroyed) {
      logger.warn({ group: this.identity.group, frameId: frame.id }, 'Attempted send on destroyed socket');
      return;
    }
    this.socket.write(encodeFrame(frame));
  }

  /** Check if the underlying socket is still usable. */
  isAlive(): boolean {
    return !this.socket.destroyed;
  }

  /** Tear down the connection, rejecting all pending requests. */
  close(reason: string): void {
    for (const [id, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error(`Connection closed: ${reason}`));
    }
    this.pending.clear();

    if (!this.socket.destroyed) {
      this.socket.destroy();
    }

    logger.info({ group: this.identity.group, reason }, 'Connection closed');
  }

  // ── Private ─────────────────────────────────────────────

  private onData(chunk: Buffer): void {
    let frames: SocketFrame[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      logger.error({ group: this.identity.group, err }, 'Frame decode error, closing connection');
      this.close('decode error');
      return;
    }

    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: SocketFrame): void {
    // Route replies to pending requests
    if (frame.replyTo != null) {
      const req = this.pending.get(frame.replyTo);
      if (req) {
        this.pending.delete(frame.replyTo);
        clearTimeout(req.timer);
        req.resolve(frame);
        return;
      }
      logger.debug(
        { group: this.identity.group, replyTo: frame.replyTo },
        'Received reply with no pending request',
      );
      return;
    }

    // Dispatch to all registered frame handlers
    if (this.frameHandlers.length > 0) {
      for (const handler of this.frameHandlers) {
        handler(frame);
      }
    } else {
      logger.warn(
        { group: this.identity.group, type: frame.type },
        'No frame handler registered, dropping frame',
      );
    }
  }

  private onClose(): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timer);
      req.reject(new Error('Socket closed'));
    }
    this.pending.clear();
    logger.debug({ group: this.identity.group }, 'Socket closed');
  }
}
