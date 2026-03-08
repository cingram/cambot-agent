/**
 * Shared types for the CamBot container protocol.
 * Single source of truth — imported by agent-runner, custom-agent-runner,
 * and (via re-export) the host-side container-runner.
 */

// ── Protocol Constants ──────────────────────────────────────────────

export const OUTPUT_START_MARKER = '---CAMBOT_AGENT_OUTPUT_START---';
export const OUTPUT_END_MARKER = '---CAMBOT_AGENT_OUTPUT_END---';

// ── MCP Server Config ───────────────────────────────────────────────

export interface McpServerConfig {
  name: string;
  transport: 'http' | 'sse';
  url: string;
}

// ── Custom Agent Config ─────────────────────────────────────────────

export interface CustomAgentConfig {
  agentId: string;
  provider: 'openai' | 'xai' | 'anthropic' | 'google';
  model: string;
  baseUrl?: string;
  apiKeyEnvVar: string;
  systemPrompt: string;
  tools: string[];
  maxTokens?: number;
  temperature?: number;
  maxIterations?: number;
  timeoutMs?: number;
}

// ── Container Input (discriminated union) ───────────────────────────

interface BaseContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  /** When true, agent was spawned via send_to_agent — restricted MCP tools */
  isInterAgentTarget?: boolean;
  secrets?: Record<string, string>;
  ipcToken?: string;
}

export interface ClaudeContainerInput extends BaseContainerInput {
  kind: 'claude';
  mcpServers?: McpServerConfig[];
  memoryMode?: 'markdown' | 'database' | 'both';
  /** Enable inline Haiku guardrail for tool call review. Default: true */
  guardrailEnabled?: boolean;
  /** SDK tools this agent is allowed to use (resolved from ToolPolicy on host) */
  allowedSdkTools?: string[];
  /** MCP tools this agent is allowed to use (resolved from ToolPolicy on host) */
  allowedMcpTools?: string[];
  customAgent?: undefined;
}

export interface CustomAgentContainerInput extends BaseContainerInput {
  kind: 'custom';
  customAgent: CustomAgentConfig;
  mcpServers?: undefined;
  memoryMode?: undefined;
}

export type ContainerInput = ClaudeContainerInput | CustomAgentContainerInput;

/**
 * Parse raw JSON into a typed ContainerInput.
 * Backward-compatible: infers `kind` from presence of `customAgent`
 * since the host doesn't send the `kind` field yet.
 */
export function parseContainerInput(raw: Record<string, unknown>): ContainerInput {
  if (raw.customAgent) {
    return { ...raw, kind: 'custom' } as CustomAgentContainerInput;
  }
  return { ...raw, kind: 'claude' } as ClaudeContainerInput;
}

// ── Container Output ────────────────────────────────────────────────

export interface ToolInvocationRecord {
  toolName: string;
  durationMs?: number;
  status: 'success' | 'error';
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
}

export interface ContainerTelemetry {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  usage: { inputTokens: number; outputTokens: number };
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
  toolInvocations: ToolInvocationRecord[];
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  telemetry?: ContainerTelemetry;
}

// ── Transcript Types ────────────────────────────────────────────────

export interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

export interface SessionsIndex {
  entries: SessionEntry[];
}

// ── Container Paths ─────────────────────────────────────────────────

export interface ContainerPaths {
  ipcInputDir: string;
  ipcCloseSentinel: string;
  ipcOwnerFile: string;
  heartbeatFile: string;
  groupDir: string;
  extraMountsDir: string;
  contextDir: string;
  contextDumpFile: string;
  conversationsDir: string;
  tempInputFile: string;
  mcpConfigPath: string;
}

export function createDefaultContainerPaths(): ContainerPaths {
  const ipcInputDir = '/workspace/ipc/input';
  return {
    ipcInputDir,
    ipcCloseSentinel: `${ipcInputDir}/_close`,
    ipcOwnerFile: '/workspace/ipc/_owner',
    heartbeatFile: '/workspace/ipc/_heartbeat',
    groupDir: '/workspace/group',
    extraMountsDir: '/workspace/extra',
    contextDir: '/workspace/ipc/context',
    contextDumpFile: '/workspace/ipc/context-dump.md',
    conversationsDir: '/workspace/group/conversations',
    tempInputFile: '/tmp/input.json',
    mcpConfigPath: '/home/node/.claude/mcp-servers.json',
  };
}

// ── IPC Constants ───────────────────────────────────────────────────

export const IPC_POLL_MS = 500;
export const IPC_WAIT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes (heartbeat-based close fires first)

// ── Internal Telemetry Tracking ─────────────────────────────────────

export interface ToolInvocationEntry {
  toolName: string;
  startTime: number;
  durationMs?: number;
  status: 'success' | 'error';
  inputSummary?: string;
  outputSummary?: string;
  error?: string;
}
