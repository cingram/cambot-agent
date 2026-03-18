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
import type { GatewayRouter, AgentRegistryEntry, RoutingDecision } from './gateway-router.js';
import { scoreRoute, scoreContinuation } from './gateway-router.js';
import type { HandoffRepository, HandoffSession } from '../db/handoff-repository.js';
import { HANDOFF_FREE_TURNS, HANDOFF_CONFIDENCE_THRESHOLD, GATEWAY_PRESET } from '../config/config.js';

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
  /** Invalidate cached agent registry (call after agent create/update/delete). */
  invalidateRegistryCache?: () => void;
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
  /** Handoff session repository for gateway session stickiness. */
  handoffRepo?: HandoffRepository;
  /** Returns the best Anthropic credential for containers. */
  getContainerSecret?: () => { envVar: string; value: string } | undefined;
  /** Returns all registered group JIDs (for cross-channel authorization). */
  getRegisteredGroupJids?: () => string[];
}

// ── Agent Registry Cache ───────────────────────────────────────
// Avoids re-querying + re-mapping on every message.
// Invalidated when onAgentMutation fires (agent create/update/delete).

const CACHE_TTL_MS = 60_000; // 1 minute max staleness

interface RegistryCache {
  entries: AgentRegistryEntry[];
  builtAt: number;
}

function createRegistryCache(getAgentRegistry?: () => AgentRegistryEntry[]) {
  let cache: RegistryCache | null = null;

  return {
    get(): AgentRegistryEntry[] {
      if (!getAgentRegistry) return [];
      if (cache && Date.now() - cache.builtAt < CACHE_TTL_MS) return cache.entries;
      cache = { entries: getAgentRegistry(), builtAt: Date.now() };
      return cache.entries;
    },
    invalidate(): void {
      cache = null;
    },
  };
}

/**
 * Build extra authorized JIDs for agents with cross-channel tools.
 * Agents with iMessage tools get authorized to send to all im: JIDs.
 */
function buildAuthorizedJids(
  agent: RegisteredAgent,
  deps: PersistentAgentSpawnerDeps,
): string[] | undefined {
  const mcpTools = resolveMcpToolList(agent.toolPolicy ?? { preset: 'readonly' });
  const hasImessageTools = mcpTools.some((t) => t.startsWith('imessage_'));
  if (!hasImessageTools) return undefined;

  const allJids = deps.getRegisteredGroupJids?.() ?? [];
  const imJids = allJids.filter((jid) => jid.startsWith('im:'));
  return imJids.length > 0 ? imJids : undefined;
}

// ── Factory ────────────────────────────────────────────────────

export function createPersistentAgentSpawner(deps: PersistentAgentSpawnerDeps): ContainerSpawner {
  const registryCache = createRegistryCache(deps.getAgentRegistry);

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
      if (agent.toolPolicy?.preset === GATEWAY_PRESET && deps.gatewayRouter && !isInterAgent) {
        return spawnViaGateway(self, deps, registryCache, agent, prompt, callerGroup, startTime);
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
            subagents: isCustomProvider ? undefined : agent.subagents,
            authorizedJids: buildAuthorizedJids(agent, deps),
            userCredential: deps.getContainerSecret?.(),
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
    invalidateRegistryCache: () => registryCache.invalidate(),
  };
  return self;
}

// ── Gateway Mode ─────────────────────────────────────────────

/**
 * Handle a gateway agent: check for an active handoff session first,
 * then fall back to full Haiku routing if no handoff exists.
 */
async function spawnViaGateway(
  spawner: ContainerSpawner,
  deps: PersistentAgentSpawnerDeps,
  cache: ReturnType<typeof createRegistryCache>,
  agent: RegisteredAgent,
  prompt: string,
  callerGroup: string,
  startTime: number,
): Promise<AgentExecutionResult> {
  const router = deps.gatewayRouter!;
  const handoffRepo = deps.handoffRepo;
  const channel = channelFromJid(callerGroup);

  // Check for active handoff session
  const handoff = handoffRepo?.findActive(channel, callerGroup, agent.id);

  if (handoff) {
    return handleActiveHandoff(spawner, deps, cache, agent, prompt, callerGroup, startTime, handoff);
  }

  // No handoff — try local scoring first, defer to Haiku if low confidence
  const agents = cache.get();
  const routeTargets = agents.filter(a => a.id !== agent.id);

  const local = scoreRoute(prompt, routeTargets);
  let decision: RoutingDecision;

  if (local.confidence >= HANDOFF_CONFIDENCE_THRESHOLD) {
    logger.info(
      { confidence: local.confidence, action: local.decision.action, target: local.decision.targetAgent },
      `[gateway] Local routing (confidence ${local.confidence})`,
    );
    decision = local.decision;
  } else {
    logger.info(
      { confidence: local.confidence },
      `[gateway] Low confidence (${local.confidence}), deferring to Haiku`,
    );
    decision = await router.route(prompt, routeTargets);
  }

  return executeRoutingDecision(spawner, deps, agent, prompt, callerGroup, startTime, decision);
}

/**
 * Route to the handoff agent directly (free turns) or run continuation
 * classification to decide if the conversation has pivoted.
 */
