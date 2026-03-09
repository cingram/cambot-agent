/**
 * Workflow builder handlers — CRUD for workflow definitions.
 *
 * workflow.create / workflow.update / workflow.delete / workflow.validate /
 * workflow.clone / workflow.schema
 *
 * All are main-only except workflow.schema which is available to any group.
 * Ported from the file-based workflow builder IPC handlers.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import type { SocketFrame } from '../protocol/types.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';
import type { SocketDeps } from '../deps.js';
import type { CambotSocketConnection } from '../connection.js';
import type { WorkflowInput } from '../../workflows/workflow-builder-service.js';

// ── Schemas ──────────────────────────────────────────────

const WorkflowCreateSchema = z.object({
  workflow: z.record(z.string(), z.unknown()),
});

const WorkflowUpdateSchema = z.object({
  workflowId: z.string().min(1),
  workflow: z.record(z.string(), z.unknown()),
});

const WorkflowDeleteSchema = z.object({
  workflowId: z.string().min(1),
});

const WorkflowValidateSchema = z.object({
  workflow: z.record(z.string(), z.unknown()),
});

const WorkflowCloneSchema = z.object({
  sourceId: z.string().min(1),
  newId: z.string().min(1),
  newName: z.string().optional(),
});

const WorkflowSchemaRequestSchema = z.object({}).passthrough();

// ── Helpers ──────────────────────────────────────────────

function requireBuilderService(
  deps: SocketDeps,
  frame: SocketFrame,
  connection: CambotSocketConnection,
): boolean {
  if (!deps.workflowBuilderService) {
    logger.warn('Workflow builder command received but service not initialized');
    connection.replyError(frame, 'NOT_AVAILABLE', 'Workflow builder service not initialized');
    return false;
  }
  return true;
}

// ── Registration ─────────────────────────────────────────

export function registerWorkflowBuilder(registry: CommandRegistry): void {
  // ── workflow.create ─────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_CREATE,
    WorkflowCreateSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!requireBuilderService(deps, frame, connection)) return;

      const result = deps.workflowBuilderService!.createWorkflow(
        payload.workflow as unknown as WorkflowInput,
      );

      connection.reply(frame, FRAME_TYPES.WORKFLOW_CREATE, result);
      logger.info({ success: result.success }, 'workflow.create processed via socket');
    },
  );

  // ── workflow.update ─────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_UPDATE,
    WorkflowUpdateSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!requireBuilderService(deps, frame, connection)) return;

      const result = deps.workflowBuilderService!.updateWorkflow(
        payload.workflowId,
        payload.workflow as unknown as WorkflowInput,
      );

      connection.reply(frame, FRAME_TYPES.WORKFLOW_UPDATE, result);
      logger.info(
        { workflowId: payload.workflowId, success: result.success },
        'workflow.update processed via socket',
      );
    },
  );

  // ── workflow.delete ─────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_DELETE,
    WorkflowDeleteSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!requireBuilderService(deps, frame, connection)) return;

      const result = deps.workflowBuilderService!.deleteWorkflow(payload.workflowId);
      connection.reply(frame, FRAME_TYPES.WORKFLOW_DELETE, result);
      logger.info(
        { workflowId: payload.workflowId, success: result.success },
        'workflow.delete processed via socket',
      );
    },
  );

  // ── workflow.validate ───────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_VALIDATE,
    WorkflowValidateSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!requireBuilderService(deps, frame, connection)) return;

      const result = deps.workflowBuilderService!.validateWorkflow(
        payload.workflow as unknown as WorkflowInput,
      );

      connection.reply(frame, FRAME_TYPES.WORKFLOW_VALIDATE, result);
      logger.info({ success: result.success }, 'workflow.validate processed via socket');
    },
  );

  // ── workflow.clone ──────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_CLONE,
    WorkflowCloneSchema,
    'main-only',
    async (payload, frame, connection, deps) => {
      if (!requireBuilderService(deps, frame, connection)) return;

      const result = deps.workflowBuilderService!.cloneWorkflow(
        payload.sourceId,
        payload.newId,
        payload.newName,
      );

      connection.reply(frame, FRAME_TYPES.WORKFLOW_CLONE, result);
      logger.info(
        { sourceId: payload.sourceId, newId: payload.newId, success: result.success },
        'workflow.clone processed via socket',
      );
    },
  );

  // ── workflow.schema ─────────────────────────────────────
  registry.register(
    FRAME_TYPES.WORKFLOW_SCHEMA,
    WorkflowSchemaRequestSchema,
    'any',
    async (_payload, frame, connection, deps) => {
      if (!requireBuilderService(deps, frame, connection)) return;

      const schema = deps.workflowBuilderService!.getSchema();
      connection.reply(frame, FRAME_TYPES.WORKFLOW_SCHEMA, {
        success: true,
        data: schema,
      });
    },
  );
}
