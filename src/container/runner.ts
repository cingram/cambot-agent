/**
 * Container Runner for CamBot-Agent
 * Spawns agent execution in containers and communicates via cambot-socket TCP.
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CAMBOT_SOCKET_PORT,
  CONTAINER_MAX_OUTPUT_SIZE,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  EMAIL_GUARDRAIL_ENABLED,
  IDLE_TIMEOUT,
  MEMORY_MODE,
  TIMEZONE,
} from '../config/config.js';
import type { MemoryMode } from '../config/config.js';
import { readEnvFile } from '../config/env.js';
import { resolveGroupFolderPath } from '../groups/group-folder.js';
import { logger } from '../logger.js';
import { CONTAINER_RUNTIME_BIN, killContainersForGroup, readonlyMountArgs, stopContainer } from './runtime.js';
import { validateAdditionalMounts } from './mount-security.js';
import { ExecutionContext } from '../types.js';
import { AgentOptions } from '../agents/agents.js';
import { writeContextFiles, type ContextFileDeps } from '../utils/context-files.js';
import type { CambotSocketServer } from '../cambot-socket/server.js';
import { registerOutputCallback, removeOutputCallback } from '../cambot-socket/handlers/output.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  /** Claude model override (e.g. 'claude-opus-4-6'). Falls back to SDK default. */
  model?: string;
  secrets?: Record<string, string>;
  /** Active MCP servers to expose to the container agent */
  mcpServers?: Array<{ name: string; transport: 'http' | 'sse'; url: string }>;
  /** Which memory system the agent should use */
  memoryMode?: MemoryMode;
  customAgent?: {
    agentId: string;
    provider: 'openai' | 'xai' | 'anthropic' | 'google';
    model: string;
    baseUrl?: string;
    apiKeyEnvVar: string;
    systemPrompt: string;
    tools: string[];
    maxTokens?: number;
    temperature?: number;
    maxIterations?: number;
    timeoutMs?: number;
  };
  /** When true, agent was spawned via send_to_agent — restricted MCP tools */
  isInterAgentTarget?: boolean;
  /** Enable inline Haiku guardrail for tool call review */
  guardrailEnabled?: boolean;
  /** Port of the CambotSocketServer on the host */
  socketPort?: number;
  /** One-time token for TCP handshake authentication */
  socketToken?: string;
  /** Separate one-time token for the MCP stdio subprocess's TCP connection */
  mcpSocketToken?: string;
  /** Group identifier for the MCP stdio subprocess's TCP connection */
  mcpSocketGroup?: string;
  /** SDK tools this agent is allowed to use (resolved from ToolPolicy) */
  allowedSdkTools?: string[];
  /** SDK tools hard-blocked via the SDK's disallowedTools parameter */
  disallowedSdkTools?: string[];
  /** MCP tools this agent is allowed to use (resolved from ToolPolicy on host) */
  allowedMcpTools?: string[];
  /** Dynamic context files (identity, soul, tools, etc.) written before spawn.
   *  When provided, runContainerAgent writes context files automatically. */
  agentContext?: ContextFileDeps;
}

export interface ContainerTelemetry {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  usage: { inputTokens: number; outputTokens: number };
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
  toolInvocations: Array<{
    toolName: string;
    durationMs?: number;
    status: 'success' | 'error';
    inputSummary?: string;
    outputSummary?: string;
    error?: string;
  }>;
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  telemetry?: ContainerTelemetry;
}

interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

