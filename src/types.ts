export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/cambot-agent/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

import type { ToolPolicy } from './tools/tool-policy.js';

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
  toolPolicy?: ToolPolicy;
}

/**
 * The minimal execution environment needed to spawn a container agent.
 * Decouples container spawning from conversation routing — agents,
 * workflows, and shadow-admin can provide their own without faking
 * a RegisteredGroup.
 */
export interface ExecutionContext {
  name: string;                // human-readable name for logging
  folder: string;              // workspace folder name
  isMain: boolean;             // elevated mounts & permissions?
  containerConfig?: ContainerConfig;
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
}

/** Extract the execution context a container needs from a RegisteredGroup. */
export function toExecutionContext(group: RegisteredGroup, isMain: boolean): ExecutionContext {
  return {
    name: group.name,
    folder: group.folder,
    isMain,
    containerConfig: group.containerConfig,
  };
}

export interface WorkerDefinition {
  id: string;
  provider: string;
  model: string;
  personality?: string;
  secretKeys: string[];
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Event Bus (re-exported from src/bus/) ---

import { MessageBus as _MessageBus } from './bus/index.js';
export { BusEvent, MessageBus } from './bus/index.js';
export type { EventClass, HandlerOptions } from './bus/index.js';
export {
  InboundMessage,
  OutboundMessage,
  ChatMetadata,
  TypingUpdate,
  AgentTelemetry,
  AgentError,
} from './bus/index.js';

// Alias for local use in interfaces below
type MessageBus = _MessageBus;

// --- Channel abstraction ---

export interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncMetadata?(force?: boolean): Promise<void>;
}

export interface ChannelAuditEvent {
  type: string;
  channel: string;
  data: Record<string, unknown>;
}

export interface ChannelOpts {
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  messageBus: MessageBus;
  workflowService?: {
    reloadDefinitions(): void;
    hasActiveRun(workflowId: string): boolean;
    runWorkflow(workflowId: string): Promise<string>;
    cancelRun(runId: string): void;
  };
  /** Returns the names of all loaded channels. Used by the web channel to expose GET /channels. */
  channelNames?: () => string[];
  /** Fire-and-forget audit event callback for request lifecycle logging. */
  onAuditEvent?: (event: ChannelAuditEvent) => void;
}

export interface RegisteredAgent {
  id: string;
  name: string;
  description: string;
  folder: string;
  channels: string[];       // JSON parsed
  mcpServers: string[];     // JSON parsed
  capabilities: string[];   // JSON parsed
  concurrency: number;
  timeoutMs: number;
  isMain: boolean;
  toolPolicy?: ToolPolicy;
  systemPrompt: string | null;
  soul: string | null;
  provider: string;
  model: string;
  secretKeys: string[];
  tools: string[];
  temperature: number | null;
  maxTokens: number | null;
  baseUrl: string | null;
  containerConfig?: ContainerConfig;
  createdAt: string;
  updatedAt: string;
}