async function handleActiveHandoff(
  spawner: ContainerSpawner,
  deps: PersistentAgentSpawnerDeps,
  cache: ReturnType<typeof createRegistryCache>,
  gateway: RegisteredAgent,
  prompt: string,
  callerGroup: string,
  startTime: number,
  handoff: HandoffSession,
): Promise<AgentExecutionResult> {
  const handoffRepo = deps.handoffRepo!;
  const router = deps.gatewayRouter!;

  // Free turns — skip classification entirely
  if (handoff.turnCount <= HANDOFF_FREE_TURNS) {
    logger.info(
      { gateway: gateway.id, agent: handoff.activeAgent, turn: handoff.turnCount, callerGroup },
      `[gateway] Handoff free turn ${handoff.turnCount}/${HANDOFF_FREE_TURNS}`,
    );
    return routeToHandoffAgent(spawner, deps, gateway, prompt, callerGroup, startTime, handoff);
  }

  // Past free turns — try local scoring, defer to Haiku if low confidence
  const agents = cache.get();
  const localCont = scoreContinuation(prompt, handoff.activeAgent, handoff.intent, agents);

  let continuation: { action: 'continue' | 'pivot' };
  if (localCont.confidence >= HANDOFF_CONFIDENCE_THRESHOLD) {
    logger.info(
      { confidence: localCont.confidence, action: localCont.decision.action, agent: handoff.activeAgent },
      `[gateway] Local continuation (confidence ${localCont.confidence})`,
    );
    continuation = localCont.decision;
  } else {
    logger.info(
      { confidence: localCont.confidence },
      `[gateway] Low continuation confidence (${localCont.confidence}), deferring to Haiku`,
    );
    continuation = await router.classifyContinuation(prompt, handoff.activeAgent, handoff.intent);
  }

  if (continuation.action === 'continue') {
    return routeToHandoffAgent(spawner, deps, gateway, prompt, callerGroup, startTime, handoff);
  }

  // Pivot — clear handoff, re-route from scratch
  logger.info(
    { gateway: gateway.id, previousAgent: handoff.activeAgent, callerGroup },
    '[gateway] Handoff pivot detected, re-routing',
  );
  handoffRepo.clear(handoff.id);

  const routeTargets = agents.filter(a => a.id !== gateway.id);

  const localRoute = scoreRoute(prompt, routeTargets);
  let decision: RoutingDecision;
  if (localRoute.confidence >= HANDOFF_CONFIDENCE_THRESHOLD) {
    logger.info(
      { confidence: localRoute.confidence, action: localRoute.decision.action, target: localRoute.decision.targetAgent },
      `[gateway] Local re-routing (confidence ${localRoute.confidence})`,
    );
    decision = localRoute.decision;
  } else {
    decision = await router.route(prompt, routeTargets);
  }

  return executeRoutingDecision(spawner, deps, gateway, prompt, callerGroup, startTime, decision);
}

/**
 * Route directly to the handoff agent, incrementing turn count.
 */
async function routeToHandoffAgent(
  spawner: ContainerSpawner,
  deps: PersistentAgentSpawnerDeps,
  gateway: RegisteredAgent,
  prompt: string,
  callerGroup: string,
  startTime: number,
  handoff: HandoffSession,
): Promise<AgentExecutionResult> {
  deps.handoffRepo!.incrementTurn(handoff.id);

  const targetAgent = deps.getAgentById?.(handoff.activeAgent);
  if (!targetAgent) {
    logger.warn({ target: handoff.activeAgent }, 'Handoff target agent no longer exists, clearing');
    deps.handoffRepo!.clear(handoff.id);
    return {
      status: 'error',
      content: `Agent "${handoff.activeAgent}" not found`,
      durationMs: Date.now() - startTime,
    };
  }

  return spawner.spawn(targetAgent, prompt, callerGroup, targetAgent.timeoutMs);
}

/**
 * Execute a routing decision — respond directly or delegate to a specialist.
 * On delegate, creates a handoff session for future stickiness.
 */
async function executeRoutingDecision(
  spawner: ContainerSpawner,
  deps: PersistentAgentSpawnerDeps,
  gateway: RegisteredAgent,
  prompt: string,
  callerGroup: string,
  startTime: number,
  decision: RoutingDecision,
): Promise<AgentExecutionResult> {
  if (decision.action === 'respond') {
    if (decision.response) {
      await deps.messageBus.emit(
        new OutboundMessage('persistent-agent', callerGroup, decision.response, {
          groupFolder: gateway.folder,
          agentId: gateway.id,
        }),
      );
    }
    return {
      status: 'success',
      content: decision.response ?? '',
      durationMs: Date.now() - startTime,
    };
  }

  // Delegate — look up and spawn the target agent
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

  // Create handoff session for session stickiness
  if (deps.handoffRepo) {
    const channel = channelFromJid(callerGroup);
    const intent = extractIntent(decision.prompt);
    deps.handoffRepo.upsert({
      channel,
      chatJid: callerGroup,
      gatewayId: gateway.id,
      activeAgent: decision.targetAgent,
      intent,
    });
    logger.info(
      { gateway: gateway.id, target: decision.targetAgent, intent, callerGroup },
      `[gateway] Handoff session created → ${decision.targetAgent}`,
    );
  }

  return spawner.spawn(targetAgent, decision.prompt, callerGroup, targetAgent.timeoutMs);
}

/**
 * Extract a short intent description from the enriched prompt.
 * Truncates to the first sentence or 100 characters.
 */
function extractIntent(prompt: string): string {
  const firstSentence = prompt.match(/^[^.!?]+[.!?]/)?.[0] ?? prompt;
  return firstSentence.slice(0, 100);
}
