import http from 'http';

import { randomUUID } from 'node:crypto';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER, WEB_ALLOWED_ORIGINS, WEB_AUTH_TOKEN, WEB_CHANNEL_PORT } from '../config/config.js';
import {
  getChatHistory,
  getDatabase,
  listConversations,
  upsertConversation,
  renameConversation as dbRenameConversation,
  deleteConversation as dbDeleteConversation,
  deleteAllConversations as dbDeleteAllConversations,
} from '../db/index.js';
import { createAgentMessageRepository } from '../db/agent-message-repository.js';
import { createAgentRepository } from '../db/agent-repository.js';
import { createAgentTemplateRepository } from '../db/agent-template-repository.js';
import { handleAgentRoutes } from '../api/agent-routes.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts, NewMessage } from '../types.js';
import { ChatMetadata, InboundMessage } from '../bus/index.js';
import { createWebAuth, WebAuth } from './web-auth.js';
import { createWebSocketManager, WebSocketManager } from './web-ws.js';

const WEB_JID = 'web:ui';
const RESPONSE_TIMEOUT_MS = 180_000; // 3 minutes
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_PORT = 3100;
const MAX_BUFFERED_MESSAGES = 100;

// ---------------------------------------------------------------------------
// Buffered message — stored when no WS clients are connected
// ---------------------------------------------------------------------------

interface BufferedMessage {
  jid: string;
  text: string;
  sender: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// SSE chunk format (matches what cambot-core-ui expects)
// ---------------------------------------------------------------------------

interface StreamChunk {
  type: 'thinking' | 'delta' | 'done' | 'error';
  text?: string;
  message?: string;
}

// ---------------------------------------------------------------------------
// Pending response — bridges sendMessage() to the HTTP response
// ---------------------------------------------------------------------------

interface PendingResponse {
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Web Channel — HTTP server for web UI chat
// ---------------------------------------------------------------------------

export class WebChannel implements Channel {
  readonly name = 'web';

  private server: http.Server | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private port: number;
  private pending = new Map<string, PendingResponse>();
  private wsManager: WebSocketManager;
  private messageBuffer: BufferedMessage[] = [];
  private auth: WebAuth;
  private agentRoutesDeps?: import('../api/agent-routes.js').AgentRoutesDeps;

  constructor(opts: ChannelOpts, port?: number) {
    this.opts = opts;
    this.port = port ?? DEFAULT_PORT;
    this.auth = createWebAuth(WEB_AUTH_TOKEN);
    this.wsManager = createWebSocketManager();
  }

  private getAgentRoutesDeps(): import('../api/agent-routes.js').AgentRoutesDeps {
    if (!this.agentRoutesDeps) {
      const db = getDatabase();
      this.agentRoutesDeps = {
        agentRepo: createAgentRepository(db),
        templateRepo: createAgentTemplateRepository(db),
        agentMessageRepo: createAgentMessageRepository(db),
        onAgentMutation: this.opts.onAgentMutation,
      };
    }
    return this.agentRoutesDeps;
  }

  async connect(): Promise<void> {
    this.opts.registerGroup(WEB_JID, {
      name: 'Web UI',
      folder: MAIN_GROUP_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });

    this.server = http.createServer((req, res) => this.handleRequest(req, res));

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, '127.0.0.1', () => {
        logger.info({ port: this.port }, 'Web channel HTTP server started (bound to 127.0.0.1)');
        resolve();
      });
    });

    // Attach WebSocket upgrade handler to the HTTP server
    this.wsManager.attach(this.server!, this.auth, WEB_ALLOWED_ORIGINS);

    // Flush buffered messages when a client connects
    this.wsManager.onClientConnect(() => this.flushBuffer());

