/**
 * Shared types for the CamBot container protocol.
 * Single source of truth — imported by agent-runner, custom-agent-runner,
 * and (via re-export) the host-side container-runner.
 */

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
  /** Port of the CambotSocketServer on the host. */
  socketPort: number;
  /** One-time token for TCP handshake authentication. */
  socketToken: string;
  /** Separate one-time token for the MCP stdio subprocess's TCP connection. */
  mcpSocketToken?: string;
  /** Group identifier for the MCP stdio subprocess's TCP connection. */
  mcpSocketGroup?: string;
}

/** In-process SDK subagent definition (passed from host, fed to SDK query options). */
export interface SubagentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  mcpServers?: string[];
  skills?: string[];
  model?: 'sonnet' | 'opus' | 'haiku';
  maxTurns?: number;
}

export interface ClaudeContainerInput extends BaseContainerInput {
  kind: 'claude';
  /** Claude model to use (e.g. 'claude-opus-4-6'). Falls back to SDK default. */
  model?: string;
  mcpServers?: McpServerConfig[];
  memoryMode?: 'markdown' | 'database' | 'both';
  /** Per-agent memory strategy (mode only; host handles rotation/cleanup). */
  memoryStrategy?: { mode: 'ephemeral' | 'conversation-scoped' | 'persistent' | 'long-lived' };
  /** Active conversation ID (omitted for ephemeral). */
  conversationId?: string;
  /** Enable inline Haiku guardrail for tool call review. Default: true */
  guardrailEnabled?: boolean;
  /** SDK tools this agent is allowed to use (resolved from ToolPolicy on host) */
  allowedSdkTools?: string[];
  /** SDK tools hard-blocked via the SDK's disallowedTools parameter */
  disallowedSdkTools?: string[];
  /** MCP tools this agent is allowed to use (resolved from ToolPolicy on host) */
  allowedMcpTools?: string[];
  /** Pre-assembled context string from host (identity + soul + tools + agents + heartbeat + channels).
   *  Container wraps this in <cambot-context> and adds memory instructions. */
  assembledContext?: string;
  /** In-process SDK subagents this agent can spawn. Keys are subagent names. */
  subagents?: Record<string, SubagentDefinition>;
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
  groupDir: string;
  extraMountsDir: string;
  contextDumpFile: string;
  conversationsDir: string;
  tempInputFile: string;
  mcpConfigPath: string;
}

export function createDefaultContainerPaths(): ContainerPaths {
  return {
    groupDir: '/workspace/group',
    extraMountsDir: '/workspace/extra',
    contextDumpFile: '/workspace/context-dump.md',
    conversationsDir: '/workspace/group/conversations',
    tempInputFile: '/tmp/input.json',
    mcpConfigPath: '/home/node/.claude/mcp-servers.json',
  };
}

// ── Heartbeat Handle ────────────────────────────────────────────────

/** Heartbeat-compatible interface (matches CambotSocketClient). */
export interface HeartbeatHandle {
  setPhase(phase: string): void;
  incrementQueryCount(): void;
}

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
