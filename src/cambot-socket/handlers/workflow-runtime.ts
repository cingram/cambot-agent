/**
 * workflow.run / workflow.pause / workflow.cancel handlers.
 *
 * All workflow runtime operations are main-only.
 * Ported from the file-based run_workflow/pause_workflow/cancel_workflow IPC handlers.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { OutboundMessage } from '../../bus/index.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

// ── Schemas ──────────────────────────────────────────────

const WorkflowRunSchema = z.object({
  workflowId: z.string().min(1),
  chatJid: z.string().optional(),
});

const WorkflowPauseSchema = z.object({
  runId: z.string().min(1),
});

const WorkflowCancelSchema = z.object({
  runId: z.string().min(1),
});

type WorkflowRunPayload = z.infer<typeof WorkflowRunSchema>;
type WorkflowPausePayload = z.infer<typeof WorkflowPauseSchema>;
type WorkflowCancelPayload = z.infer<typeof WorkflowCancelSchema>;

export function registerWorkflowRuntime(registry: CommandRegistry): void {
  // ── workflow.run ────────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_RUN,
    WorkflowRunSchema,
    'main-only',
    async (payload: WorkflowRunPayload, frame, connection, deps) => {
      const { group: sourceGroup } = connection.identity;

      if (!deps.workflowService) {
        logger.warn('workflow.run received but workflow service not initialized');
        connection.replyError(frame, 'NOT_AVAILABLE', 'Workflow service not initialized');
        return;
      }

      try {
        const runId = await deps.workflowService.runWorkflow(payload.workflowId);
        logger.info(
          { workflowId: payload.workflowId, runId, sourceGroup },
          'Workflow started via socket',
        );

        connection.reply(frame, FRAME_TYPES.WORKFLOW_RUN, {
          status: 'started',
          workflowId: payload.workflowId,
          runId,
        });

        // Optional: send status message to chat
        if (payload.chatJid) {
          await deps.bus.emit(
            new OutboundMessage(
              'ipc',
              payload.chatJid,
              `Workflow "${payload.workflowId}" started (run: ${runId})`,
              { groupFolder: sourceGroup },
            ),
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ workflowId: payload.workflowId, err }, 'Workflow run failed');

        connection.replyError(frame, 'HANDLER_ERROR', msg, { workflowId: payload.workflowId });

        if (payload.chatJid) {
          await deps.bus.emit(
            new OutboundMessage(
              'ipc',
              payload.chatJid,
              `Workflow "${payload.workflowId}" failed: ${msg}`,
              { groupFolder: sourceGroup },
            ),
          );
        }
      }
    },
  );

  // ── workflow.pause ──────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_PAUSE,
    WorkflowPauseSchema,
    'main-only',
    async (payload: WorkflowPausePayload, frame, connection, deps) => {
      if (!deps.workflowService) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Workflow service not initialized');
        return;
      }

      try {
        deps.workflowService.pauseRun(payload.runId);
        logger.info({ runId: payload.runId }, 'Workflow paused via socket');
        connection.reply(frame, FRAME_TYPES.WORKFLOW_PAUSE, {
          status: 'paused',
          runId: payload.runId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ runId: payload.runId, err }, 'Workflow pause failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );

  // ── workflow.cancel ─────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_CANCEL,
    WorkflowCancelSchema,
    'main-only',
    async (payload: WorkflowCancelPayload, frame, connection, deps) => {
      if (!deps.workflowService) {
        connection.replyError(frame, 'NOT_AVAILABLE', 'Workflow service not initialized');
        return;
      }

      try {
        deps.workflowService.cancelRun(payload.runId);
        logger.info({ runId: payload.runId }, 'Workflow cancelled via socket');
        connection.reply(frame, FRAME_TYPES.WORKFLOW_CANCEL, {
          status: 'cancelled',
          runId: payload.runId,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ runId: payload.runId, err }, 'Workflow cancel failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );
}
