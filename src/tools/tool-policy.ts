/**
 * Tool Policy — resolves per-group/agent SDK + MCP tool restrictions.
 *
 * Policies are stored in the database (never mounted into containers)
 * so agents cannot modify their own tool access.
 */

import { logger } from '../logger.js';

// ── SDK Tools ───────────────────────────────────────────────────

export const ALL_SDK_TOOLS = [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'TodoWrite', 'Skill',
  'NotebookEdit',
] as const;

export type SdkTool = (typeof ALL_SDK_TOOLS)[number];

export type ToolPreset = 'full' | 'standard' | 'readonly' | 'minimal' | 'sandboxed' | 'gateway';

const TOOL_PRESETS: Record<ToolPreset, readonly string[]> = {
  full: ALL_SDK_TOOLS,
  standard: ALL_SDK_TOOLS.filter(
    t => !['TeamCreate', 'TeamDelete', 'SendMessage', 'NotebookEdit'].includes(t),
  ),
  readonly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill'],
  minimal: ['Read', 'Glob', 'Grep'],
  sandboxed: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'TodoWrite', 'ToolSearch', 'Skill'],
  gateway: ['Read', 'Glob', 'Grep'],
};

export interface ToolPolicy {
  preset?: ToolPreset;
  allow?: string[];
  deny?: string[];
  add?: string[];
  mcp?: McpToolPolicy;
}

// ── MCP Tools ───────────────────────────────────────────────────

/** All cambot-agent MCP tools (short names). */
export const CAMBOT_MCP_TOOLS = [
  'send_message',
  'send_to_agent',
  'check_email',
  'read_email',
  'list_tasks',
  'schedule_task',
  'register_group',
  'create_custom_agent',
  'list_custom_agents',
  'invoke_custom_agent',
  'update_custom_agent',
  'delete_custom_agent',
  'list_workflows',
  'run_workflow',
  'create_workflow',
  'update_workflow',
  'delete_workflow',
  'memory_query',
  'memory_confirm',
  'memory_correct',
  'memory_fading',
  'save_context',
  'submit_notification',
  'get_notifications',
  'acknowledge_notifications',
] as const;

/** Workflow-builder MCP tools (conceptual grouping — subset of CAMBOT_MCP_TOOLS). */
export const WORKFLOW_MCP_TOOLS = [
  'create_workflow',
  'update_workflow',
  'list_workflows',
  'run_workflow',
  'delete_workflow',
] as const;

/** Google Workspace MCP tools (short names — must match workspace-mcp v3.x tool names). */
export const GOOGLE_MCP_TOOLS = [
  // Gmail (outbound only — read goes through check_email/read_email IPC)
  'send_gmail_message',
  'search_gmail_messages',
  'get_gmail_message_content',
  'get_gmail_messages_content_batch',
  'list_gmail_labels',
  'list_gmail_filters',
  'manage_gmail_label',
  'manage_gmail_filter',
  'modify_gmail_message_labels',
  'draft_gmail_message',
  // Calendar
  'get_events',
  'manage_event',
  'list_calendars',
  'query_freebusy',
  // Tasks
  'list_task_lists',
  'list_tasks',
  'get_task',
  'get_task_list',
  'manage_task',
  'manage_task_list',
  // Drive
  'search_drive_files',
  'get_drive_file_content',
  'list_drive_files',
  'list_drive_items',
  // Docs
  'get_doc_content',
  'get_doc_as_markdown',
  'create_doc',
  // Sheets
  'get_spreadsheet',
  'get_spreadsheet_info',
  'read_sheet_values',
  'create_spreadsheet',
  'create_sheet',
  'update_spreadsheet_values',
  'modify_sheet_values',
  // Contacts
  'list_contacts',
  'search_contacts',
  'get_contact',
] as const;

/** Read-only subset of Google Workspace tools. */
const GOOGLE_READONLY_TOOLS = [
  'list_gmail_labels',
  'list_gmail_filters',
  'search_gmail_messages',
  'get_gmail_message_content',
  'get_gmail_messages_content_batch',
  'get_events',
  'list_calendars',
  'query_freebusy',
  'list_task_lists',
  'list_tasks',
  'get_task',
  'get_task_list',
  'search_drive_files',
  'get_drive_file_content',
  'list_drive_files',
  'list_drive_items',
  'get_doc_content',
  'get_doc_as_markdown',
  'get_spreadsheet',
  'get_spreadsheet_info',
  'read_sheet_values',
  'list_contacts',
  'search_contacts',
  'get_contact',
] as const;

/** MCP tool override within a ToolPolicy. */
export interface McpToolPolicy {
  /** Explicit allowlist (ignores preset MCP defaults). */
  allow?: string[];
  /** Remove specific MCP tools from preset defaults. */
  deny?: string[];
  /** Add specific MCP tools on top of preset defaults. */
  add?: string[];
}

/** MCP tools granted to each preset by default (deduplicated at definition time). */
const MCP_PRESETS: Record<ToolPreset, readonly string[]> = {
  // WORKFLOW_MCP_TOOLS ⊂ CAMBOT_MCP_TOOLS, so only spread cambot + google.
  // list_tasks appears in both; Set deduplicates.
  full: [...new Set([...CAMBOT_MCP_TOOLS, ...GOOGLE_MCP_TOOLS])],
  standard: [...new Set([
    'send_message',
    'send_to_agent',
    'check_email',
    'read_email',
    'list_tasks',
    'schedule_task',
    'list_workflows',
    'run_workflow',
    'memory_query',
    'memory_confirm',
    'memory_correct',
    'memory_fading',
    ...GOOGLE_MCP_TOOLS,
  ])],
  sandboxed: [
    'send_message',
    'check_email',
    'read_email',
    'list_tasks',
  ],
  readonly: [...new Set([
    'send_message',
    'check_email',
    'read_email',
    'list_tasks',
    'list_workflows',
    'list_custom_agents',
    ...GOOGLE_READONLY_TOOLS,
  ])],
  minimal: [
    'send_message',
    'list_tasks',
  ],
  gateway: [
    'send_message',
  ],
};

