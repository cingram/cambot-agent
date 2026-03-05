/**
 * Container Runner for CamBot-Agent
 * Spawns agent execution in containers and handles IPC
 */
import { ChildProcess, exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  CONTAINER_MAX_OUTPUT_SIZE,
  DATA_DIR,
  GROUPS_DIR,
  HEARTBEAT_INTERVAL_MS,
  IDLE_TIMEOUT,
  MEMORY_MODE,
  TIMEZONE,
} from '../config/config.js';
import type { MemoryMode } from '../config/config.js';
import { readEnvFile } from '../config/env.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from '../groups/group-folder.js';
import { logger } from '../logger.js';
import { CONTAINER_RUNTIME_BIN, killContainersForGroup, readonlyMountArgs, stopContainer } from './runtime.js';
import { createHeartbeatMonitor, type HeartbeatMonitor } from './heartbeat-monitor.js';
import { validateAdditionalMounts } from './mount-security.js';
import { ExecutionContext } from '../types.js';
import { AgentOptions } from '../agents/agents.js';

// Sentinel markers for robust output parsing (must match agent-runner)
const OUTPUT_START_MARKER = '---CAMBOT_AGENT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CAMBOT_AGENT_OUTPUT_END---';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
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
  /** Unique token identifying this container. Used by the agent-runner to
   *  detect when it has been superseded by a newer container (orphan self-exit). */
  ipcToken?: string;
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
    // Main gets the project root read-only. Writable paths the agent needs
    // (group folder, IPC, .claude/) are mounted separately below.
    // Read-only prevents the agent from modifying host application code
    // (src/, dist/, package.json, etc.) which would bypass the sandbox
    // entirely on next restart.
    mounts.push({
      hostPath: projectRoot,
      containerPath: '/workspace/project',
      readonly: true,
    });

    // Main also gets its group folder as the working directory
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });
  } else {
    // Other groups only get their own folder
    mounts.push({
      hostPath: groupDir,
      containerPath: '/workspace/group',
      readonly: false,
    });

    // Global memory directory (read-only for non-main)
    // Only directory mounts are supported, not file mounts
    const globalDir = path.join(GROUPS_DIR, 'global');
    if (fs.existsSync(globalDir)) {
      mounts.push({
        hostPath: globalDir,
        containerPath: '/workspace/global',
        readonly: true,
      });
    }
  }

  // Per-group Claude sessions directory (isolated from other groups)
  // Each group gets their own .claude/ to prevent cross-group session access
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
        // Enable agent swarms (subagent orchestration)
        // https://code.claude.com/docs/en/agent-teams#orchestrate-teams-of-claude-code-sessions
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
        // Load CLAUDE.md from additional mounted directories
        // https://code.claude.com/docs/en/memory#load-memory-from-additional-directories
        CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: '1',
        // Enable Claude's memory feature (persists user preferences between sessions)
        // https://code.claude.com/docs/en/memory#manage-auto-memory
        CLAUDE_CODE_DISABLE_AUTO_MEMORY: '0',
      },
    }, null, 2) + '\n');
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

  // Per-group IPC namespace: each group gets its own IPC directory
  // This prevents cross-group privilege escalation via IPC
  const groupIpcDir = resolveGroupIpcPath(execution.folder);
  fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'worker-results'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'workflow-results'), { recursive: true });
  fs.mkdirSync(path.join(groupIpcDir, 'context'), { recursive: true });
  mounts.push({
    hostPath: groupIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  // Sync agent-runner source into a per-group writable location so agents
  // can customize it (add tools, change behavior) without affecting other
  // groups. Recompiled on container startup via entrypoint.sh.
  // Always sync from canonical source to pick up code changes.
  const agentRunnerSrc = path.join(projectRoot, 'agent-runner', 'src');
  const groupAgentRunnerDir = path.join(DATA_DIR, 'sessions', execution.folder, 'agent-runner-src');
  if (fs.existsSync(agentRunnerSrc)) {
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

  // Sync cambot-llm source so the container always has the latest version.
  // The container bakes in cambot-llm at image build time, but hot-mounted
  // agent-runner src may import new exports. This mount + entrypoint rebuild
  // keeps them in sync without requiring a full image rebuild.
  const cambotAgentsSrc = path.resolve(projectRoot, '..', 'cambot-llm', 'src');
  const groupCambotAgentsDir = path.join(DATA_DIR, 'sessions', execution.folder, 'cambot-llm-src');
  if (fs.existsSync(cambotAgentsSrc)) {
    fs.cpSync(cambotAgentsSrc, groupCambotAgentsDir, { recursive: true });
  }
  mounts.push({
    hostPath: groupCambotAgentsDir,
    containerPath: '/cambot-llm/src',
    readonly: false,
  });

  // Additional mounts validated against external allowlist (tamper-proof from containers)
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
  // Alias: cambot-core uses GEMINI_API_KEY, custom agents use GOOGLE_API_KEY.
  // If GOOGLE_API_KEY is not set but GEMINI_API_KEY is, use GEMINI_API_KEY.
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

  // Pass host timezone so container's local time matches the user's
  args.push('-e', `TZ=${TIMEZONE}`);

  // Run as host user so bind-mounted files are accessible.
  // Skip when running as root (uid 0), as the container's node user (uid 1000),
  // or when getuid is unavailable (native Windows without WSL).
  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  if (hostUid != null && hostUid !== 0 && hostUid !== 1000) {
    args.push('--user', `${hostUid}:${hostGid}`);
    args.push('-e', 'HOME=/home/node');
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
): Promise<ContainerOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(execution.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const mounts = buildVolumeMounts(execution);
  const safeName = execution.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const containerName = `cambot-agent-${safeName}-${Date.now()}`;
  const containerArgs = buildContainerArgs(mounts, containerName, agentOptions.containerImage);

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
  // Defense-in-depth: even if orphan cleanup missed something, each spawn is clean.
  killContainersForGroup(execution.folder);

  // Write owner token so the agent-runner can detect orphan status.
  // If a new container is spawned for the same group, the old container
  // will see the token change and self-exit on its next poll cycle.
  const groupIpcDir = resolveGroupIpcPath(execution.folder);
  fs.writeFileSync(path.join(groupIpcDir, '_owner'), containerName);
  input.ipcToken = containerName;

  // Heartbeat file path on the host (mirrors /workspace/ipc/_heartbeat inside container)
  const heartbeatPath = path.join(groupIpcDir, '_heartbeat');

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    onProcess(container, containerName);

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;

    // Pass secrets via stdin (never written to disk or mounted as files)
    input.secrets = readSecrets(agentOptions.secretKeys);
    input.memoryMode = MEMORY_MODE;
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    // Remove secrets and ephemeral fields from input so they don't appear in logs
    delete input.secrets;
    delete input.ipcToken;

    // Heartbeat monitor replaces the old setTimeout-based hard timeout.
    // Escalation: warn(15s) -> close(30s) -> stop(60s) -> kill(90s)
    const monitor = createHeartbeatMonitor(
      {
        heartbeatPath,
        intervalMs: HEARTBEAT_INTERVAL_MS,
        warnAfterMissed: 3,
        closeAfterMissed: 6,
        stopAfterMissed: 12,
        killAfterMissed: 18,
        idleTimeoutMs: IDLE_TIMEOUT,
        groupName: execution.name,
        containerName,
      },
      {
        onWarn: (missedCount, groupName) => {
          logger.warn(
            { group: groupName, containerName, missedCount },
            'Container heartbeat missed — possible hang',
          );
        },
        onClose: (groupName) => {
          logger.info(
            { group: groupName, containerName },
            'Heartbeat escalation: writing _close sentinel',
          );
          const closePath = path.join(groupIpcDir, 'input', '_close');
          try { fs.writeFileSync(closePath, ''); } catch { /* best effort */ }
        },
        onStop: (name, groupName) => {
          logger.warn(
            { group: groupName, containerName: name },
            'Heartbeat escalation: docker stop',
          );
          exec(stopContainer(name), { timeout: 15_000 }, (err) => {
            if (err) {
              logger.warn({ containerName: name, err }, 'docker stop failed during heartbeat escalation');
            }
          });
        },
        onKill: (name, groupName) => {
          logger.error(
            { group: groupName, containerName: name },
            'Heartbeat escalation: SIGKILL',
          );
          container.kill('SIGKILL');
        },
      },
    );
    monitor.start();

    // Streaming output: parse OUTPUT_START/END marker pairs as they arrive
    let parseBuffer = '';
    let newSessionId: string | undefined;
    let outputChain = Promise.resolve();
    let firstStdout = true;
    let hadStreamingOutput = false;

    container.stdout.on('data', (data) => {
      const chunk = data.toString();

      if (firstStdout) {
        firstStdout = false;
        logger.info(
          { group: execution.name, elapsedMs: Date.now() - startTime },
          'Container first stdout received',
        );
      }

      // Always accumulate for logging
      if (!stdoutTruncated) {
        const remaining = CONTAINER_MAX_OUTPUT_SIZE - stdout.length;
        if (chunk.length > remaining) {
          stdout += chunk.slice(0, remaining);
          stdoutTruncated = true;
          logger.warn(
            { group: execution.name, size: stdout.length },
            'Container stdout truncated due to size limit',
          );
        } else {
          stdout += chunk;
        }
      }

      // Stream-parse for output markers
      if (onOutput) {
        parseBuffer += chunk;
        let startIdx: number;
        while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
          const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
          if (endIdx === -1) break; // Incomplete pair, wait for more data

          const jsonStr = parseBuffer
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
          parseBuffer = parseBuffer.slice(endIdx + OUTPUT_END_MARKER.length);

          try {
            const parsed: ContainerOutput = JSON.parse(jsonStr);
            if (parsed.newSessionId) {
              newSessionId = parsed.newSessionId;
            }
            hadStreamingOutput = true;
            // Activity detected — reset the heartbeat monitor's missed count
            monitor.acknowledgeActivity();
            // Call onOutput for all markers (including null results)
            // so idle timers start even for "silent" query completions.
            // CRITICAL: .catch() prevents a single onOutput failure from
            // permanently breaking the chain (which would cause resolve()
            // in the close handler to never fire, leaking the container).
            outputChain = outputChain
              .then(() => onOutput(parsed))
              .catch((err) => {
                logger.error(
                  { group: execution.name, error: err },
                  'onOutput callback failed — output dropped but chain preserved',
                );
              });
          } catch (err) {
            logger.warn(
              { group: execution.name, error: err },
              'Failed to parse streamed output chunk',
            );
          }
        }
      }
    });

    container.stderr.on('data', (data) => {
      const chunk = data.toString();
      const lines = chunk.trim().split('\n');
      for (const line of lines) {
        if (line) logger.debug({ container: execution.folder }, line);
      }
      // Don't acknowledge on stderr — SDK writes debug logs continuously.
      // Heartbeat monitor reads the heartbeat file directly for liveness.
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
      monitor.stop();
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
        `Stdout Truncated: ${stdoutTruncated}`,
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
          ``,
          `=== Stdout${stdoutTruncated ? ' (TRUNCATED)' : ''} ===`,
          stdout,
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
        // Non-zero exit after output = likely heartbeat-triggered shutdown, not failure
        if (hadStreamingOutput) {
          logger.info(
            { group: execution.name, containerName, duration, code },
            'Container exited after output (heartbeat or idle shutdown)',
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
            stdout,
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
      // Use .catch() to ensure resolve() fires even if the chain was rejected.
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

      // Legacy mode: parse the last output marker pair from accumulated stdout
      try {
        // Extract JSON between sentinel markers for robust parsing
        const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
        const endIdx = stdout.indexOf(OUTPUT_END_MARKER);

        let jsonLine: string;
        if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
          jsonLine = stdout
            .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
            .trim();
        } else {
          // Fallback: last non-empty line
          const lines = stdout.trim().split('\n');
          jsonLine = lines[lines.length - 1];
        }

        const output: ContainerOutput = JSON.parse(jsonLine);

        logger.info(
          {
            group: execution.name,
            duration,
            status: output.status,
            hasResult: !!output.result,
            cost_usd: output.telemetry?.totalCostUsd,
            tokens_in: output.telemetry?.usage?.inputTokens,
            tokens_out: output.telemetry?.usage?.outputTokens,
          },
          'Container completed',
        );

        resolve(output);
      } catch (err) {
        logger.error(
          {
            group: execution.name,
            stdout,
            stderr,
            error: err,
          },
          'Failed to parse container output',
        );

        resolve({
          status: 'error',
          result: null,
          error: `Failed to parse container output: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    });

    container.on('error', (err) => {
      monitor.stop();
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

  // Minimal IPC directory (worker doesn't need full IPC)
  const workerIpcDir = path.join(workerDir, 'ipc');
  fs.mkdirSync(path.join(workerIpcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(workerIpcDir, 'tasks'), { recursive: true });
  mounts.push({
    hostPath: workerIpcDir,
    containerPath: '/workspace/ipc',
    readonly: false,
  });

  const containerName = `cambot-worker-${delegationId}`;
  const containerArgs = buildContainerArgs(mounts, containerName, agentOptions.containerImage);

  logger.info(
    { delegationId, containerName },
    'Spawning worker container',
  );

  const input: ContainerInput = {
    prompt,
    groupFolder: leadGroupFolder,
    chatJid: 'worker',
    isMain: false,
    isScheduledTask: true, // Single-turn behavior
  };

  return new Promise((resolve) => {
    const container = spawn(CONTAINER_RUNTIME_BIN, containerArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let parseBuffer = '';
    let stderr = '';
    let resolved = false;

    const cleanup = () => {
      // Clean up temp worker directory
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

      // Stop the container — worker is done, no need to wait for idle loop
      exec(stopContainer(containerName), { timeout: 15000 }, (err) => {
        if (err) container.kill('SIGKILL');
      });
    };

    // Pass secrets via stdin
    input.secrets = readSecrets(agentOptions.secretKeys);
    container.stdin.write(JSON.stringify(input));
    container.stdin.end();
    delete input.secrets;

    // Stream-parse stdout for output markers as they arrive.
    // The agent-runner's idle loop keeps the container alive after output,
    // so we must parse incrementally rather than waiting for close.
    container.stdout.on('data', (data) => {
      parseBuffer += data.toString();

      const startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER);
      if (startIdx === -1) return;
      const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
      if (endIdx === -1) return; // Incomplete pair, wait for more data

      const jsonStr = parseBuffer
        .slice(startIdx + OUTPUT_START_MARKER.length, endIdx)
        .trim();

      try {
        const output: ContainerOutput = JSON.parse(jsonStr);
        const duration = Date.now() - startTime;
        logger.info({ delegationId, duration }, 'Worker completed');
        resolveOnce(output);
      } catch (err) {
        resolveOnce({
          status: 'error',
          result: null,
          error: `Failed to parse worker output: ${err instanceof Error ? err.message : String(err)}`,
        });
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

      // If we already resolved from streaming output, nothing to do
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
        error: 'Worker exited without producing output markers',
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
