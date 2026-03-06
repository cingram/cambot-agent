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
import type { MessageBus } from '../types.js';
import { InboundMessage, OutboundMessage } from '../bus/index.js';
import { logger } from '../logger.js';

// ── Per-agent resilience state ─────────────────────────────────

type CircuitState = 'closed' | 'open' | 'half-open';

interface AgentState {
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

  const agentStates = new Map<string, AgentState>();
  let routingTable = agentRepo.buildRoutingTable();

  logger.info(
    { routeCount: routingTable.size, routes: Object.fromEntries(routingTable) },
    'Persistent agent routing table built',
  );

  // ── Circuit breaker helpers ────────────────────────────────

  function getOrCreateState(agentId: string, concurrencyLimit: number): AgentState {
    let state = agentStates.get(agentId);
    if (!state) {
      state = {
        circuitState: 'closed',
        failureCount: 0,
        cooldownTimer: null,
        activeCount: 0,
        concurrencyLimit,
      };
      agentStates.set(agentId, state);
    }
    return state;
  }

  function recordSuccess(state: AgentState): void {
    state.failureCount = 0;
    if (state.circuitState === 'half-open') {
      state.circuitState = 'closed';
    }
  }

  function recordFailure(agentId: string, state: AgentState): void {
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
        await messageBus.emit(
          new OutboundMessage('persistent-agent', event.jid,
            'Sorry, I encountered an error processing your message. Please try again.',
            { agentId }),
        );
        return;
      }

      const state = getOrCreateState(agentId, agent.concurrency);

      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
          await new Promise<void>(resolve =>
            setTimeout(resolve, retryDelayMs * 2 ** (attempt - 1)),
          );
        }

        // Circuit breaker
        if (state.circuitState === 'open') {
          lastError = new Error(`Circuit open for agent "${agentId}"`);
          break;
        }

        // Bulkhead
        if (state.activeCount >= state.concurrencyLimit) {
          lastError = new Error(`Bulkhead full for agent "${agentId}"`);
          break;
        }

        state.activeCount++;
        try {
          const result = await spawner.spawn(agentId, event.message.content, event.jid, agent.timeoutMs);
          if (result.status === 'success') {
            recordSuccess(state);
            return;
          }
          lastError = new Error(result.content);
          recordFailure(agentId, state);
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          recordFailure(agentId, state);
        } finally {
          state.activeCount--;
        }
      }

      logger.error({ agentId, err: lastError }, 'Persistent agent query failed');
      await messageBus.emit(
        new OutboundMessage('persistent-agent', event.jid,
          'Sorry, I encountered an error processing your message. Please try again.',
          { agentId }),
      );
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
      logger.info(
        { routeCount: routingTable.size, routes: Object.fromEntries(routingTable) },
        'Persistent agent routing table reloaded',
      );
    },

    destroy(): void {
      unsubscribe();
      for (const state of agentStates.values()) {
        if (state.cooldownTimer) clearTimeout(state.cooldownTimer);
      }
      agentStates.clear();
    },
  };
}
