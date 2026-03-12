/**
 * McpHttpClient — minimal MCP streamable-HTTP client with session management.
 *
 * Extracted from email.ts to keep single responsibility per module.
 * Used by email handlers to communicate with workspace-mcp.
 */

/**
 * Minimal MCP streamable-http client with session management.
 * The server requires: initialize -> get session ID -> include it in all calls.
 */
export class McpHttpClient {
  private rpcId = 1;
  private sessionId: string | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(private url: string) {}

  private parseSSE(text: string): unknown {
    const dataLines = text.split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => l.slice(6));
    for (let i = dataLines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(dataLines[i]);
        if (obj.result !== undefined || obj.error !== undefined) return obj;
      } catch { /* skip */ }
    }
    throw new Error('No JSON-RPC response found in SSE stream');
  }

  private async rpc(method: string, params: Record<string, unknown>): Promise<{
    result?: { content?: Array<{ text?: string }> };
    error?: { message: string };
  }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream, application/json',
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    const res = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: this.rpcId++,
        method,
        params,
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) throw new Error(`MCP HTTP error: ${res.status} ${res.statusText}`);

    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream')) {
      return this.parseSSE(await res.text()) as Awaited<ReturnType<McpHttpClient['rpc']>>;
    }
    return res.json() as ReturnType<McpHttpClient['rpc']>;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = (async () => {
      try {
        await this.rpc('initialize', {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'cambot-agent', version: '1.0' },
        });
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, application/json',
        };
        if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
        await fetch(this.url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
          signal: AbortSignal.timeout(30_000),
        });
        this.initialized = true;
      } catch (err) {
        this.initPromise = null;
        throw err;
      }
    })();

    return this.initPromise;
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<unknown> {
    await this.ensureInitialized();
    const json = await this.rpc('tools/call', { name: tool, arguments: args });
    if (json.error) throw new Error(`MCP tool error: ${json.error.message}`);

    const textParts = json.result?.content
      ?.filter((c) => c.text)
      .map((c) => c.text)
      .join('');

    if (textParts) {
      try { return JSON.parse(textParts); } catch { return textParts; }
    }
    return json.result;
  }

  reset(): void {
    this.sessionId = null;
    this.initialized = false;
    this.initPromise = null;
  }
}

// ── Lazy-initialized client cache ─────────────────────────

const mcpClients = new Map<string, McpHttpClient>();

function getMcpClient(url: string): McpHttpClient {
  let client = mcpClients.get(url);
  if (!client) {
    client = new McpHttpClient(url);
    mcpClients.set(url, client);
  }
  return client;
}

function isRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return msg.includes('session') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('fetch failed');
}

/**
 * Call a workspace-mcp tool with automatic session retry.
 * Retries on session errors and transient connection failures (ECONNREFUSED, ECONNRESET).
 */
export async function callWorkspaceMcp(
  url: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const client = getMcpClient(url);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await client.callTool(tool, args);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRetryable(lastError) || attempt === 2) throw lastError;
      client.reset();
      // Back off before retry: 2s, then 4s
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
  throw lastError!;
}
