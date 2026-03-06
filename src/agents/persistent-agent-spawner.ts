/**
 * Persistent Agent Spawner — Implements ContainerSpawner for persistent agents.
 *
 * Builds a scoped ExecutionContext, filters MCP servers to only those the
 * agent is allowed, and delegates to runContainerAgent.
 */
import { execFile } from 'child_process';

import type { AgentOptions } from './agents.js';
import type { ContainerTelemetry } from '../container/runner.js';
import type { ExecutionContext, MessageBus, RegisteredAgent } from '../types.js';
import { runContainerAgent } from '../container/runner.js';
import { CONTAINER_RUNTIME_BIN } from '../container/runtime.js';
import { OutboundMessage } from '../bus/index.js';
import { logger } from '../logger.js';

// ── Public types ───────────────────────────────────────────────

/** Result from spawning and running an agent container. */
export interface AgentExecutionResult {
  status: 'success' | 'error';
  content: string;
  durationMs: number;
}

/** Abstraction over container spawning. */
export interface ContainerSpawner {
  spawn(
    agent: RegisteredAgent,
    prompt: string,
    callerGroup: string,
    timeoutMs: number,
  ): Promise<AgentExecutionResult>;
}

// ── Dependencies ───────────────────────────────────────────────

interface McpServerEntry {
  name: string;
  transport: 'http' | 'sse';
  url: string;
}

export interface PersistentAgentSpawnerDeps {
  getActiveMcpServers: () => McpServerEntry[] | undefined;
  getAgentOptions: () => AgentOptions;
  getSession: (folder: string) => string | undefined;
  setSession: (folder: string, sessionId: string) => void;
  messageBus: MessageBus;
  onTelemetry?: (telemetry: ContainerTelemetry, channel: string) => void;
  onContainerError?: (error: string, durationMs: number, channel: string) => void;
}

// ── Factory ────────────────────────────────────────────────────

export function createPersistentAgentSpawner(deps: PersistentAgentSpawnerDeps): ContainerSpawner {
  return {
    async spawn(
      agent: RegisteredAgent,
      prompt: string,
      callerGroup: string,
      timeoutMs: number,
    ): Promise<AgentExecutionResult> {
      const startTime = Date.now();
      logger.debug(
        { agentId: agent.id, folder: agent.folder, callerGroup, timeoutMs },
        'Starting persistent agent container spawn',
      );

      const execution: ExecutionContext = {
        name: agent.name,
        folder: agent.folder,
        isMain: agent.isMain,
        containerConfig: { timeout: timeoutMs },
      };

      // Scope MCP servers: empty allowlist = all servers; otherwise filter
      const allServers = deps.getActiveMcpServers();
      const scopedServers = agent.mcpServers.length === 0
        ? allServers
        : allServers?.filter(s => agent.mcpServers.includes(s.name));

      const sessionId = deps.getSession(agent.folder);
      const agentOpts = deps.getAgentOptions();

      let finalResult = '';
      let spawnedContainerName: string | null = null;
      let gotFirstResult = false;

      try {
        const output = await runContainerAgent(
          execution,
          {
            prompt,
            sessionId,
            groupFolder: agent.folder,
            chatJid: callerGroup,
            isMain: agent.isMain,
            mcpServers: scopedServers,
          },
          (_proc, containerName) => {
            spawnedContainerName = containerName;
            logger.debug(
              { agentId: agent.id, containerName, callerGroup },
              'Persistent agent container spawned',
            );
          },
          async (result) => {
            if (result.newSessionId) {
              deps.setSession(agent.folder, result.newSessionId);
            }
            if (result.telemetry && deps.onTelemetry) {
              deps.onTelemetry(result.telemetry, callerGroup);
            }
            if (result.result) {
              finalResult = result.result;
              await deps.messageBus.emit(
                new OutboundMessage('persistent-agent', callerGroup, result.result, {
                  groupFolder: agent.folder,
                  agentId: agent.id,
                }),
              );
            }
            // Stop the container after delivering the first result
            if (!gotFirstResult) {
              gotFirstResult = true;
              if (spawnedContainerName) {
                const name = spawnedContainerName;
                execFile(CONTAINER_RUNTIME_BIN, ['stop', name], { timeout: 15_000 }, (err) => {
                  if (err) {
                    logger.debug(
                      { containerName: name, err },
                      'Persistent agent container stop (may already be exiting)',
                    );
                  }
                });
              }
            }
          },
          agentOpts,
        );

        if (output.newSessionId) {
          deps.setSession(agent.folder, output.newSessionId);
        }

        if (output.status === 'error') {
          const durationMs = Date.now() - startTime;
          logger.warn(
            { agentId: agent.id, durationMs, error: output.error },
            'Persistent agent container returned error',
          );
          if (deps.onContainerError) {
            deps.onContainerError(
              `Persistent agent ${agent.id} failed: ${output.error || 'unknown'}`,
              durationMs,
              callerGroup,
            );
          }
          return {
            status: 'error',
            content: output.error || 'Container execution failed',
            durationMs,
          };
        }

        const durationMs = Date.now() - startTime;
        logger.debug(
          { agentId: agent.id, durationMs, callerGroup },
          'Persistent agent container completed successfully',
        );
        return {
          status: 'success',
          content: finalResult,
          durationMs,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ agentId: agent.id, err }, 'Persistent agent spawn failed');
        if (deps.onContainerError) {
          deps.onContainerError(
            `Persistent agent ${agent.id} crashed: ${errorMsg}`,
            Date.now() - startTime,
            callerGroup,
          );
        }
        return {
          status: 'error',
          content: `Spawn failed: ${errorMsg}`,
          durationMs: Date.now() - startTime,
        };
      }
    },
  };
}