function buildVolumeMounts(execution: ExecutionContext): VolumeMount[] {
  const mounts: VolumeMount[] = [];
  const projectRoot = process.cwd();
  const groupDir = resolveGroupFolderPath(execution.folder);

  if (execution.isMain) {
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    if (fs.existsSync(STORE_DIR)) {
      mounts.push({
        hostPath: STORE_DIR,
        containerPath: '/workspace/project/store',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  const groupSessionsDir = path.join(
    DATA_DIR,
    'sessions',
    execution.folder,
    '.claude',
  );
  fs.mkdirSync(groupSessionsDir, { recursive: true });
  const settingsFile = path.join(groupSessionsDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({
      env: {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
  }

  // Sync template files into each group's .claude/ directory
  const containerDir = path.join(process.cwd(), 'container');
  const claudeMdSrc = path.join(containerDir, 'CLAUDE.md');
  if (fs.existsSync(claudeMdSrc)) {
    fs.copyFileSync(claudeMdSrc, path.join(groupSessionsDir, 'CLAUDE.md'));
  }

  // MCP servers template — substitute host-side variables before writing
  const mcpSrc = path.join(containerDir, 'mcp-servers.json');
  if (fs.existsSync(mcpSrc)) {
    const hostVars: Record<string, string> = {
      WORKSPACE_MCP_PORT: String(
        process.env.WORKSPACE_MCP_PORT || '8000',
      ),
    };
    let mcpContent = fs.readFileSync(mcpSrc, 'utf-8');
    for (const [key, value] of Object.entries(hostVars)) {
      mcpContent = mcpContent.replaceAll(`\${${key}}`, value);
    }
    fs.writeFileSync(path.join(groupSessionsDir, 'mcp-servers.json'), mcpContent);
  }

  // Sync skills from container/skills/ into each group's .claude/skills/
  const skillsSrc = path.join(process.cwd(), 'container', 'skills');
  const skillsDst = path.join(groupSessionsDir, 'skills');
  if (fs.existsSync(skillsSrc)) {
    for (const skillDir of fs.readdirSync(skillsSrc)) {
      const srcDir = path.join(skillsSrc, skillDir);
      if (!fs.statSync(srcDir).isDirectory()) continue;
      const dstDir = path.join(skillsDst, skillDir);
      fs.cpSync(srcDir, dstDir, { recursive: true });
    }
  }
  mounts.push({
    hostPath: groupSessionsDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Context directory — context files written before spawn
  const contextDir = path.join(DATA_DIR, 'sessions', execution.folder, 'context');
  fs.mkdirSync(contextDir, { recursive: true });
  mounts.push({
    hostPath: contextDir,
    containerPath: '/workspace/context',
    readonly: true,
  });

  // Snapshots directory — tasks, agents, workflows, groups, workers, raw_content
  // Written by snapshot-writers.ts before spawn, read by container MCP tools
  const snapshotsDir = path.join(DATA_DIR, 'sessions', execution.folder);
  mounts.push({
    hostPath: snapshotsDir,
    containerPath: '/workspace/snapshots',
    readonly: true,
  });

  // Sync agent-runner source into a per-group writable location.
  // Clean first to remove stale files from previous code versions.
  const agentRunnerSrc = path.join(projectRoot, 'agent-runner', 'src');
  const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', execution.folder, 'agent-runner-src');
  if (fs.existsSync(agentRunnerSrc)) {
    if (fs.existsSync(groupAgentRunnerDir)) {
      fs.rmSync(groupAgentRunnerDir, { recursive: true, force: true });
    }
    fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, {
      recursive: true,
      filter: (src) => !src.endsWith('.test.ts'),
    });
  }
  mounts.push({
    hostPath: groupAgentRunnerDir,
    containerPath: '/app/src',
    readonly: false,
  });

  // Sync cambot-llm source. Clean first to remove stale files.
  const cambotAgentsSrc = path.resolve(projectRoot, '..', 'cambot-llm', 'src');
  const groupCambotAgentsDir = path.join(DATA_DIR, 'sessions', execution.folder, 'cambot-llm-src');
  if (fs.existsSync(cambotAgentsSrc)) {
    if (fs.existsSync(groupCambotAgentsDir)) {
      fs.rmSync(groupCambotAgentsDir, { recursive: true, force: true });
    }
    fs.cpSync(cambotAgentsSrc, groupCambotAgentsDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupCambotAgentsDir,
    containerPath: '/cambot-llm/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist
  if (execution.containerConfig?.additionalMounts) {
    const validatedMounts = validateAdditionalMounts(
      execution.containerConfig.additionalMounts,
      execution.name,
      execution.isMain,
    );
    mounts.push(...validatedMounts);
  }

  return mounts;
}

/**
 * Read allowed secrets from .env for passing to the container via stdin.
 * Secrets are never written to disk or mounted as files.
 */
function readSecrets(secretKeys: string[]): Record<string, string> {
  const secrets = readEnvFile(secretKeys);
  if (!secrets['GOOGLE_API_KEY']) {
    const gemini = readEnvFile(['GEMINI_API_KEY']);
    if (gemini['GEMINI_API_KEY']) {
      secrets['GOOGLE_API_KEY'] = gemini['GEMINI_API_KEY'];
    }
  }
  return secrets;
}

function buildContainerArgs(mounts: VolumeMount[], containerName: string, containerImage: string): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  args.push('-e', `TZ=${TIMEZONE}`);

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
  }

  // On Linux, add host gateway so containers can reach the socket server
  if (process.platform === 'linux') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  for (const mount of mounts) {
    if (mount.readonly) {
      args.push(...readonlyMountArgs(mount.hostPath, mount.containerPath));
    } else {
      args.push('-v', `${mount.hostPath}:${mount.containerPath}`);
    }
  }

  args.push(containerImage);

  return args;
}

export async function runContainerAgent(
  execution: ExecutionContext,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput: ((output: ContainerOutput) => Promise<void>) | undefined,
  agentOptions: AgentOptions,
  socketServer?: CambotSocketServer,
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(execution.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(execution);
  const safeName = execution.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `cambot-agent-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, agentOptions.containerImage);

  // Generate socket tokens: one for the main agent, one for the MCP stdio subprocess.
  // Tokens are one-time use, so each connection needs its own token.
  const ts = Date.now();
  const socketToken = `cambot-socket-${safeName}-${ts}`;
  const mcpSocketToken = `cambot-socket-mcp-${safeName}-${ts}`;
  const mcpGroup = `${execution.folder}:mcp`;
  if (socketServer) {
    // Authorize the container to send messages to its chatJid (needed for
    // gateway delegation where a non-main agent sends to the caller's JID).
    const authorizedJids = input.chatJid ? new Set([input.chatJid]) : undefined;
    socketServer.registerToken(execution.folder, socketToken, authorizedJids);
    socketServer.registerToken(mcpGroup, mcpSocketToken);
  }

  // Write dynamic context files (identity, soul, tools, channels, etc.)
  if (input.agentContext) {
    const contextDir = path.join(DATA_DIR, 'sessions', execution.folder, 'context');
    fs.mkdirSync(contextDir, { recursive: true });
    writeContextFiles(contextDir, execution.isMain, input.agentContext);
  }

  input.socketToken = socketToken;
  input.socketPort = CAMBOT_SOCKET_PORT;
  input.mcpSocketToken = mcpSocketToken;
  input.mcpSocketGroup = mcpGroup;

  logger.debug(
    {
      group: execution.name,
      containerName,
      mounts: mounts.map(
        (m) =>
          `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
      ),
      containerArgs: containerArgs.join(' '),
    },
    'Container mount configuration',
  );

  logger.info(
    {
      group: execution.name,
      containerName,
      mountCount: mounts.length,
      isMain: execution.isMain,
    },
    'Spawning container agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  // Kill any stale containers for this group before spawning a new one.
  killContainersForGroup(execution.folder);

  return new Promise((resolve) => {
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let hadStreamingOutput = false;
    let stderr = '';
    let stderrTruncated = false;

    // Idle timeout — if no output after IDLE_TIMEOUT, stop the container
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.info(
          { group: execution.name, containerName },
          'Idle timeout reached, stopping container',
        );
        exec(stopContainer(containerName), { timeout: 15_000 }, (err) => {
          if (err) {
            logger.warn({ containerName, err }, 'docker stop failed during idle timeout');
          }
        });
      }, IDLE_TIMEOUT);
    };

    // Register output callback BEFORE spawning so no output frames are lost.
    // The registry dispatches output frames to this callback immediately
    // when they arrive, regardless of connection polling timing.
    if (onOutput) {
      registerOutputCallback(execution.folder, (payload: ContainerOutput) => {
        if (payload.newSessionId) {
          newSessionId = payload.newSessionId;
        }
        hadStreamingOutput = true;
        resetIdleTimer();
        outputChain = outputChain
          .then(() => onOutput(payload))
          .catch((err) => {
            logger.error(
              { group: execution.name, error: err },
              'onOutput callback failed — output dropped but chain preserved',
            );
          });
      });
    }

    // Spawn the container
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets(agentOptions.secretKeys);
    input.memoryMode = MEMORY_MODE;
    input.guardrailEnabled = EMAIL_GUARDRAIL_ENABLED;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets and ephemeral fields from input so they don't appear in logs
    delete input.secrets;
    delete input.socketToken;
    delete input.mcpSocketToken;
    delete input.mcpSocketGroup;
    delete input.agentContext;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: execution.folder }, line);
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: execution.folder }, line);
      }
      if (stderrTruncated) return;
      const remaining = CONTAINER_MAX_OUTPUT_SIZE - stderr.length;
      if (chunk.length > remaining) {
        stderr += chunk.slice(0, remaining);
        stderrTruncated = true;
        logger.warn(
          { group: execution.name, size: stderr.length },
          'Container stderr truncated due to size limit',
        );
      } else {
        stderr += chunk;
      }
    });

    container.on('close', (code) => {
      if (idleTimer) clearTimeout(idleTimer);

      // Clean up output callback and revoke socket tokens on container exit
      removeOutputCallback(execution.folder);
      if (socketServer) {
        socketServer.revokeToken(socketToken);
        socketServer.revokeToken(mcpSocketToken);
      }

      const duration = Date.now() - startTime;

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const logFile = path.join(logsDir, `container-${timestamp}.log`);
      const isVerbose = process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';

      const logLines = [
        `=== Container Run Log ===`,
        `Timestamp: ${new Date().toISOString()}`,
        `Group: ${execution.name}`,
        `IsMain: ${execution.isMain}`,
        `Duration: ${duration}ms`,
        `Exit Code: ${code}`,
        `Stderr Truncated: ${stderrTruncated}`,
        ``,
      ];

      const isError = code !== 0;

      if (isVerbose || isError) {
        logLines.push(
          `=== Input ===`,
          JSON.stringify(input, null, 2),
          ``,
          `=== Container Args ===`,
          containerArgs.join(' '),
          ``,
          `=== Mounts ===`,
          mounts
            .map(
              (m) =>
                `${m.hostPath} -> ${m.containerPath}${m.readonly ? ' (ro)' : ''}`,
            )
            .join('\n'),
          ``,
          `=== Stderr${stderrTruncated ? ' (TRUNCATED)' : ''} ===`,
          stderr,
        );
      } else {
        logLines.push(
          `=== Input Summary ===`,
          `Prompt length: ${input.prompt.length} chars`,
          `Session ID: ${input.sessionId || 'new'}`,
          ``,
          `=== Mounts ===`,
          mounts
            .map((m) => `${m.containerPath}${m.readonly ? ' (ro)' : ''}`)
            .join('\n'),
          ``,
        );
      }

      fs.writeFileSync(logFile, logLines.join('\n'));
      logger.debug({ logFile, verbose: isVerbose }, 'Container log written');

      if (code !== 0) {
        // Non-zero exit after output = likely idle or heartbeat shutdown
        if (hadStreamingOutput) {
          logger.info(
            { group: execution.name, containerName, duration, code },
            'Container exited after output (idle shutdown)',
          );
          outputChain
            .catch((err) => {
              logger.error(
                { group: execution.name, error: err },
                'Output chain had unhandled error during shutdown cleanup',
              );
            })
            .then(() => {
              resolve({
                status: 'success',
                result: null,
                newSessionId,
              });
            });
          return;
        }

        logger.error(
          {
            group: execution.name,
            code,
            duration,
            stderr,
            logFile,
          },
          'Container exited with error',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Container exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      // Streaming mode: wait for output chain to settle, return completion marker.
      if (onOutput) {
        outputChain
          .catch((err) => {
            logger.error(
              { group: execution.name, error: err },
              'Output chain had unhandled error, resolving anyway',
            );
          })
          .then(() => {
            logger.info(
              { group: execution.name, duration, newSessionId },
              'Container completed (streaming mode)',
            );
            resolve({
              status: 'success',
              result: null,
              newSessionId,
            });
          });
        return;
      }

      // No streaming output handler — treat as success with no result
      logger.info(
        { group: execution.name, duration },
        'Container completed',
      );
      resolve({
        status: 'success',
        result: null,
        newSessionId,
      });
    });

    container.on('error', (err) => {
      if (idleTimer) clearTimeout(idleTimer);
      removeOutputCallback(execution.folder);
      if (socketServer) {
        socketServer.revokeToken(socketToken);
        socketServer.revokeToken(mcpSocketToken);
      }
      logger.error({ group: execution.name, containerName, error: err }, 'Container spawn error');
      resolve({
        status: 'error',
        result: null,
        error: `Container spawn error: ${err.message}`,
      });
    });
  });
}


