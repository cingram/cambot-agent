import type { AgentRepository } from '../db/agent-repository.js';
import type { ContainerSpawner } from '../agents/persistent-agent-spawner.js';
import type { MessageBus } from '../types.js';
import { WorkflowAgentRequest } from '../bus/events/workflow-agent-request.js';
import { WorkflowAgentResponse } from '../bus/events/workflow-agent-response.js';
import { logger } from '../logger.js';

type CircuitState = 'closed' | 'open' | 'half-open';

interface AgentResilienceState {
  circuitState: CircuitState;
  failureCount: number;
  cooldownTimer: ReturnType<typeof setTimeout> | null;
  activeCount: number;
  concurrencyLimit: number;
}

export interface WorkflowAgentHandlerDeps {
  messageBus: MessageBus;
  agentRepo: AgentRepository;
  spawner: ContainerSpawner;
  failureThreshold?: number;
  cooldownMs?: number;
}

export function createWorkflowAgentHandler(deps: WorkflowAgentHandlerDeps): { destroy: () => void } {
  const {
    messageBus,
    agentRepo,
    spawner,
    failureThreshold = 3,
    cooldownMs = 30_000,
  } = deps;

  const resilienceStates = new Map<string, AgentResilienceState>();

  function getOrCreateState(agentId: string, concurrencyLimit: number): AgentResilienceState {
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
      logger.info({ agentId }, 'Workflow agent circuit breaker closed');
    }
  }

  function recordFailure(agentId: string, state: AgentResilienceState): void {
    state.failureCount++;
    if (state.failureCount >= failureThreshold && state.circuitState === 'closed') {
      state.circuitState = 'open';
      logger.warn({ agentId, failures: state.failureCount }, 'Workflow agent circuit breaker opened');
      state.cooldownTimer = setTimeout(() => {
        state.circuitState = 'half-open';
        state.cooldownTimer = null;
        logger.info({ agentId }, 'Workflow agent circuit breaker half-open');
      }, cooldownMs);
    }
  }

  function emitResponse(
    event: WorkflowAgentRequest,
    status: 'success' | 'error',
    text: string,
    durationMs: number,
  ): Promise<void> {
    return messageBus.emit(new WorkflowAgentResponse('workflow-agent-handler', {
      status, text, durationMs,
      runId: event.runId,
      stepId: event.stepId,
      correlationId: event.correlationId,
    }));
  }

  const unsubscribe = messageBus.on(
    WorkflowAgentRequest,
    async (event) => {
      const agent = agentRepo.getById(event.agentId);
      if (!agent) {
        logger.warn({ agentId: event.agentId, runId: event.runId }, 'WorkflowAgentRequest for unknown agent');
        await emitResponse(event, 'error', `Agent not found: ${event.agentId}`, 0);
        return;
      }

      const state = getOrCreateState(event.agentId, agent.concurrency);

      if (state.circuitState === 'open') {
        logger.warn({ agentId: event.agentId }, 'Workflow agent rejected by circuit breaker');
        await emitResponse(event, 'error', `Circuit open for agent "${event.agentId}"`, 0);
        return;
      }

      if (state.activeCount >= state.concurrencyLimit) {
        logger.warn({ agentId: event.agentId, activeCount: state.activeCount }, 'Workflow agent rejected by bulkhead');
        await emitResponse(event, 'error', `Bulkhead full for agent "${event.agentId}"`, 0);
        return;
      }

      state.activeCount++;
      const startTime = Date.now();
      try {
        const result = await spawner.spawn(
          agent,
          event.prompt,
          `workflow:${event.runId}`,
          agent.timeoutMs,
        );
        const durationMs = Date.now() - startTime;

        if (result.status === 'success') {
          recordSuccess(event.agentId, state);
        } else {
          recordFailure(event.agentId, state);
        }

        await emitResponse(event, result.status, result.content, durationMs);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        recordFailure(event.agentId, state);
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, agentId: event.agentId, runId: event.runId }, 'Workflow agent spawn failed');

        await emitResponse(event, 'error', `Spawn failed: ${errorMsg}`, durationMs);
      } finally {
        state.activeCount--;
      }
    },
    {
      id: 'workflow-agent-handler',
      priority: 50,
      source: 'workflow-agent-handler',
    },
  );

  return {
    destroy(): void {
      unsubscribe();
      for (const state of resilienceStates.values()) {
        if (state.cooldownTimer) clearTimeout(state.cooldownTimer);
      }
      resilienceStates.clear();
      logger.debug('Workflow agent handler destroyed');
    },
  };
}
