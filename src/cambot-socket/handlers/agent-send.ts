/**
 * agent.send handler — send a message to another persistent agent,
 * await its response, and reply with the result.
 *
 * Ported from the file-based send_to_agent IPC handler.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const AgentSendSchema = z.object({
  targetAgent: z.string().min(1),
  prompt: z.string().min(1),
});

type AgentSendPayload = z.infer<typeof AgentSendSchema>;

export function registerAgentSend(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.AGENT_SEND,
    AgentSendSchema,
    'any',
    async (payload: AgentSendPayload, frame, connection, deps) => {
      const { group: sourceGroup } = connection.identity;

      if (!deps.agentSpawner || !deps.agentRepo) {
        logger.warn('agent.send received but persistent agent system not initialized');
        connection.replyError(frame, 'NOT_AVAILABLE', 'Persistent agent system not initialized');
        return;
      }

      // Look up the target agent
      const targetAgent = deps.agentRepo.getById(payload.targetAgent);
      if (!targetAgent) {
        logger.warn({ targetAgent: payload.targetAgent }, 'agent.send: target agent not found');
        connection.replyError(frame, 'NOT_FOUND', `Agent "${payload.targetAgent}" not found`);
        return;
      }

      logger.info(
        { sourceGroup, targetAgent: payload.targetAgent },
        'Dispatching inter-agent message via socket',
      );

      // Spawn the target agent and await result
      try {
        const result = await deps.agentSpawner.spawn(
          targetAgent,
          payload.prompt,
          `agent:${sourceGroup}`,
          targetAgent.timeoutMs,
        );

        connection.reply(frame, FRAME_TYPES.AGENT_SEND, {
          status: result.status,
          result: result.content,
        });

        logger.info(
          { sourceGroup, targetAgent: payload.targetAgent, status: result.status },
          'Inter-agent message completed',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        connection.replyError(frame, 'HANDLER_ERROR', message);
        logger.error(
          { sourceGroup, targetAgent: payload.targetAgent, error: message },
          'Inter-agent message failed',
        );
      }
    },
  );
}