/**
 * Run a stateless worker agent for delegation.
 * Simplified single-turn: no session management, no idle timeout, no follow-up messages.
 */
export async function runWorkerAgent(
  leadGroupFolder: string,
  delegationId: string,
  prompt: string,
  agentOptions: AgentOptions,
  socketServer?: CambotSocketServer,
): Promise<ContainerOutput> {
  const startTime = Date.now();
  const WORKER_TIMEOUT_MS = 300_000; // 5 minutes

  // Create a temporary workspace for the worker
  const workerDir = path.join(DATA_DIR, 'workers', delegationId);
  fs.mkdirSync(workerDir, { recursive: true });

  const mounts: VolumeMount[] = [
    {
      hostPath: workerDir,
      containerPath: '/workspace/group',
      readonly: false,
    },
  ];

  // Give worker read-only access to the lead group's data for context
  const leadGroupDir = resolveGroupFolderPath(leadGroupFolder);
  if (fs.existsSync(leadGroupDir)) {
    mounts.push({
      hostPath: leadGroupDir,
      containerPath: '/workspace/lead-context',
      readonly: true,
    });
  }

  // Worker gets its own minimal .claude/ directory
  const workerSessionDir = path.join(workerDir, '.claude');
  fs.mkdirSync(workerSessionDir, { recursive: true });
  const settingsFile = path.join(workerSessionDir, 'settings.json');
  if (!fs.existsSync(settingsFile)) {
    fs.writeFileSync(settingsFile, JSON.stringify({}, null, 2) + '\n');
  }
  mounts.push({
    hostPath: workerSessionDir,
    containerPath: '/home/node/.claude',
    readonly: false,
  });

  // Worker gets agent-runner source (read-only from canonical source)
  const agentRunnerSrc = path.join(process.cwd(), 'agent-runner', 'src');
  if (fs.existsSync(agentRunnerSrc)) {
    mounts.push({
      hostPath: agentRunnerSrc,
      containerPath: '/app/src',
      readonly: true,
    });
  }

  const containerName = `cambot-worker-${delegationId}`;
  const containerArgs = buildContainerArgs(mounts, containerName, agentOptions.containerImage);

  // Workers get a unique group identifier so they don't supersede
  // the lead group's connection in the socket server.
  const workerGroup = `${leadGroupFolder}:worker-${delegationId}`;

  // Generate socket token and register with server under the worker group
  const socketToken = `cambot-socket-worker-${delegationId}`;
  if (socketServer) {
    socketServer.registerToken(workerGroup, socketToken);
  }

  logger.info(
    { delegationId, containerName, workerGroup },
    'Spawning worker container',
  );

  const input: ContainerInput = {
    prompt,
    groupFolder: workerGroup,
    chatJid: 'worker',
    isMain: false,
    isScheduledTask: true, // Single-turn behavior
    socketPort: CAMBOT_SOCKET_PORT,
    socketToken,
  };

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderr = '';
    let resolved = false;

    const cleanup = () => {
      if (socketServer) {
        socketServer.revokeToken(socketToken);
      }
      try {
        fs.rmSync(workerDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    };

    const resolveOnce = (output: ContainerOutput) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timeout);
      cleanup();
      resolve(output);

      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) container.kill('SIGKILL');
      });
    };

    // Pass secrets via stdin
    input.secrets = readSecrets(agentOptions.secretKeys);
    input.guardrailEnabled = EMAIL_GUARDRAIL_ENABLED;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    delete input.secrets;

    // Listen for output frames from the socket connection
    if (socketServer) {
      const checkConnection = () => {
        const conn = socketServer.getConnection(workerGroup);
        if (conn) {
          conn.onFrame((frame) => {
            if (frame.type === 'output') {
              const payload = frame.payload as ContainerOutput;
              const duration = Date.now() - startTime;
              logger.info({ delegationId, duration }, 'Worker completed');
              resolveOnce(payload);
            }
          });
        } else if (!resolved) {
          setTimeout(checkConnection, 500);
        }
      };
      setTimeout(checkConnection, 1000);
    }

    container.stdout.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: `worker-${delegationId}` }, line);
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      if (stderr.length < CONTAINER_MAX_OUTPUT_SIZE) {
        stderr += chunk.slice(0, CONTAINER_MAX_OUTPUT_SIZE - stderr.length);
      }
    });

    const timeout = setTimeout(() => {
      logger.warn({ delegationId, containerName }, 'Worker timeout, killing');
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) container.kill('SIGKILL');
      });
    }, WORKER_TIMEOUT_MS);

    container.on('close', (code) => {
      clearTimeout(timeout);
      const duration = Date.now() - startTime;

      if (resolved) {
        cleanup();
        return;
      }

      cleanup();

      if (code !== 0) {
        logger.error(
          { delegationId, code, duration },
          'Worker container error',
        );
        resolve({
          status: 'error',
          result: null,
          error: `Worker exited with code ${code}: ${stderr.slice(-200)}`,
        });
        return;
      }

      resolve({
        status: 'error',
        result: null,
        error: 'Worker exited without producing output',
      });
    });

    container.on('error', (err) => {
      clearTimeout(timeout);
      if (!resolved) {
        cleanup();
        resolve({
          status: 'error',
          result: null,
          error: `Worker spawn error: ${err.message}`,
        });
      }
    });
  });
}
