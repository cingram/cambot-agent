/**
 * Workflow Builder MCP Server
 *
 * Separate stdio MCP server for workflow CRUD operations.
 * Registered as 'workflow-builder' in the SDK mcpServers config.
 * Tools are namespaced as mcp__workflow-builder__*.
 *
 * Read-only tools (get_workflow, get_workflow_schema) read from local
 * snapshots at /workspace/snapshots/. CRUD tools are deprecated in this
 * file — use the socket-based versions in socket-mcp-stdio.ts instead.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';

const SNAPSHOTS_DIR = '/workspace/snapshots';
const TASKS_DIR = path.join(SNAPSHOTS_DIR, 'tasks');
const RESULTS_DIR = path.join(SNAPSHOTS_DIR, 'workflow-results');

const groupFolder = process.env.CAMBOT_AGENT_GROUP_FOLDER!;
const isMain = process.env.CAMBOT_AGENT_IS_MAIN === '1';

const POLL_MS = 250;
const TIMEOUT_MS = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
  return filename;
}

interface IpcResult {
  success: boolean;
  workflowId?: string;
  hash?: string;
  violations?: string[];
  error?: string;
  data?: unknown;
}

async function sendAndWaitForResult(requestData: object): Promise<IpcResult> {
  const requestId = `wfb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const data = { ...requestData, requestId, groupFolder, timestamp: new Date().toISOString() };

  writeIpcFile(TASKS_DIR, data);

  // Poll for result
  const resultFile = path.join(RESULTS_DIR, `${requestId}.json`);
  const start = Date.now();

  while (Date.now() - start < TIMEOUT_MS) {
    if (fs.existsSync(resultFile)) {
      const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as IpcResult;
      try { fs.unlinkSync(resultFile); } catch { /* best-effort cleanup */ }
      return result;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  return { success: false, error: 'Request timed out after 30s' };
}

function mainOnlyGuard(): { content: Array<{ type: 'text'; text: string }>; isError: true } | null {
  if (!isMain) {
    return {
      content: [{ type: 'text' as const, text: 'Only the main group can manage workflow definitions.' }],
      isError: true,
    };
  }
  return null;
}

function formatResult(result: IpcResult): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } {
  if (!result.success) {
    const parts: string[] = [];
    if (result.error) parts.push(result.error);
    if (result.violations?.length) {
      parts.push('Validation errors:');
      for (const v of result.violations) parts.push(`  - ${v}`);
    }
    return {
      content: [{ type: 'text' as const, text: parts.join('\n') || 'Unknown error' }],
      isError: true,
    };
  }

  const parts: string[] = [];
  if (result.workflowId) parts.push(`Workflow: ${result.workflowId}`);
  if (result.hash) parts.push(`Hash: ${result.hash}`);
  if (result.data) parts.push(typeof result.data === 'string' ? result.data : JSON.stringify(result.data, null, 2));
  return {
    content: [{ type: 'text' as const, text: parts.join('\n') || 'OK' }],
  };
}

// ── Zod schemas ──────────────────────────────────────────────────────

const policySchema = z.object({
  maxCostUsd: z.number().describe('Maximum cost in USD for the entire workflow run'),
  maxTokens: z.number().describe('Maximum total tokens (input + output)'),
  maxOutputSizeBytes: z.number().describe('Maximum output size per step in bytes'),
  piiAction: z.enum(['block', 'redact']).describe('How to handle PII in outputs'),
  secretPatterns: z.array(z.string()).describe('Regex patterns for secrets to block'),
  network: z.object({
    allowed_domains: z.array(z.string()).describe('Domains the workflow can access'),
    block_paywalled: z.boolean().describe('Block paywalled content'),
  }),
});

const stepSchema = z.object({
  id: z.string().describe('Unique step identifier (kebab-case)'),
  type: z.enum(['agent', 'tool', 'memory', 'message', 'gate', 'parallel', 'sync'])
    .describe('Step type'),
  name: z.string().describe('Human-readable step name'),
  config: z.record(z.string(), z.unknown()).describe('Step-type-specific configuration'),
  after: z.array(z.string()).optional().describe('Step IDs that must complete before this step'),
  retries: z.number().optional().describe('Number of retries on failure'),
  timeout: z.number().optional().describe('Timeout in milliseconds'),
});

const workflowSchema = z.object({
  id: z.string().describe('Workflow ID (kebab-case)'),
  name: z.string().describe('Human-readable workflow name'),
  description: z.string().describe('What this workflow does'),
  version: z.string().optional().default('1.0').describe('Workflow version'),
  schedule: z.object({
    cron: z.string().describe('Cron expression'),
    timezone: z.string().optional().describe('IANA timezone'),
  }).optional().describe('Automatic schedule (optional)'),
  policy: policySchema,
  steps: z.array(stepSchema).min(1).describe('Workflow steps (DAG)'),
});

