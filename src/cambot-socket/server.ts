/**
 * CambotSocketServer — host-side TCP server for container IPC.
 *
 * Replaces the file-based IPC watcher with a persistent TCP connection
 * per container. Each container authenticates with a one-time handshake
 * token registered before spawn.
 */

import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'net';

import { encodeFrame, FrameDecoder } from './protocol/codec.js';
import type { SocketFrame, HandshakePayload } from './protocol/types.js';
import {
  HANDSHAKE_TIMEOUT_MS,
  FRAME_TYPES,
} from './protocol/types.js';
import { CambotSocketConnection, type ConnectionIdentity } from './connection.js';
import type { CommandRegistry } from './handlers/registry.js';
import { logger } from '../logger.js';
import { CAMBOT_SOCKET_PORT, MAIN_GROUP_FOLDER } from '../config/config.js';

export interface CambotSocketServerDeps {
  registry: CommandRegistry;
  port?: number;
}

/**
 * Static token for CLI/bus connections. Always accepted for the _bus group.
 * Set via BUS_TOKEN env var, or falls back to a deterministic default.
 */
const BUS_STATIC_TOKEN = process.env.BUS_TOKEN || 'cambot-bus-cli';

if (!process.env.BUS_TOKEN) {
  logger.warn(
    'BUS_TOKEN is not set — using well-known default. Set BUS_TOKEN in .env for production.',
  );
}

/** TTL for pending handshake tokens (ms). */
const TOKEN_TTL_MS = 60_000;

export class CambotSocketServer {
  private server: Server | null = null;
  private connections = new Map<string, CambotSocketConnection>();
  private pendingTokens = new Map<string, { group: string; authorizedJids?: Set<string> }>();
  private tokenTimers = new Map<string, ReturnType<typeof setTimeout>>(); // token -> TTL timer
  private readonly port: number;
  private readonly registry: CommandRegistry;

  constructor(deps: CambotSocketServerDeps) {
    this.registry = deps.registry;
    this.port = deps.port ?? CAMBOT_SOCKET_PORT;
  }

