/**
 * Persistent Agent Handler — Unified MessageBus handler with embedded resilience.
 *
 * Routes inbound messages to persistent agents via ContainerSpawner with
 * circuit breaker, bulkhead, and retry logic. Replaces the separate AgentBus
 * system with inline resilience state.
 *
 * Subscribes to InboundMessage at priority 20 (after shadow-admin at 10,
 * before DB store at 100). When a message arrives on a channel claimed by
 * a persistent agent, cancels the event and spawns the agent directly.
 */
import type { AgentRepository } from '../db/agent-repository.js';
import type { ContainerSpawner } from './persistent-agent-spawner.js';
import type { MessageBus, RegisteredAgent } from '../types.js';
import { InboundMessage, OutboundMessage } from '../bus/index.js';
import { logger } from '../logger.js';

// ── Per-agent resilience state ─────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

interface AgentResilienceState {
  circuitState: CircuitState;
  failureCount: number;
  cooldownTimer: ReturnType<typeof setTimeout> | null;
  activeCount: number;
  concurrencyLimit: number;
}

// ── Public interface ───────────────────────────────────────────

export interface PersistentAgentHandlerDeps {
  messageBus: MessageBus;
  agentRepo: AgentRepository;
  spawner: ContainerSpawner;
  maxRetries?: number;
  retryDelayMs?: number;
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface PersistentAgentHandler {
  reload(): void;
  destroy(): void;
}

// ── Factory ────────────────────────────────────────────────────

export function createPersistentAgentHandler(deps: PersistentAgentHandlerDeps): PersistentAgentHandler {
  const {
    messageBus,
    agentRepo,
    spawner,
    maxRetries = 2,
    retryDelayMs = 1000,
    failureThreshold = 3,
    cooldownMs = 30_000,
  } = deps;

  const resilienceStates = new Map<string, AgentResilienceState>();
  let routingTable = agentRepo.buildRoutingTable();

  logger.info(
    { routeCount: routingTable.size, routes: Object.fromEntries(routingTable) },
    'Persistent agent routing table built',
  );

  // ── Helpers ────────────────────────────────────────────────

  function getOrCreateResilienceState(agentId: string, concurrencyLimit: number): AgentResilienceState {
    let state = resilienceStates.get(agentId);
    if (!state) {
      state = {
        circuitState: 'closed',
        failureCount: 0,
        cooldownTimer: null,
        activeCount: 0,
        concurrencyLimit,
      };
      resilienceStates.set(agentId, state);
    }
    return state;
  }

  function recordSuccess(agentId: string, state: AgentResilienceState): void {
    state.failureCount = 0;
    if (state.circuitState === 'half-open') {
      state.circuitState = 'closed';
      logger.info({ agentId }, 'Circuit breaker closed after successful half-open test');
    }
  }

  function recordFailure(agentId: string, state: AgentResilienceState): void {
    state.failureCount++;
    if (state.failureCount >= failureThreshold && state.circuitState === 'closed') {
      state.circuitState = 'open';
      logger.warn({ agentId, failures: state.failureCount }, 'Circuit breaker opened');
      state.cooldownTimer = setTimeout(() => {
        state.circuitState = 'half-open';
        state.cooldownTimer = null;
        logger.info({ agentId }, 'Circuit breaker half-open');
      }, cooldownMs);
    }
  }

  function emitErrorReply(jid: string, agentId: string): Promise<void> {
    return messageBus.emit(
      new OutboundMessage('persistent-agent', jid,
        'Sorry, I encountered an error processing your message. Please try again.',
        { agentId }),
    );
  }

  function pruneStaleResilienceStates(): void {
    const activeAgentIds = new Set(routingTable.values());
    const pruned: string[] = [];
    for (const [agentId, state] of resilienceStates) {
      if (!activeAgentIds.has(agentId)) {
        if (state.cooldownTimer) clearTimeout(state.cooldownTimer);
        resilienceStates.delete(agentId);
        pruned.push(agentId);
      }
    }
    if (pruned.length > 0) {
      logger.debug({ prunedAgents: pruned }, 'Pruned stale resilience states');
    }
  }

  // ── Bus handler ────────────────────────────────────────────

  const unsubscribe = messageBus.on(
    InboundMessage,
    async (event) => {
      const channel = event.channel;
      if (!channel) return;

      const agentId = routingTable.get(channel);
      if (!agentId) return;

      event.cancelled = true;

      const agent = agentRepo.getById(agentId);
      if (!agent) {
        logger.error({ agentId, channel }, 'Persistent agent not found in repository');
        await emitErrorReply(event.jid, agentId);
        return;
      }

      logger.info(
        { agentId, channel, jid: event.jid },
        'Routing inbound message to persistent agent',
      );

      const state = getOrCreateResilienceState(agentId, agent.concurrency);
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          const delayMs = retryDelayMs * 2 ** (attempt - 1);
          logger.debug(
            { agentId, attempt, delayMs, maxRetries },
            'Retrying persistent agent spawn',
          );
          await new Promise<void>(resolve => setTimeout(resolve, delayMs));
        }

        // Circuit breaker
        if (state.circuitState === 'open') {
          logger.warn({ agentId, circuitState: state.circuitState }, 'Rejected by circuit breaker');
          lastError = new Error(`Circuit open for agent "${agentId}"`);
          break;
        }

        // Bulkhead
        if (state.activeCount >= state.concurrencyLimit) {
          logger.warn(
            { agentId, activeCount: state.activeCount, concurrencyLimit: state.concurrencyLimit },
            'Rejected by bulkhead',
          );
          lastError = new Error(`Bulkhead full for agent "${agentId}"`);
          break;
        }

        state.activeCount++;
        try {
          const result = await spawner.spawn(agent, event.message.content, event.jid, agent.timeoutMs);
          if (result.status === 'success') {
            logger.info(
              { agentId, durationMs: result.durationMs },
              'Persistent agent query completed',
            );
            recordSuccess(agentId, state);
            return;
          }
          lastError = new Error(result.content);
          logger.warn(
            { agentId, attempt, err: lastError.message },
            'Persistent agent spawn returned error',
          );
          recordFailure(agentId, state);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          logger.warn(
            { agentId, attempt, err: lastError.message },
            'Persistent agent spawn threw exception',
          );
          recordFailure(agentId, state);
        } finally {
          state.activeCount--;
        }
      }

      logger.error(
        { agentId, err: lastError, attempts: maxRetries + 1 },
        'Persistent agent query failed after all retries',
      );
      await emitErrorReply(event.jid, agentId);
    },
    {
      id: 'persistent-agent-handler',
      priority: 20,
      source: 'persistent-agent-handler',
      sequential: true,
    },
  );

  return {
    reload(): void {
      routingTable = agentRepo.buildRoutingTable();
      pruneStaleResilienceStates();
      logger.info(
        { routeCount: routingTable.size, routes: Object.fromEntries(routingTable) },
        'Persistent agent routing table reloaded',
      );
    },

    destroy(): void {
      unsubscribe();
      for (const state of resilienceStates.values()) {
        if (state.cooldownTimer) clearTimeout(state.cooldownTimer);
      }
      resilienceStates.clear();
      logger.debug('Persistent agent handler destroyed');
    },
  };
}
