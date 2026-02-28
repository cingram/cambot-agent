import http from 'http';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from '../config.js';
import { getChatHistory } from '../db.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts, NewMessage } from '../types.js';

const WEB_JID = 'web:ui';
const RESPONSE_TIMEOUT_MS = 180_000; // 3 minutes
const HEARTBEAT_INTERVAL_MS = 2_000;
const DEFAULT_PORT = 3100;

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

  constructor(opts: ChannelOpts, port?: number) {
    this.opts = opts;
    this.port = port ?? DEFAULT_PORT;
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
      this.server!.listen(this.port, () => {
        logger.info({ port: this.port }, 'Web channel HTTP server started');
        resolve();
      });
    });

    this.connected = true;
    logger.info('Web channel connected');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const entry = this.pending.get(jid);
    if (!entry) {
      logger.warn({ jid }, 'No pending web request for JID');
      return;
    }
    entry.resolve(text);
    clearTimeout(entry.timer);
    this.pending.delete(jid);
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('web:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
    }
    this.pending.clear();
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', 'http://localhost');

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
    res.end(JSON.stringify({ status: 'ok', channel: 'web', connected: this.connected }));
  }

  private handleChannels(res: http.ServerResponse): void {
    const names = this.opts.channelNames?.() ?? [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ channels: names }));
  }

  private handleHistory(url: URL, res: http.ServerResponse): void {
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    try {
      const messages = getChatHistory(WEB_JID, limit);
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

  private handleMessage(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk;
    });

    req.on('end', () => {
      let parsed: { message: string; sender_name?: string };
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
          this.pending.delete(WEB_JID);
          clearInterval(heartbeat);
          enqueue({ type: 'error', message: 'Agent did not respond within timeout' });
          enqueue({ type: 'done' });
          res.end();
        }, RESPONSE_TIMEOUT_MS);

        this.pending.set(WEB_JID, { resolve, timer });
      });

      // Cleanup on client disconnect
      res.on('close', () => {
        clearInterval(heartbeat);
        const entry = this.pending.get(WEB_JID);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(WEB_JID);
        }
      });

      // Build and emit the inbound message
      const timestamp = new Date().toISOString();
      const message: NewMessage = {
        id: `web-${Date.now()}`,
        chat_jid: WEB_JID,
        sender: 'web:user',
        sender_name: parsed.sender_name || 'User',
        content: parsed.message.trim(),
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      };

      this.opts.messageBus.emitAsync({
        type: 'chat.metadata',
        source: 'web',
        timestamp,
        data: { jid: WEB_JID, timestamp, name: 'Web UI', channel: 'web', isGroup: false },
      }).catch(() => {});
      this.opts.messageBus.emitAsync({
        type: 'message.inbound',
        source: 'web',
        timestamp,
        data: { jid: WEB_JID, message, channel: 'web' },
      }).catch(() => {});

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
}