  /** Start listening for container connections. */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.onRawConnection(socket));

      this.server.on('error', (err) => {
        logger.error({ err, port: this.port }, 'CambotSocketServer error');
        reject(err);
      });

      const host = process.env.CAMBOT_SOCKET_HOST || '127.0.0.1';
      this.server.listen(this.port, host, () => {
        logger.info({ port: this.port }, 'CambotSocketServer listening');
        resolve();
      });
    });
  }

  /**
   * Register a one-time token that a container will present during handshake.
   * Must be called before spawning the container.
   */
  registerToken(group: string, token: string, authorizedJids?: Set<string>): void {
    this.pendingTokens.set(token, { group, authorizedJids });

    // Auto-revoke after TTL to prevent unbounded growth
    const timer = setTimeout(() => {
      this.pendingTokens.delete(token);
      this.tokenTimers.delete(token);
      logger.debug({ group }, 'Handshake token expired (TTL)');
    }, TOKEN_TTL_MS);
    timer.unref();
    this.tokenTimers.set(token, timer);

    logger.debug({ group }, 'Registered handshake token');
  }

  /** Remove a registered token (e.g. if container spawn fails). */
  revokeToken(token: string): void {
    this.pendingTokens.delete(token);
    const timer = this.tokenTimers.get(token);
    if (timer) {
      clearTimeout(timer);
      this.tokenTimers.delete(token);
    }
  }

  /** Send a frame to a specific group's container. */
  send(group: string, frame: SocketFrame): void {
    const conn = this.connections.get(group);
    if (!conn || !conn.isAlive()) {
      logger.warn({ group, type: frame.type }, 'No active connection for group');
      return;
    }
    conn.send(frame);
  }

  /** Send a request and await reply from a specific group's container. */
  async request<T = unknown>(
    group: string,
    frame: Omit<SocketFrame, 'id'>,
    timeoutMs?: number,
  ): Promise<SocketFrame<T>> {
    const conn = this.connections.get(group);
    if (!conn || !conn.isAlive()) {
      throw new Error(`No active connection for group "${group}"`);
    }
    return conn.request<T>(frame, timeoutMs);
  }

  /** Check if a group has an active, alive connection. */
  hasConnection(group: string): boolean {
    const conn = this.connections.get(group);
    return conn != null && conn.isAlive();
  }

  /** Get the connection for a group (if any). */
  getConnection(group: string): CambotSocketConnection | undefined {
    return this.connections.get(group);
  }

  /** Gracefully close all connections and stop the server. */
  async shutdown(): Promise<void> {
    for (const [, conn] of this.connections) {
      conn.close('server shutdown');
    }
    this.connections.clear();
    this.pendingTokens.clear();
    for (const timer of this.tokenTimers.values()) clearTimeout(timer);
    this.tokenTimers.clear();

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    logger.info('CambotSocketServer shut down');
  }

  // ── Private ─────────────────────────────────────────────

  private onRawConnection(socket: Socket): void {
    const remoteAddr = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.debug({ remoteAddr }, 'Raw TCP connection received');

    const decoder = new FrameDecoder();
    let authenticated = false;

    // Handshake timeout — reject connections that don't authenticate in time
    const handshakeTimer = setTimeout(() => {
      if (!authenticated) {
        logger.warn({ remoteAddr }, 'Handshake timeout, closing connection');
        socket.destroy();
      }
    }, HANDSHAKE_TIMEOUT_MS);

    const onData = (chunk: Buffer): void => {
      if (authenticated) return; // Shouldn't happen, but guard

      let frames: SocketFrame[];
      try {
        frames = decoder.push(chunk);
      } catch (err) {
        clearTimeout(handshakeTimer);
        logger.error({ remoteAddr, err }, 'Handshake decode error');
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        if (frame.type === FRAME_TYPES.HANDSHAKE) {
          clearTimeout(handshakeTimer);
          socket.removeListener('data', onData);
          authenticated = true;
          this.handleHandshake(frame as SocketFrame<HandshakePayload>, socket, decoder);
          return;
        }

        // Non-handshake frame before auth — reject
        clearTimeout(handshakeTimer);
        logger.warn({ remoteAddr, type: frame.type }, 'Expected handshake frame, got something else');
        socket.destroy();
        return;
      }
    };

    socket.on('data', onData);

    socket.on('error', (err) => {
      clearTimeout(handshakeTimer);
      if (!authenticated) {
        logger.debug({ remoteAddr, err }, 'Pre-auth socket error');
      }
    });

    socket.on('close', () => {
      clearTimeout(handshakeTimer);
    });
  }

  private handleHandshake(
    frame: SocketFrame<HandshakePayload>,
    socket: Socket,
    decoder: FrameDecoder,
  ): void {
    const { token, group } = frame.payload;

    // Accept static bus token for CLI connections (_bus group)
    const isBusToken = token === BUS_STATIC_TOKEN && group === '_bus';

    // Validate the one-time token (or static bus token)
    let tokenData: { group: string; authorizedJids?: Set<string> } | undefined;
    if (!isBusToken) {
      tokenData = this.pendingTokens.get(token);
      if (!tokenData || tokenData.group !== group) {
        logger.warn({ group, token: token.slice(0, 8) + '...' }, 'Invalid handshake token');
        const rejectFrame: SocketFrame = {
          id: randomUUID(),
          type: FRAME_TYPES.HANDSHAKE_REJECT,
          replyTo: frame.id,
          payload: { error: 'Invalid or expired handshake token' },
        };
        socket.write(encodeFrame(rejectFrame), () => socket.destroy());
        return;
      }

      // Consume the token — it's one-time use
      this.pendingTokens.delete(token);
      const ttlTimer = this.tokenTimers.get(token);
      if (ttlTimer) {
        clearTimeout(ttlTimer);
        this.tokenTimers.delete(token);
      }
    }

    // Supersede any existing connection for this group
    const existing = this.connections.get(group);
    if (existing) {
      logger.info({ group }, 'Superseding existing connection');
      existing.close('superseded by new connection');
    }

    const identity: ConnectionIdentity = {
      group,
      isMain: group === MAIN_GROUP_FOLDER,
      authorizedJids: tokenData?.authorizedJids,
    };

    const connection = new CambotSocketConnection(socket, identity);

    // Wire up command dispatch
    connection.onFrame((incomingFrame) => {
      this.registry.dispatch(incomingFrame, connection).catch((err) => {
        logger.error(
          { group, type: incomingFrame.type, err },
          'Unhandled error in command dispatch',
        );
        connection.replyError(incomingFrame, 'INTERNAL_ERROR', 'Unhandled dispatch error');
      });
    });

    this.connections.set(group, connection);

    // Send handshake acknowledgement
    connection.reply(frame, FRAME_TYPES.HANDSHAKE_ACK, { ok: true });

    // Clean up connection map on close
    socket.on('close', () => {
      // Only remove if this is still the active connection for the group
      if (this.connections.get(group) === connection) {
        this.connections.delete(group);
        logger.info({ group }, 'Connection removed from active map');
      }
    });

    logger.info({ group, isMain: identity.isMain }, 'Container authenticated');
  }
}
