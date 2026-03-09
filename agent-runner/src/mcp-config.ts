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
  isInterAgentTarget?: boolean;
}

export interface ResolvedMcpConfig {
  servers: SdkMcpServers;
  allowedTools: string[];
}

export function loadMcpConfig(
  templatePath: string,
  vars: McpConfigVars,
  dynamicServers?: McpServerConfig[],
  hostMcpAllowlist?: string[],
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

  // Build allowedTools: host sends pre-qualified names, filter to present servers.
  // Fallback: grant wildcard access per server (matches SDK fallback of all tools).
  const allowedTools = hostMcpAllowlist
    ? filterToPresent(hostMcpAllowlist, Object.keys(servers))
    : Object.keys(servers).map(name => `mcp__${name}__*`);

  return { servers, allowedTools };
}

/**
 * Filter pre-qualified tool names (mcp__{server}__{tool}) to only include
 * tools whose server is actually present in this container's config.
 */
function filterToPresent(qualifiedNames: string[], serverNames: string[]): string[] {
  const serverSet = new Set(serverNames);
  return qualifiedNames.filter(name => {
    // Qualified format: mcp__{server}__{tool}
    const parts = name.split('__');
    return parts.length >= 3 && serverSet.has(parts[1]);
  });
}
