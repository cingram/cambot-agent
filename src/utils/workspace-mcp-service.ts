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

export function createWorkspaceMcpService(config: WorkspaceMcpConfig): WorkspaceMcpService {
  let process_: ChildProcess | null = null;
  let running = false;
  let retryCount = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function spawnProcess(): ChildProcess {
    const args = [
      '--from', 'git+https://github.com/taylorwilsdon/google_workspace_mcp',
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
          retryCount = 0; // Reset on successful start
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
