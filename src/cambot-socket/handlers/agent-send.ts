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

/** Truncate a string for log display. */
function truncate(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

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

      const startMs = Date.now();

      logger.info(
        {
          source: sourceGroup,
          target: payload.targetAgent,
          prompt: truncate(payload.prompt),
        },
        `[agent-bus] ${sourceGroup} → ${payload.targetAgent}: "${truncate(payload.prompt, 80)}"`,
      );

      // Spawn the target agent and await result
      try {
        const result = await deps.agentSpawner.spawn(
          targetAgent,
          payload.prompt,
          `agent:${sourceGroup}`,
          targetAgent.timeoutMs,
        );

        const durationMs = Date.now() - startMs;
        const resultPreview = result.content ? truncate(result.content) : '(empty)';

        connection.reply(frame, FRAME_TYPES.AGENT_SEND, {
          status: result.status,
          result: result.content,
        });

        logger.info(
          {
            source: sourceGroup,
            target: payload.targetAgent,
            status: result.status,
            durationMs,
            result: resultPreview,
          },
          `[agent-bus] ${payload.targetAgent} → ${sourceGroup}: (${result.status}, ${(durationMs / 1000).toFixed(1)}s) "${truncate(resultPreview, 80)}"`,
        );
      } catch (err) {
        const durationMs = Date.now() - startMs;
        const message = err instanceof Error ? err.message : String(err);
        connection.replyError(frame, 'HANDLER_ERROR', message);
        logger.error(
          {
            source: sourceGroup,
            target: payload.targetAgent,
            error: message,
            durationMs,
          },
          `[agent-bus] ${sourceGroup} → ${payload.targetAgent}: FAILED (${(durationMs / 1000).toFixed(1)}s) ${message}`,
        );
      }
    },
  );
}