    this.wsManager.onInboundMessage((msg) => {
      const timestamp = new Date().toISOString();
      this.opts.messageBus.emit(new ChatMetadata('web', WEB_JID, { name: 'Web UI', channel: 'web', isGroup: false })).catch(() => {});
      this.opts.messageBus.emit(new InboundMessage('web', WEB_JID, {
        id: `ws-${Date.now()}`,
        chat_jid: WEB_JID,
        sender: 'web:user',
        sender_name: msg.sender_name || 'User',
        content: msg.text.trim(),
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      }, { channel: 'web' })).catch(() => {});
    });

    this.connected = true;
    logger.info('Web channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    let delivered = false;

    // Broadcast to WebSocket clients
    if (this.wsManager.clientCount() > 0) {
      this.wsManager.broadcast({ type: 'message', jid, text, sender: ASSISTANT_NAME });
      delivered = true;
    }

    // Resolve any pending SSE/HTTP request
    const entry = this.pending.get(jid);
    if (entry) {
      entry.resolve(text);
      clearTimeout(entry.timer);
      this.pending.delete(jid);
      delivered = true;
    }

    this.opts.onAuditEvent?.({
      type: 'audit.delivery_result',
      channel: 'web',
      data: { chatJid: jid, accepted: delivered, durationMs: 0 },
    });

    if (!delivered) {
      // Buffer the message for delivery when a client next connects
      this.messageBuffer.push({
        jid,
        text,
        sender: ASSISTANT_NAME,
        timestamp: new Date().toISOString(),
      });
      // Evict oldest messages if buffer is full
      if (this.messageBuffer.length > MAX_BUFFERED_MESSAGES) {
        this.messageBuffer = this.messageBuffer.slice(-MAX_BUFFERED_MESSAGES);
      }
      logger.info(
        { jid, buffered: this.messageBuffer.length },
        'No WebSocket clients — message buffered for delivery on next connect'
      );
    }
  }

  private flushBuffer(): void {
    if (this.messageBuffer.length === 0) return;
    const count = this.messageBuffer.length;
    for (const msg of this.messageBuffer) {
      this.wsManager.broadcast({
        type: 'message',
        jid: msg.jid,
        text: msg.text,
        sender: msg.sender,
        buffered: true,
        timestamp: msg.timestamp,
      });
    }
    this.messageBuffer = [];
    logger.info({ count }, 'Flushed buffered messages to new WebSocket client');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsManager.close();
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
    this.messageBuffer = [];
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }

