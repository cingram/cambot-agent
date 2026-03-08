/**
 * worker.delegate handler — spawn a stateless worker container, await result,
 * and reply with the output.
 *
 * Ported from the file-based delegate_worker IPC handler.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { runWorkerAgent } from '../../container/runner.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const WorkerDelegateSchema = z.object({
  delegationId: z.string().min(1),
  workerId: z.string().min(1),
  prompt: z.string().min(1),
  context: z.string().optional(),
});

type WorkerDelegatePayload = z.infer<typeof WorkerDelegateSchema>;

export function registerWorkerDelegate(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.WORKER_DELEGATE,
    WorkerDelegateSchema,
    'any',
    async (payload: WorkerDelegatePayload, frame, connection, deps) => {
      const { group: sourceGroup } = connection.identity;
      const { delegationId, workerId, prompt, context } = payload;

      // Resolve worker definition
      const workerDef = deps.getAgentDefinition(workerId);
      if (!workerDef) {
        logger.warn({ workerId }, 'Worker not found for delegation');
        connection.replyError(frame, 'NOT_FOUND', `Worker "${workerId}" not found`, { delegationId });
        return;
      }

      // Resolve container image
      let agentOpts;
      try {
        agentOpts = deps.resolveAgentImage(workerId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error({ workerId, error: message }, 'Failed to resolve worker image');
        connection.replyError(frame, 'HANDLER_ERROR', message, { delegationId });
        return;
      }

      // Build full prompt with optional context
      const fullPrompt = context
        ? `${prompt}\n\n--- Context ---\n${context}`
        : prompt;

      logger.info({ delegationId, workerId, sourceGroup }, 'Delegating to worker via socket');

      // Run worker (async — reply when complete)
      try {
        const output = await runWorkerAgent(sourceGroup, delegationId, fullPrompt, agentOpts);
        connection.reply(frame, FRAME_TYPES.WORKER_DELEGATE, {
          delegationId,
          status: output.status,
          result: output.result,
          error: output.error,
        });
        logger.info(
          { delegationId, workerId, status: output.status },
          'Worker delegation completed',
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        connection.replyError(frame, 'HANDLER_ERROR', message, { delegationId });
        logger.error({ delegationId, workerId, error: message }, 'Worker delegation failed');
      }
    },
  );
}
