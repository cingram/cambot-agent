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
import type { ContextFileDeps } from '../utils/context-files.js';
import type { LifecycleInterceptor } from '../utils/lifecycle-interceptor.js';
import { runContainerAgent } from '../container/runner.js';
import { CONTAINER_RUNTIME_BIN } from '../container/runtime.js';
import { OutboundMessage } from '../bus/index.js';
import { logger } from '../logger.js';
import { resolveToolList, resolveMcpToolList, applySafetyDenials, qualifyMcpToolList } from '../tools/tool-policy.js';
import { channelFromJid } from '../utils/channel-from-jid.js';
import { resolveActiveConversation, setConversationSession, updatePreview } from '../db/conversation-repository.js';

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
  messageBus: MessageBus;
  /** Resolve a global template value (e.g. 'identity', 'soul'). Used as fallback
   *  when a persistent agent doesn't define its own systemPrompt/soul. */
  getTemplateValue: (key: string) => string | undefined;
  /** Build full agent context (tasks, workflows, agents list, chats, etc.). */
  buildAgentContext: (folder: string, isMain: boolean, chatJid: string, identityOverride?: string, soulOverride?: string) => ContextFileDeps;
  /** Resolve container image + secret keys for a non-Claude provider. */
  resolveAgentImage?: (provider: string, secretKeys: string[]) => AgentOptions;
  onTelemetry?: (telemetry: ContainerTelemetry, channel: string) => void;
  onContainerError?: (error: string, durationMs: number, channel: string) => void;
  getInterceptor?: () => LifecycleInterceptor | null;
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
      const isInterAgent = callerGroup.startsWith('agent:');
      logger.debug(
        { agentId: agent.id, folder: agent.folder, callerGroup, isInterAgent, timeoutMs },
        'Starting persistent agent container spawn',
      );

      const execution: ExecutionContext = {
        name: agent.name,
        folder: agent.folder,
        isMain: agent.isMain,
        containerConfig: { timeout: timeoutMs },
      };

      // Scope MCP servers: agents must declare which servers they need.
      // Empty list = no dynamic servers (least privilege).
      const allServers = deps.getActiveMcpServers();
      const scopedServers = agent.mcpServers.length === 0
        ? undefined
        : allServers?.filter(s => agent.mcpServers.includes(s.name));

      // Resolve active conversation — handles auto-rotation (idle timeout + size)
      const channel = channelFromJid(callerGroup);
      const conversation = resolveActiveConversation(agent.folder, channel, callerGroup);
      const sessionId = conversation.sessionId ?? undefined;
      const isCustomProvider = agent.provider !== 'claude';

      // Resolve container image: custom providers use resolveAgentImage, Claude uses default
      const agentOpts = isCustomProvider && deps.resolveAgentImage
        ? deps.resolveAgentImage(agent.provider, agent.secretKeys)
        : deps.getAgentOptions();

      // Build agent context: Claude agents get full context pipeline,
      // custom providers skip it (they use their own prompt path)
      const agentIdentity = isCustomProvider ? undefined : (agent.systemPrompt ?? deps.getTemplateValue('identity'));
      const agentSoul = isCustomProvider ? undefined : (agent.soul ?? deps.getTemplateValue('soul'));
      const agentContext = isCustomProvider
        ? undefined
        : deps.buildAgentContext(agent.folder, agent.isMain, callerGroup, agentIdentity, agentSoul);

      // Build customAgent payload for non-Claude providers
      const customAgent = isCustomProvider ? {
        agentId: agent.id,
        provider: agent.provider as 'openai' | 'xai' | 'anthropic' | 'google',
        model: agent.model,
        baseUrl: agent.baseUrl ?? undefined,
        apiKeyEnvVar: agent.secretKeys[0] ?? '',
        systemPrompt: agent.systemPrompt ?? '',
        tools: agent.tools,
        maxTokens: agent.maxTokens ?? undefined,
        temperature: agent.temperature ?? undefined,
      } : undefined;

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
            isInterAgentTarget: isInterAgent,
            mcpServers: scopedServers,
            customAgent,
            allowedSdkTools: isCustomProvider ? undefined : resolveToolList(agent.toolPolicy),
            allowedMcpTools: isCustomProvider ? undefined : qualifyMcpToolList(
              applySafetyDenials(
                resolveMcpToolList(agent.toolPolicy ?? { preset: 'readonly' }),
                { isInterAgentTarget: isInterAgent, isMain: agent.isMain },
              ),
            ),
            agentContext,
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
              setConversationSession(conversation.id, result.newSessionId);
            }
            if (result.telemetry && deps.onTelemetry) {
              deps.onTelemetry(result.telemetry, callerGroup);
            }
            if (result.result) {
              finalResult = result.result;
              // Update conversation preview with first 200 chars of response
              updatePreview(conversation.id, result.result);
              // Suppress OutboundMessage for inter-agent calls — the result
              // goes back via the IPC result file, not through a channel.
              if (!isInterAgent) {
                await deps.messageBus.emit(
                  new OutboundMessage('persistent-agent', callerGroup, result.result, {
                    groupFolder: agent.folder,
                    agentId: agent.id,
                  }),
                );
              }
              // Ingest response into memory system (fact extraction + short-term memory)
              deps.getInterceptor?.()?.ingestResponse(agent.folder, callerGroup, result.result);
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
          setConversationSession(conversation.id, output.newSessionId);
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