// ── MCP Server ───────────────────────────────────────────────────────

const server = new McpServer({
  name: 'workflow-builder',
  version: '1.0.0',
});

// ── get_workflow ─────────────────────────────────────────────────────

server.tool(
  'get_workflow',
  'Get the full workflow definition including all steps, policy, and schedule. Reads from the local per-workflow snapshot — O(1) lookup by filename.',
  {
    workflow_id: z.string().describe('The workflow ID to retrieve'),
  },
  async (args) => {
    const wfFile = path.join(SNAPSHOTS_DIR, 'workflows', `${args.workflow_id}.json`);
    if (!fs.existsSync(wfFile)) {
      return {
        content: [{ type: 'text' as const, text: `Workflow "${args.workflow_id}" not found.` }],
        isError: true,
      };
    }

    try {
      const workflow = fs.readFileSync(wfFile, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: workflow }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading workflow: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── create_workflow ──────────────────────────────────────────────────

server.tool(
  'create_workflow',
  `Create a new workflow from a structured definition. The host validates the DAG, computes the hash, and writes the YAML file.

RECOMMENDED FLOW: get_workflow_schema → validate_workflow → create_workflow

See the workflow-builder skill (/workflow-builder) for step type details, DAG patterns, and examples.`,
  {
    workflow: workflowSchema,
  },
  async (args) => {
    const guard = mainOnlyGuard();
    if (guard) return guard;

    const result = await sendAndWaitForResult({
      type: 'create_workflow_def',
      workflow: args.workflow,
    });
    return formatResult(result);
  },
);

// ── update_workflow ──────────────────────────────────────────────────

server.tool(
  'update_workflow',
  'Replace an existing workflow definition. Fails if the workflow has an active run.',
  {
    workflow_id: z.string().describe('The workflow ID to update'),
    workflow: workflowSchema,
  },
  async (args) => {
    const guard = mainOnlyGuard();
    if (guard) return guard;

    const result = await sendAndWaitForResult({
      type: 'update_workflow_def',
      workflowId: args.workflow_id,
      workflow: args.workflow,
    });
    return formatResult(result);
  },
);

// ── delete_workflow ──────────────────────────────────────────────────

server.tool(
  'delete_workflow',
  'Delete a workflow definition. Fails if the workflow has an active run.',
  {
    workflow_id: z.string().describe('The workflow ID to delete'),
  },
  async (args) => {
    const guard = mainOnlyGuard();
    if (guard) return guard;

    const result = await sendAndWaitForResult({
      type: 'delete_workflow_def',
      workflowId: args.workflow_id,
    });
    return formatResult(result);
  },
);

// ── validate_workflow ────────────────────────────────────────────────

server.tool(
  'validate_workflow',
  'Dry-run validation of a workflow definition without saving. Returns violations or the computed hash on success.',
  {
    workflow: workflowSchema,
  },
  async (args) => {
    const guard = mainOnlyGuard();
    if (guard) return guard;

    const result = await sendAndWaitForResult({
      type: 'validate_workflow_def',
      workflow: args.workflow,
    });
    return formatResult(result);
  },
);

// ── clone_workflow ───────────────────────────────────────────────────

server.tool(
  'clone_workflow',
  'Copy an existing workflow with a new ID and optionally a new name.',
  {
    source_workflow_id: z.string().describe('The workflow ID to clone from'),
    new_id: z.string().describe('New workflow ID (kebab-case)'),
    new_name: z.string().optional().describe('New display name (defaults to "Original Name (copy)")'),
  },
  async (args) => {
    const guard = mainOnlyGuard();
    if (guard) return guard;

    const result = await sendAndWaitForResult({
      type: 'clone_workflow_def',
      sourceId: args.source_workflow_id,
      newId: args.new_id,
      newName: args.new_name,
    });
    return formatResult(result);
  },
);

// ── get_workflow_schema ──────────────────────────────────────────────

server.tool(
  'get_workflow_schema',
  'Get the available step types, their config schemas, gate operators, and available tools. Use this before building a workflow to understand what is possible.',
  {},
  async () => {
    // Read from snapshot if available
    const schemaFile = path.join(SNAPSHOTS_DIR, 'workflow_schema.json');
    if (fs.existsSync(schemaFile)) {
      const schema = fs.readFileSync(schemaFile, 'utf-8');
      return {
        content: [{ type: 'text' as const, text: schema }],
      };
    }

    // Fallback: request from host via IPC
    const result = await sendAndWaitForResult({
      type: 'get_workflow_schema',
    });

    if (!result.success) {
      return formatResult(result);
    }

    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
    };
  },
);

// ── Start ────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
