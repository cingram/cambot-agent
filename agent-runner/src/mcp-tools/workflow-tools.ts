/**
 * MCP tool registration: workflow management (list, status, run, pause, cancel, CRUD).
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError, requestWithTimeout } from './helpers.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

export function registerWorkflowTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'list_workflows',
    'List all available workflow definitions. Shows workflow ID, name, description, step count, and schedule.',
    {},
    async () => {
      const result = await requestWithTimeout(
        ctx.client,
        { type: FRAME_TYPES.WORKFLOW_LIST, id: uuid(), payload: {} },
        10_000,
        'Workflow list',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'workflow_status',
    'Get the status of recent workflow runs. Optionally filter by workflow ID or specific run ID.',
    {
      workflow_id: z.string().optional().describe('Filter runs by workflow ID'),
      run_id: z.string().optional().describe('Get status of a specific run'),
    },
    async (args) => {
      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.WORKFLOW_STATUS,
          id: uuid(),
          payload: { workflowId: args.workflow_id, runId: args.run_id },
        },
        10_000,
        'Workflow status',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'run_workflow',
    'Start a workflow execution. The workflow runs on the host and results are reported back. Main group only.',
    {
      workflow_id: z.string().describe('The workflow ID to run (from list_workflows)'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can run workflows.');

      ctx.client.send({
        type: FRAME_TYPES.WORKFLOW_RUN,
        id: uuid(),
        payload: { workflowId: args.workflow_id, chatJid: ctx.chatJid, groupFolder: ctx.groupFolder },
      });

      return mcpText(`Workflow "${args.workflow_id}" run requested. You'll be notified when it completes.`);
    },
  );

  ctx.server.tool(
    'pause_workflow',
    'Pause a running workflow. It can be resumed later. Main group only.',
    {
      run_id: z.string().describe('The run ID to pause (from workflow_status)'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can pause workflows.');

      ctx.client.send({
        type: FRAME_TYPES.WORKFLOW_PAUSE,
        id: uuid(),
        payload: { runId: args.run_id, groupFolder: ctx.groupFolder },
      });

      return mcpText(`Workflow run ${args.run_id} pause requested.`);
    },
  );

  ctx.server.tool(
    'cancel_workflow',
    'Cancel a running or paused workflow. Main group only.',
    {
      run_id: z.string().describe('The run ID to cancel (from workflow_status)'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can cancel workflows.');

      ctx.client.send({
        type: FRAME_TYPES.WORKFLOW_CANCEL,
        id: uuid(),
        payload: { runId: args.run_id, groupFolder: ctx.groupFolder },
      });

      return mcpText(`Workflow run ${args.run_id} cancellation requested.`);
    },
  );

  // ── Workflow CRUD (request/response) ────────────────────────────────

  ctx.server.tool(
    'create_workflow',
    'Create a new workflow definition. Returns the created workflow ID. Main group only.',
    {
      workflow: z.string().describe('JSON string of the workflow definition'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can create workflows.');

      let parsed: unknown;
      try {
        parsed = JSON.parse(args.workflow);
      } catch {
        return mcpError('Invalid workflow JSON.');
      }

      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.WORKFLOW_CREATE,
          id: uuid(),
          payload: { requestId: uuid(), workflow: parsed },
        },
        30_000,
        'Workflow creation',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'update_workflow',
    'Update an existing workflow definition. Main group only.',
    {
      workflow_id: z.string().describe('The workflow ID to update'),
      workflow: z.string().describe('JSON string of the updated workflow definition'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can update workflows.');

      let parsed: unknown;
      try {
        parsed = JSON.parse(args.workflow);
      } catch {
        return mcpError('Invalid workflow JSON.');
      }

      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.WORKFLOW_UPDATE,
          id: uuid(),
          payload: { requestId: uuid(), workflowId: args.workflow_id, workflow: parsed },
        },
        30_000,
        'Workflow update',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'delete_workflow',
    'Delete a workflow definition. Main group only.',
    {
      workflow_id: z.string().describe('The workflow ID to delete'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can delete workflows.');

      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.WORKFLOW_DELETE,
          id: uuid(),
          payload: { requestId: uuid(), workflowId: args.workflow_id },
        },
        30_000,
        'Workflow deletion',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'validate_workflow',
    'Validate a workflow definition without saving it. Returns validation errors if any.',
    {
      workflow: z.string().describe('JSON string of the workflow definition to validate'),
    },
    async (args) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(args.workflow);
      } catch {
        return mcpError('Invalid workflow JSON.');
      }

      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.WORKFLOW_VALIDATE,
          id: uuid(),
          payload: { requestId: uuid(), workflow: parsed },
        },
        30_000,
        'Workflow validation',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'clone_workflow',
    'Clone an existing workflow with a new ID and optional new name. Main group only.',
    {
      source_id: z.string().describe('The workflow ID to clone'),
      new_id: z.string().describe('The new workflow ID'),
      new_name: z.string().optional().describe('Optional new name for the cloned workflow'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can clone workflows.');

      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.WORKFLOW_CLONE,
          id: uuid(),
          payload: {
            requestId: uuid(),
            sourceId: args.source_id,
            newId: args.new_id,
            newName: args.new_name,
          },
        },
        30_000,
        'Workflow clone',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'get_workflow_schema',
    'Get the JSON schema for workflow definitions. Useful for understanding the required format.',
    {},
    async () => {
      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.WORKFLOW_SCHEMA,
          id: uuid(),
          payload: { requestId: uuid() },
        },
        10_000,
        'Workflow schema',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );
}
