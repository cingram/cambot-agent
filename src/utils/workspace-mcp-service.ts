/**
 * Workspace MCP Service — manages the google_workspace_mcp subprocess on the host.
 *
 * Spawns `uvx workspace-mcp` as a persistent HTTP service that Docker containers
 * connect to via `http://host.docker.internal:{port}/mcp`.
 *
 * Features:
 * - Auto-restart on crash (max 3 retries, exponential backoff)
 * - Health check via HTTP GET
 * - Graceful shutdown (SIGTERM → wait → SIGKILL)
 * - Automatic OAuth re-auth: opens browser when Google tokens need renewal
 */
import { ChildProcess, spawn } from 'child_process';

import { logger } from '../logger.js';

export interface WorkspaceMcpConfig {
  port: number;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  userGoogleEmail: string;
}

export interface WorkspaceMcpService {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  /** URL for containers: http://host.docker.internal:{port}/mcp */
  getUrl(): string;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 2000;
const HEALTH_CHECK_TIMEOUT_MS = 5000;
const SHUTDOWN_GRACE_MS = 5000;

/**
 * After server is healthy, probe it with an MCP tool call to check if
 * Google OAuth tokens are valid. If re-auth is needed, the server returns
 * an authorization URL — we open it in the user's browser automatically
 * and wait for the callback to complete.
 */
async function ensureGoogleAuth(port: number, email: string): Promise<void> {
  const url = `http://127.0.0.1:${port}/mcp`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream, application/json',
  };

  // Step 1: Initialize MCP session
  let rpcId = 1;
  const initRes = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'cambot-agent-auth-check', version: '1.0' },
      },
    }),
  });

  const sessionId = initRes.headers.get('mcp-session-id') || '';
  const sessionHeaders = { ...headers, 'Mcp-Session-Id': sessionId };

  // Send initialized notification
  await fetch(url, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  // Step 2: Probe with a lightweight tool call (list Gmail labels)
  const probeRes = await fetch(url, {
    method: 'POST',
    headers: sessionHeaders,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId++,
      method: 'tools/call',
      params: {
        name: 'list_gmail_labels',
        arguments: { user_google_email: email },
      },
    }),
  });

  const probeText = await probeRes.text();

  // Extract the JSON-RPC result from SSE
  const dataLines = probeText.split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => l.slice(6));

  for (const line of dataLines) {
    try {
      const obj = JSON.parse(line);
      const content = obj?.result?.content?.[0]?.text || '';

      if (!content.includes('ACTION REQUIRED') && !content.includes('Authentication Needed')) {
        logger.info('Google Workspace OAuth credentials are valid');
        return;
      }

      // Extract the authorization URL
      const urlMatch = content.match(/Authorization URL:\s*(https:\/\/accounts\.google\.com\S+)/);
      if (!urlMatch) {
        logger.warn('Google auth required but could not extract authorization URL');
        return;
      }

      const authUrl = urlMatch[1];
      logger.info('Google OAuth re-authorization required — opening browser');

      // Open browser cross-platform (use execFile to avoid shell injection)
      const { execFile: execFileCb } = await import('child_process');
      if (process.platform === 'win32') {
        execFileCb('cmd', ['/c', 'start', '', authUrl], { timeout: 5000 });
      } else if (process.platform === 'darwin') {
        execFileCb('open', [authUrl], { timeout: 5000 });
      } else {
        execFileCb('xdg-open', [authUrl], { timeout: 5000 });
      }

      // Wait for the OAuth callback (poll until a probe succeeds)
      const authDeadline = Date.now() + 120_000; // 2 minutes
      logger.info('Waiting up to 2 minutes for Google OAuth consent...');

      while (Date.now() < authDeadline) {
        await new Promise((r) => setTimeout(r, 3000));

        try {
          const retryRes = await fetch(url, {
            method: 'POST',
            headers: sessionHeaders,
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: rpcId++,
              method: 'tools/call',
              params: {
                name: 'list_gmail_labels',
                arguments: { user_google_email: email },
              },
            }),
          });

          const retryText = await retryRes.text();
          if (!retryText.includes('ACTION REQUIRED') && !retryText.includes('Authentication Needed')) {
            logger.info('Google OAuth re-authorization completed successfully');
            return;
          }
        } catch {
          // Server may be restarting, keep polling
        }
      }

      logger.warn('Google OAuth consent timed out — Gmail tools may not work until authorized');
      return;
    } catch {
      // Not valid JSON, skip
    }
  }
}

/**
 * Kill any existing process bound to the given port.
 * Prevents port conflicts when the app restarts without a clean shutdown.
 */
async function killExistingOnPort(port: number): Promise<void> {
  const { exec: execCb } = await import('child_process');
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      // Find PID listening on the port via netstat, then taskkill
      execCb(
        `for /f "tokens=5" %a in ('netstat -ano ^| findstr ":${port}" ^| findstr "LISTENING"') do taskkill /PID %a /F`,
        { shell: 'cmd.exe', timeout: 5000 },
        (err) => {
          if (err) logger.debug({ port, err: err.message }, 'No stale process on port (or kill failed)');
          else logger.info({ port }, 'Killed stale process on port');
          resolve();
        },
      );
    } else {
      execCb(`lsof -ti:${port} | xargs -r kill -9`, { timeout: 5000 }, (err) => {
        if (err) logger.debug({ port, err: err.message }, 'No stale process on port (or kill failed)');
        else logger.info({ port }, 'Killed stale process on port');
        resolve();
      });
    }
  });
}

