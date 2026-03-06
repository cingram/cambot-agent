/**
 * Reads MCP server config from a template file and resolves runtime variables.
 *
 * Template file: /home/node/.claude/mcp-servers.json (synced from container/mcp-servers.json)
 * Variables: ${SCRIPT_DIR}, ${CHAT_JID}, ${GROUP_FOLDER}, ${IS_MAIN}
 */
import fs from 'fs';
import type { McpServerConfig } from './types.js';

// ── Types ───────────────────────────────────────────────────────────

interface StdioMcpEntry {
  type: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface HttpMcpEntry {
  type: 'http' | 'sse';
  url: string;
}

type McpEntry = StdioMcpEntry | HttpMcpEntry;

type SdkMcpServers = Record<string, McpEntry>;

// ── Variable substitution ───────────────────────────────────────────

function substituteVars(text: string, vars: Record<string, string>): string {
  return text.replace(/\$\{(\w+)\}/g, (_, key) => vars[key] ?? '');
}

function resolveEntry(entry: McpEntry, vars: Record<string, string>): McpEntry {
  if (entry.type === 'stdio') {
    return {
      type: 'stdio',
      command: substituteVars(entry.command, vars),
      args: entry.args.map(a => substituteVars(a, vars)),
      env: entry.env
        ? Object.fromEntries(
            Object.entries(entry.env).map(([k, v]) => [k, substituteVars(v, vars)]),
          )
        : undefined,
    };
  }
  return {
    type: entry.type,
    url: substituteVars(entry.url, vars),
  };
}

// ── Public API ──────────────────────────────────────────────────────

export interface McpConfigVars {
  scriptDir: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
}

export interface ResolvedMcpConfig {
  servers: SdkMcpServers;
  allowedTools: string[];
}

export function loadMcpConfig(
  templatePath: string,
  vars: McpConfigVars,
  dynamicServers?: McpServerConfig[],
): ResolvedMcpConfig {
  const varMap: Record<string, string> = {
    SCRIPT_DIR: vars.scriptDir,
    CHAT_JID: vars.chatJid,
    GROUP_FOLDER: vars.groupFolder,
    IS_MAIN: vars.isMain ? '1' : '0',
  };

  // Load and resolve template
  const servers: SdkMcpServers = {};
  if (fs.existsSync(templatePath)) {
    const raw = JSON.parse(fs.readFileSync(templatePath, 'utf-8')) as Record<string, McpEntry>;
    for (const [name, entry] of Object.entries(raw)) {
      servers[name] = resolveEntry(entry, varMap);
    }
  }

  // Merge dynamic HTTP servers from host
  if (dynamicServers) {
    for (const s of dynamicServers) {
      servers[s.name] = { type: s.transport as 'http' | 'sse', url: s.url };
    }
  }

  // Build allowedTools from server names.
  // google-workspace uses an explicit allowlist instead of wildcard
  // to block raw Gmail read tools that would bypass the content pipe.
  const allowedTools: string[] = [];
  for (const name of Object.keys(servers)) {
    if (name === 'google-workspace') {
      allowedTools.push(
        ...GOOGLE_WORKSPACE_ALLOWED_TOOLS.map((t) => `mcp__google-workspace__${t}`),
      );
    } else {
      allowedTools.push(`mcp__${name}__*`);
    }
  }

  return { servers, allowedTools };
}

// Explicit allowlist of google-workspace MCP tools.
// Gmail read tools (search_gmail_messages, get_gmail_message) are intentionally
// excluded — the agent uses check_email/read_email IPC tools instead, which
// route content through the content pipe for injection detection.
const GOOGLE_WORKSPACE_ALLOWED_TOOLS = [
  // Gmail (outbound only — safe, no untrusted content ingestion)
  'send_gmail_message',
  'list_gmail_labels',
  // Calendar
  'list_calendar_events',
  'create_calendar_event',
  'update_calendar_event',
  // Tasks
  'list_task_lists',
  'list_tasks',
  'create_task',
  'complete_task',
  // Drive
  'search_drive_files',
  'get_drive_file_content',
  'list_drive_files',
  // Docs
  'get_doc_content',
  'create_doc',
  // Sheets
  'get_spreadsheet',
  'create_spreadsheet',
  'update_spreadsheet_values',
];