// ── Tool-to-Server Mapping ──────────────────────────────────────

/**
 * Maps MCP short names → server name(s). Derived from canonical tool lists.
 * A tool can belong to multiple servers (e.g. list_tasks → cambot-agent + google-workspace).
 */
const MCP_TOOL_SERVERS: Record<string, string[]> = buildToolServerMap([
  { server: 'cambot-agent', tools: CAMBOT_MCP_TOOLS },
  { server: 'google-workspace', tools: GOOGLE_MCP_TOOLS },
]);

function buildToolServerMap(
  entries: Array<{ server: string; tools: readonly string[] }>,
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const { server, tools } of entries) {
    for (const tool of tools) {
      (map[tool] ??= []).push(server);
    }
  }
  return map;
}

// ── Generic Resolution ──────────────────────────────────────────

interface ToolOverrides {
  allow?: string[];
  deny?: string[];
  add?: string[];
}

/**
 * Shared resolution logic for both SDK and MCP tools.
 * Priority: allow → preset base → deny → add.
 */
function resolveFromPresets(
  presets: Record<ToolPreset, readonly string[]>,
  preset: ToolPreset,
  overrides?: ToolOverrides,
): string[] {
  if (overrides?.allow) return [...overrides.allow];

  const base = presets[preset];
  if (!base) {
    throw new Error(`Unknown tool preset: ${preset}`);
  }

  let tools = [...new Set(base)];

  if (overrides?.deny) {
    const denySet = new Set(overrides.deny);
    tools = tools.filter(t => !denySet.has(t));
  }

  if (overrides?.add) {
    const existing = new Set(tools);
    for (const t of overrides.add) {
      if (!existing.has(t)) tools.push(t);
    }
  }

  return tools;
}

/**
 * Resolve a ToolPolicy to a flat list of SDK tool names.
 * No policy = no SDK tools (least privilege by default).
 */
export function resolveToolList(policy?: ToolPolicy): string[] {
  if (!policy) return [];
  return resolveFromPresets(TOOL_PRESETS, policy.preset ?? 'full', policy);
}

/**
 * Compute SDK tools that must be hard-blocked via the SDK's disallowedTools.
 * This is the complement of resolveToolList against all possible SDK tools,
 * ensuring tools excluded by deny/preset cannot be re-loaded at runtime.
 */
export function resolveDisallowedTools(policy?: ToolPolicy): string[] {
  const allowed = new Set(resolveToolList(policy));
  return ALL_SDK_TOOLS.filter(t => !allowed.has(t));
}

/**
 * Resolve a ToolPolicy to a flat list of MCP tool short names.
 * No policy = no MCP tools (least privilege by default).
 */
export function resolveMcpToolList(policy?: ToolPolicy): string[] {
  if (!policy) return [];
  // If the policy only specifies SDK-level allow/deny/add (no preset, no mcp field),
  // treat MCP tools as unspecified → least-privilege empty list.
  if (!policy.preset && !policy.mcp) return [];
  return resolveFromPresets(MCP_PRESETS, policy.preset ?? 'full', policy.mcp);
}

// ── Qualification ───────────────────────────────────────────────

/**
 * Convert a short MCP tool name to its qualified SDK form.
 * E.g. qualifyMcpTool('send_message', 'cambot-agent') → 'mcp__cambot-agent__send_message'
 */
export function qualifyMcpTool(shortName: string, serverName: string): string {
  return `mcp__${serverName}__${shortName}`;
}

/**
 * Convert a list of MCP short names to qualified SDK names.
 * Tools on multiple servers (e.g. list_tasks) produce multiple entries.
 */
export function qualifyMcpToolList(shortNames: string[]): string[] {
  const qualified: string[] = [];
  for (const name of shortNames) {
    const servers = MCP_TOOL_SERVERS[name];
    if (servers) {
      for (const server of servers) {
        qualified.push(qualifyMcpTool(name, server));
      }
    } else {
      logger.warn({ tool: name }, 'Unknown MCP tool name — not mapped to any server, skipping');
    }
  }
  return qualified;
}

// ── Safety Denials ──────────────────────────────────────────────

/** Gmail read tools that must always go through check_email/read_email IPC. */
const ALWAYS_BLOCKED_MCP_TOOLS = [
  'search_gmail_messages',
  'get_gmail_message',
];

/** Admin tools blocked for non-main agents. */
const ADMIN_ONLY_MCP_TOOLS = [
  'register_group',
  'create_custom_agent',
  'update_custom_agent',
  'delete_custom_agent',
  'get_notifications',
  'acknowledge_notifications',
];

export interface SafetyContext {
  isInterAgentTarget: boolean;
  isMain: boolean;
}

/**
 * Apply non-negotiable safety denials AFTER policy resolution.
 * These cannot be overridden by any policy configuration.
 */
export function applySafetyDenials(mcpTools: string[], ctx: SafetyContext): string[] {
  const blocked = new Set<string>(ALWAYS_BLOCKED_MCP_TOOLS);

  if (ctx.isInterAgentTarget) {
    blocked.add('send_to_agent');
  }

  if (!ctx.isMain) {
    for (const tool of ADMIN_ONLY_MCP_TOOLS) {
      blocked.add(tool);
    }
  }

  return mcpTools.filter(t => !blocked.has(t));
}