export function createWorkspaceMcpService(config: WorkspaceMcpConfig): WorkspaceMcpService {
  let process_: ChildProcess | null = null;
  let running = false;
  let retryCount = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function spawnProcess(): ChildProcess {
    // Pinned to a release tag to prevent upstream breaking changes.
    // To upgrade: update the version, test, then commit.
    // Releases: https://github.com/taylorwilsdon/google_workspace_mcp/tags
    const WORKSPACE_MCP_REF = 'v1.14.2';
    const args = [
      '--from', `git+https://github.com/taylorwilsdon/google_workspace_mcp@${WORKSPACE_MCP_REF}`,
      'workspace-mcp',
      '--transport', 'streamable-http',
      '--single-user',
    ];

    const env: Record<string, string> = {
      ...Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] != null),
      ),
      GOOGLE_OAUTH_CLIENT_ID: config.googleOAuthClientId,
      GOOGLE_OAUTH_CLIENT_SECRET: config.googleOAuthClientSecret,
      USER_GOOGLE_EMAIL: config.userGoogleEmail,
      WORKSPACE_MCP_PORT: String(config.port),
      WORKSPACE_MCP_HOST: '127.0.0.1',
      // Required for local HTTP (non-HTTPS) OAuth flow
      OAUTHLIB_INSECURE_TRANSPORT: '1',
    };

    logger.info(
      { port: config.port, email: config.userGoogleEmail },
      'Spawning workspace-mcp process',
    );

    const child = spawn('uvx', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
      // Shell needed on Windows for uvx to resolve correctly
      shell: process.platform === 'win32',
    });

    child.stdout?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) logger.debug({ service: 'workspace-mcp' }, line);
    });

    child.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line) logger.debug({ service: 'workspace-mcp' }, line);
    });

    child.on('error', (err) => {
      logger.error({ err }, 'workspace-mcp spawn error');
      running = false;
      scheduleRestart();
    });

    child.on('close', (code) => {
      running = false;
      if (stopping) {
        logger.info({ code }, 'workspace-mcp stopped');
        return;
      }
      logger.warn({ code }, 'workspace-mcp exited unexpectedly');
      scheduleRestart();
    });

    return child;
  }

  function scheduleRestart(): void {
    if (stopping) return;
    if (retryCount >= MAX_RETRIES) {
      logger.error(
        { retries: retryCount },
        'workspace-mcp exceeded max retries, giving up',
      );
      return;
    }

    const delay = BASE_BACKOFF_MS * Math.pow(2, retryCount);
    retryCount++;
    logger.info(
      { retryCount, delayMs: delay },
      'Scheduling workspace-mcp restart',
    );

    restartTimer = setTimeout(() => {
      restartTimer = null;
      if (stopping) return;
      process_ = spawnProcess();
      running = true;
    }, delay);
  }

  async function healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
      const res = await fetch(`http://127.0.0.1:${config.port}/mcp`, {
        method: 'GET',
        signal: controller.signal,
      });
      clearTimeout(timeout);
      // MCP servers may return various status codes on GET; a response means it's alive
      return res.status < 500;
    } catch {
      return false;
    }
  }

  return {
    async start(): Promise<void> {
      if (running) return;
      stopping = false;
      retryCount = 0;

      // Kill any stale process from a previous unclean shutdown
      await killExistingOnPort(config.port);

      process_ = spawnProcess();
      running = true;

      // Wait for the service to become healthy (up to 15s)
      const maxWait = 15_000;
      const pollInterval = 1000;
      const deadline = Date.now() + maxWait;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, pollInterval));
        if (await healthCheck()) {
          logger.info({ port: config.port }, 'workspace-mcp is healthy');
          retryCount = 0;

          // Verify Google OAuth tokens and auto-open browser if re-auth needed
          try {
            await ensureGoogleAuth(config.port, config.userGoogleEmail);
          } catch (err) {
            logger.warn({ err }, 'Google OAuth check failed (non-fatal)');
          }
          return;
        }
      }

      // Not healthy yet, but the process may still be starting (first-time OAuth flow)
      logger.warn(
        { port: config.port },
        'workspace-mcp did not pass health check within timeout — may need OAuth consent',
      );
    },

    async stop(): Promise<void> {
      stopping = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      if (!process_ || !running) return;

      const child = process_;
      process_ = null;

      // Graceful shutdown: SIGTERM first
      child.kill('SIGTERM');

      await new Promise<void>((resolve) => {
        const forceKill = setTimeout(() => {
          logger.warn('workspace-mcp did not exit gracefully, sending SIGKILL');
          child.kill('SIGKILL');
          resolve();
        }, SHUTDOWN_GRACE_MS);

        child.on('close', () => {
          clearTimeout(forceKill);
          resolve();
        });
      });

      running = false;
    },

    isRunning(): boolean {
      return running;
    },

    getUrl(): string {
      return `http://host.docker.internal:${config.port}/mcp`;
    },
  };
}
