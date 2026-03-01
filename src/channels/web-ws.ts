import http from 'http';

import { WebSocket, WebSocketServer } from 'ws';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InboundWsMessage {
  type: 'message';
  text: string;
  sender_name?: string;
}

type InboundHandler = (msg: InboundWsMessage) => void;

type ConnectHandler = () => void;

export interface WebSocketManager {
  /** Attach to an existing HTTP server (noServer mode upgrade on /ws). */
  attach(server: http.Server): void;
  /** Broadcast a JSON payload to every connected client. */
  broadcast(msg: Record<string, unknown>): void;
  /** Number of currently connected clients. */
  clientCount(): number;
  /** Register a handler for client-to-server messages. */
  onInboundMessage(handler: InboundHandler): void;
  /** Register a handler called when a new client connects. */
  onClientConnect(handler: ConnectHandler): void;
  /** Graceful shutdown — terminates all connections and stops heartbeat. */
  close(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWebSocketManager(): WebSocketManager {
  const clients = new Set<WebSocket>();
  let inboundHandler: InboundHandler | null = null;
  let connectHandler: ConnectHandler | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let wss: WebSocketServer | null = null;

  function startHeartbeat(): void {
    heartbeatTimer = setInterval(() => {
      for (const ws of clients) {
        if ((ws as any).__alive === false) {
          ws.terminate();
          clients.delete(ws);
          continue;
        }
        (ws as any).__alive = false;
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  function handleConnection(ws: WebSocket): void {
    (ws as any).__alive = true;
    clients.add(ws);
    logger.info({ clientCount: clients.size }, 'WebSocket client connected');

    // Notify connect handler (used to flush buffered messages)
    if (connectHandler) connectHandler();

    ws.on('pong', () => {
      (ws as any).__alive = true;
    });

    ws.on('message', (raw) => {
      if (!inboundHandler) return;
      try {
        const data = JSON.parse(String(raw));
        if (data.type === 'message' && typeof data.text === 'string') {
          inboundHandler(data as InboundWsMessage);
        }
      } catch {
        logger.warn('Invalid WebSocket message received, ignoring');
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      logger.info({ clientCount: clients.size }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'WebSocket client error');
      clients.delete(ws);
    });
  }

  return {
    attach(server: http.Server): void {
      wss = new WebSocketServer({ noServer: true });

      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (url.pathname !== '/ws') {
          socket.destroy();
          return;
        }
        wss!.handleUpgrade(req, socket, head, (ws) => {
          wss!.emit('connection', ws, req);
        });
      });

      wss.on('connection', handleConnection);
      startHeartbeat();
      logger.info('WebSocket manager attached to HTTP server');
    },

    broadcast(msg: Record<string, unknown>): void {
      const payload = JSON.stringify(msg);
      for (const ws of clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload);
        }
      }
    },

    clientCount(): number {
      return clients.size;
    },

    onInboundMessage(handler: InboundHandler): void {
      inboundHandler = handler;
    },

    onClientConnect(handler: ConnectHandler): void {
      connectHandler = handler;
    },

    close(): void {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      for (const ws of clients) {
        ws.terminate();
      }
      clients.clear();
      if (wss) {
        wss.close();
        wss = null;
      }
    },
  };
}
