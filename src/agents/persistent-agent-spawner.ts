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
import type { LifecycleInterceptor } from '../utils/lifecycle-interceptor.js';
import { runContainerAgent } from '../container/runner.js';
import { CONTAINER_RUNTIME_BIN } from '../container/runtime.js';
import type { CambotSocketServer } from '../cambot-socket/server.js';
import { OutboundMessage } from '../bus/index.js';
import { logger } from '../logger.js';
import { resolveToolList, resolveDisallowedTools, resolveMcpToolList, applySafetyDenials, qualifyMcpToolList } from '../tools/tool-policy.js';
import { channelFromJid } from '../utils/channel-from-jid.js';
import { cleanupSdkMemory } from '../utils/memory-cleanup.js';
import { resolveActiveConversation, setConversationSession, updatePreview } from '../db/conversation-repository.js';
import type { GatewayRouter, AgentRegistryEntry } from './gateway-router.js';

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
  /** Build pre-assembled context string (identity + soul + tools + agents + heartbeat + channels). */
  assembleContext: (folder: string, isMain: boolean, chatJid: string, identityOverride?: string, soulOverride?: string, skillsWhitelist?: string[]) => string;
  /** Resolve container image + secret keys for a non-Claude provider. */
  resolveAgentImage?: (provider: string, secretKeys: string[]) => AgentOptions;
  onTelemetry?: (telemetry: ContainerTelemetry, channel: string) => void;
  onContainerError?: (error: string, durationMs: number, channel: string) => void;
  getInterceptor?: () => LifecycleInterceptor | null;
  /** Lazy getter — socket server may not be available at spawner construction time. */
  getSocketServer?: () => CambotSocketServer | undefined;
  /** Gateway router for agents with 'gateway' tool preset. */
  gatewayRouter?: GatewayRouter;
  /** Get list of agents for gateway routing decisions. */
  getAgentRegistry?: () => AgentRegistryEntry[];
  /** Look up a full RegisteredAgent by ID (for gateway delegation). */
  getAgentById?: (id: string) => RegisteredAgent | undefined;
}

// ── Factory ────────────────────────────────────────────────────