  // -------------------------------------------------------------------------
  // HTTP request router
  // -------------------------------------------------------------------------

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // CORS: only allow configured origins (not wildcard)
    const requestOrigin = req.headers.origin ?? '';
    const allowedOrigin = WEB_ALLOWED_ORIGINS.includes(requestOrigin) ? requestOrigin : '';
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Auth: require valid Bearer token on all non-OPTIONS requests
    const authHeader = req.headers.authorization;
    if (!this.auth.validate(authHeader)) {
      logger.warn(
        { ip: req.socket.remoteAddress, path: req.url },
        'Web channel: rejected unauthenticated request',
      );
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');

    // Extract conversation ID from /conversations/:id paths
    const convoMatch = url.pathname.match(/^\/conversations\/([^/]+)$/);

    if (req.method === 'GET' && url.pathname === '/channels') {
      this.handleChannels(res);
    } else if (req.method === 'GET' && url.pathname === '/health') {
      this.handleHealth(res);
    } else if (req.method === 'GET' && url.pathname === '/history') {
      this.handleHistory(url, res);
    } else if (req.method === 'POST' && url.pathname === '/message') {
      this.handleMessage(req, res);
    } else if (req.method === 'POST' && url.pathname === '/reload-workflows') {
      this.handleReloadWorkflows(res);
    } else if (req.method === 'POST' && url.pathname === '/run-workflow') {
      this.handleBody(req, res, (body) => this.handleRunWorkflow(body, res));
    } else if (req.method === 'POST' && url.pathname === '/cancel-workflow-run') {
      this.handleBody(req, res, (body) => this.handleCancelWorkflowRun(body, res));
    } else if (req.method === 'GET' && url.pathname === '/conversations') {
      this.handleListConversations(res);
    } else if (req.method === 'POST' && url.pathname === '/conversations') {
      this.handleBody(req, res, (body) => this.handleCreateConversation(body, res));
    } else if (req.method === 'DELETE' && url.pathname === '/conversations') {
      this.handleDeleteAllConversations(res);
    } else if (convoMatch && req.method === 'PATCH') {
      this.handleBody(req, res, (body) => this.handleRenameConversation(convoMatch[1], body, res));
    } else if (convoMatch && req.method === 'DELETE') {
      this.handleDeleteConversation(convoMatch[1], res);
    } else if (url.pathname.startsWith('/api/')) {
      const handled = handleAgentRoutes(req, res, url, this.getAgentRoutesDeps());
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private handleReloadWorkflows(res: http.ServerResponse): void {
    const svc = this.opts.workflowService;
    if (!svc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow service not available' }));
      return;
    }
    try {
      svc.reloadDefinitions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      logger.error({ err }, 'Failed to reload workflow definitions');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Reload failed' }));
    }
  }

  private handleHealth(res: http.ServerResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      channel: 'web',
      connected: this.connected,
      wsClients: this.wsManager.clientCount(),
    }));
  }

  private handleChannels(res: http.ServerResponse): void {
    const names = this.opts.channelNames?.() ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ channels: names }));
  }

  private handleHistory(url: URL, res: http.ServerResponse): void {
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    const conversationId = url.searchParams.get('conversation_id');
    const jid = conversationId ? `${WEB_JID}:${conversationId}` : WEB_JID;
    try {
      const messages = getChatHistory(jid, limit);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
    } catch (err) {
      logger.error({ err }, 'Failed to fetch conversation history');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch history' }));
    }
  }

  // ── Generic body parser ──
  private handleBody(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    handler: (body: Record<string, unknown>) => void,
  ): void {
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk; });
    req.on('end', () => {
      try {
        handler(JSON.parse(raw));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  }

  // ── Run workflow (fire-and-forget) ──
  private handleRunWorkflow(body: Record<string, unknown>, res: http.ServerResponse): void {
    const svc = this.opts.workflowService;
    if (!svc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow service not available' }));
      return;
    }

    const workflowId = body.workflowId as string | undefined;
    if (!workflowId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'workflowId is required' }));
      return;
    }

    // Always reload definitions so we run the latest YAML
    svc.reloadDefinitions();

    if (svc.hasActiveRun(workflowId)) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow already has an active run' }));
      return;
    }

    // Fire-and-forget — don't await
    svc.runWorkflow(workflowId).catch((err) => {
      logger.error({ err, workflowId }, 'Workflow run failed');
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: true, workflowId }));
  }

  // ── Cancel workflow run ──
  private handleCancelWorkflowRun(body: Record<string, unknown>, res: http.ServerResponse): void {
    const svc = this.opts.workflowService;
    if (!svc) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Workflow service not available' }));
      return;
    }

    const runId = body.runId as string | undefined;
    if (!runId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'runId is required' }));
      return;
    }

    try {
      svc.cancelRun(runId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      logger.error({ err, runId }, 'Failed to cancel workflow run');
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Cancel failed' }));
    }
  }

  // -------------------------------------------------------------------------
  // POST /message — accept user message, stream agent response via SSE
  // -------------------------------------------------------------------------

  private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', () => {
      let parsed: { message: string; sender_name?: string; conversation_id?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      if (!parsed.message?.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message is required' }));
        return;
      }

      // Derive composite JID from conversation_id
      const jid = parsed.conversation_id ? `${WEB_JID}:${parsed.conversation_id}` : WEB_JID;

      // Auto-create conversation record + register the composite JID group
      if (parsed.conversation_id) {
        upsertConversation(parsed.conversation_id, 'New conversation', '');
        this.opts.registerGroup(jid, {
          name: 'Web UI',
          folder: MAIN_GROUP_FOLDER,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        });
      }

      // Start SSE response
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      const enqueue = (chunk: StreamChunk) => {
        if (!res.writableEnded) {
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      };

      // Heartbeat so the client knows we're alive
      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        enqueue({ type: 'thinking' });
      }, HEARTBEAT_INTERVAL_MS);

      // Promise resolved when agent calls sendMessage()
      const responsePromise = new Promise<string>((resolve) => {
        const timer = setTimeout(() => {
          this.pending.delete(jid);
          clearInterval(heartbeat);
          enqueue({ type: 'error', message: 'Agent did not respond within timeout' });
          enqueue({ type: 'done' });
          res.end();
        }, RESPONSE_TIMEOUT_MS);

        this.pending.set(jid, { resolve, timer });
      });

      // Cleanup on client disconnect
      res.on('close', () => {
        clearInterval(heartbeat);
        const entry = this.pending.get(jid);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(jid);
        }
      });

      // Audit: webhook received (web has full HTTP metadata)
      this.opts.onAuditEvent?.({
        type: 'audit.webhook_received',
        channel: 'web',
        data: {
          sourceIp: req.socket.remoteAddress ?? 'unknown',
          method: 'POST',
          path: '/message',
          userAgent: req.headers['user-agent'] ?? '',
          authProvided: true,
          authValid: true,
          responseCode: 200,
          durationMs: 0,
          contentLength: body.length,
        },
      });

      // Build and emit the inbound message
      const timestamp = new Date().toISOString();
      const message: NewMessage = {
        id: `web-${Date.now()}`,
        chat_jid: jid,
        sender: 'web:user',
        sender_name: parsed.sender_name || 'User',
        content: parsed.message.trim(),
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.messageBus.emit(new ChatMetadata('web', jid, { name: 'Web UI', channel: 'web', isGroup: false })).catch(() => {});
      this.opts.messageBus.emit(new InboundMessage('web', jid, message, { channel: 'web' })).catch(() => {});

      // When agent responds, send the full text and close the stream
      responsePromise.then((text) => {
        clearInterval(heartbeat);
        if (!res.writableEnded) {
          enqueue({ type: 'delta', text });
          enqueue({ type: 'done' });
          res.end();
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Conversation CRUD endpoints
  // -------------------------------------------------------------------------

  private handleListConversations(res: http.ServerResponse): void {
    try {
      const conversations = listConversations();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversations }));
    } catch (err) {
      logger.error({ err }, 'Failed to list conversations');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to list conversations' }));
    }
  }

  private handleCreateConversation(body: Record<string, unknown>, res: http.ServerResponse): void {
    const id = (body.id as string) || randomUUID();
    const title = (body.title as string) || 'New conversation';
    try {
      upsertConversation(id, title, '');
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, title }));
    } catch (err) {
      logger.error({ err }, 'Failed to create conversation');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to create conversation' }));
    }
  }

  private handleRenameConversation(id: string, body: Record<string, unknown>, res: http.ServerResponse): void {
    const title = body.title as string | undefined;
    if (!title) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'title is required' }));
      return;
    }
    try {
      dbRenameConversation(id, title);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      logger.error({ err }, 'Failed to rename conversation');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to rename conversation' }));
    }
  }

  private handleDeleteConversation(id: string, res: http.ServerResponse): void {
    try {
      dbDeleteConversation(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      logger.error({ err }, 'Failed to delete conversation');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete conversation' }));
    }
  }

  private handleDeleteAllConversations(res: http.ServerResponse): void {
    try {
      const deleted = dbDeleteAllConversations();
      logger.info({ deleted }, 'All conversations deleted via web channel');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, deleted }));
    } catch (err) {
      logger.error({ err }, 'Failed to delete all conversations');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete all conversations' }));
    }
  }
}
