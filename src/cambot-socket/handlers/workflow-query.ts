/**
 * workflow.list / workflow.status handlers — read-only workflow queries.
 *
 * workflow.list: returns all workflow definitions.
 * workflow.status: returns recent run status, optionally filtered.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

// ── Schemas ──────────────────────────────────────────────

const WorkflowListSchema = z.object({}).passthrough();

const WorkflowStatusSchema = z.object({
  workflowId: z.string().optional(),
  runId: z.string().optional(),
});

// ── Registration ─────────────────────────────────────────

export function registerWorkflowQuery(registry: CommandRegistry): void {
  // ── workflow.list ─────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_LIST,
    WorkflowListSchema,
    'any',
    async (_payload, frame, connection, deps) => {
      if (!deps.workflowService) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Workflow service not initialized');
        return;
      }

      try {
        const workflows = deps.workflowService.listWorkflows();
        const lines = workflows.map((w) =>
          `[${w.id}] ${w.name} (${w.steps?.length ?? 0} steps)`,
        );

        connection.reply(frame, FRAME_TYPES.WORKFLOW_LIST, {
          status: 'ok',
          result: workflows.length > 0
            ? `${workflows.length} workflow(s):\n${lines.join('\n')}`
            : 'No workflows found.',
        });

        logger.debug({ count: workflows.length }, 'workflow.list processed');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'workflow.list failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── workflow.status ───────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_STATUS,
    WorkflowStatusSchema,
    'any',
    async (payload, frame, connection, deps) => {
      if (!deps.workflowService) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Workflow service not initialized');
        return;
      }

      try {
        // If a specific run is requested, return just that one
        if (payload.runId) {
          const run = deps.workflowService.getRunStatus(payload.runId);
          if (!run) {
            connection.reply(frame, FRAME_TYPES.WORKFLOW_STATUS, {
              status: 'ok',
              result: `Run "${payload.runId}" not found.`,
            });
            return;
          }

          connection.reply(frame, FRAME_TYPES.WORKFLOW_STATUS, {
            status: 'ok',
            result: `[${run.runId}] workflow=${run.workflowId} status=${run.status}`,
          });
          return;
        }

        const runs = deps.workflowService.listRuns(payload.workflowId);
        const lines = runs.map((r) =>
          `[${r.runId}] workflow=${r.workflowId} status=${r.status}`,
        );

        connection.reply(frame, FRAME_TYPES.WORKFLOW_STATUS, {
          status: 'ok',
          result: runs.length > 0
            ? `${runs.length} run(s):\n${lines.join('\n')}`
            : 'No runs found.',
        });

        logger.debug({ count: runs.length }, 'workflow.status processed');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'workflow.status failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );
}