export function createPersistentAgentSpawner(deps: PersistentAgentSpawnerDeps): ContainerSpawner {
  // Store reference for recursive gateway delegation
  const self: ContainerSpawner = {
    async spawn(
      agent: RegisteredAgent,
      prompt: string,
      callerGroup: string,
      timeoutMs: number,
    ): Promise<AgentExecutionResult> {
      const startTime = Date.now();
      const isInterAgent = callerGroup.startsWith('agent:');

      // Gateway mode: lightweight API routing instead of full container
      if (agent.toolPolicy?.preset === 'gateway' && deps.gatewayRouter && !isInterAgent) {
        return spawnViaGateway(self, deps, agent, prompt, callerGroup, startTime);
      }

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
      const resolution = resolveActiveConversation(agent.folder, channel, callerGroup, agent.memoryStrategy);
      const conversation = resolution.conversation;

      // Conversation-scoped: wipe SDK memory on rotation
      if (agent.memoryStrategy?.mode === 'conversation-scoped' && resolution.rotatedFrom) {
        cleanupSdkMemory(agent.folder);
      }

      const sessionId = resolution.isTransient ? undefined : (conversation.sessionId ?? undefined);
      const isCustomProvider = agent.provider !== 'claude';

      // Resolve container image: custom providers use resolveAgentImage, Claude uses default
      const agentOpts = isCustomProvider && deps.resolveAgentImage
        ? deps.resolveAgentImage(agent.provider, agent.secretKeys)
        : deps.getAgentOptions();

      // Build agent context: Claude agents get full context pipeline,
      // custom providers skip it (they use their own prompt path)
      const agentIdentity = isCustomProvider ? undefined : (agent.systemPrompt ?? deps.getTemplateValue('identity'));
      const agentSoul = isCustomProvider ? undefined : (agent.soul ?? deps.getTemplateValue('soul'));
      const skillsWhitelist = agent.skills?.length ? agent.skills : undefined;
      const assembledContext = isCustomProvider
        ? undefined
        : deps.assembleContext(agent.folder, agent.isMain, callerGroup, agentIdentity, agentSoul, skillsWhitelist);

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
            model: isCustomProvider ? undefined : agent.model,
            memoryStrategy: agent.memoryStrategy,
            conversationId: resolution.isTransient ? undefined : conversation.id,
            mcpServers: scopedServers,
            customAgent,
            skills: agent.skills,
            allowedSdkTools: isCustomProvider ? undefined : resolveToolList(agent.toolPolicy),
            disallowedSdkTools: isCustomProvider ? undefined : resolveDisallowedTools(agent.toolPolicy),
            allowedMcpTools: isCustomProvider ? undefined : qualifyMcpToolList(
              applySafetyDenials(
                resolveMcpToolList(agent.toolPolicy ?? { preset: 'readonly' }),
                { isInterAgentTarget: isInterAgent, isMain: agent.isMain },
              ),
            ),
            assembledContext,
          },
          (_proc, containerName) => {
            spawnedContainerName = containerName;
            logger.debug(
              { agentId: agent.id, containerName, callerGroup },
              'Persistent agent container spawned',
            );
          },
          async (result) => {
            if (!resolution.isTransient && result.newSessionId) {
              setConversationSession(conversation.id, result.newSessionId);
            }
            if (result.telemetry && deps.onTelemetry) {
              deps.onTelemetry(result.telemetry, callerGroup);
            }
            if (result.result) {
              finalResult = result.result;
              // Update conversation preview with first 200 chars of response
              if (!resolution.isTransient) {
                updatePreview(conversation.id, result.result);
              }
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
          deps.getSocketServer?.(),
        );

        if (output.newSessionId && !resolution.isTransient) {
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
  return self;
}

// ── Gateway Mode ─────────────────────────────────────────────

/**
 * Handle a gateway agent: make a lightweight Haiku API call for routing,
 * then either respond directly or spawn the target agent.
 */
async function spawnViaGateway(
  spawner: ContainerSpawner,
  deps: PersistentAgentSpawnerDeps,
  agent: RegisteredAgent,
  prompt: string,
  callerGroup: string,
  startTime: number,
): Promise<AgentExecutionResult> {
  const router = deps.gatewayRouter!;
  const agents = deps.getAgentRegistry?.() ?? [];

  // Exclude the gateway agent itself from routing targets
  const routeTargets = agents.filter(a => a.id !== agent.id);

  const decision = await router.route(prompt, routeTargets);

  if (decision.action === 'respond') {
    // Direct response — emit to bus, no container needed
    if (decision.response) {
      await deps.messageBus.emit(
        new OutboundMessage('persistent-agent', callerGroup, decision.response, {
          groupFolder: agent.folder,
          agentId: agent.id,
        }),
      );
    }
    return {
      status: 'success',
      content: decision.response ?? '',
      durationMs: Date.now() - startTime,
    };
  }

  // Delegate — look up and spawn the target agent directly
  if (!decision.targetAgent || !decision.prompt) {
    return {
      status: 'error',
      content: 'Gateway routing failed: no target agent or prompt',
      durationMs: Date.now() - startTime,
    };
  }

  const targetAgent = deps.getAgentById?.(decision.targetAgent);
  if (!targetAgent) {
    logger.warn({ target: decision.targetAgent }, 'Gateway routed to unknown agent');
    return {
      status: 'error',
      content: `Agent "${decision.targetAgent}" not found`,
      durationMs: Date.now() - startTime,
    };
  }

  logger.info(
    { gateway: agent.id, target: decision.targetAgent, callerGroup },
    `[gateway] Delegating to ${decision.targetAgent}`,
  );

  // Spawn target agent via the same spawner (recursive).
  // The target agent won't be a gateway, so it takes the normal container path.
  return spawner.spawn(targetAgent, decision.prompt, callerGroup, targetAgent.timeoutMs);
}
