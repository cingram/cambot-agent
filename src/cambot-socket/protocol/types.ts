/**
 * Frame types and payload interfaces for the cambot-socket TCP transport.
 * Single source of truth for the wire protocol between host and container.
 *
 * This is the host-side copy. The agent-runner has its own copy at
 * agent-runner/src/cambot-socket/types.ts. Keep them in sync.
 */

// ── Core Frame ──────────────────────────────────────────────────────

export interface SocketFrame<T = unknown> {
  type: string;       // Command discriminator
  id: string;         // Unique frame ID (crypto.randomUUID)
  replyTo?: string;   // Correlation ID for request/response
  payload: T;         // Typed per command
}

// ── Heartbeat Phases ────────────────────────────────────────────────

export type HeartbeatPhase = 'starting' | 'idle' | 'processing' | 'shutting-down';

// ── Host -> Container Payloads ──────────────────────────────────────

export interface HandshakeAckPayload { ok: true }

export interface HandshakeRejectPayload { error: string }

export interface MessageInputPayload { text: string; chatJid: string }

export interface SessionClosePayload { reason: string }

export interface PingPayload { timestamp: number }

// ── Container -> Host Payloads ──────────────────────────────────────

export interface HandshakePayload { group: string; token: string }

export interface PongPayload { timestamp: number }

export interface HeartbeatPayload {
  phase: HeartbeatPhase;
  queryCount: number;
  uptimeMs: number;
}

export interface OutputPayload {
  status: string;
  result: string | null;
  newSessionId?: string;
  telemetry?: unknown;
}

export interface MessageOutboundPayload { chatJid: string; text: string }

// ── Task Payloads ───────────────────────────────────────────────────

export interface TaskSchedulePayload {
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  scheduleValue: string;
  targetJid: string;
  contextMode?: 'group' | 'isolated';
  agentId?: string;
}

export interface TaskPausePayload { taskId: string }

export interface TaskResumePayload { taskId: string }

export interface TaskCancelPayload { taskId: string }

// ── Group Payloads ──────────────────────────────────────────────────

export interface GroupRefreshPayload {}

export interface GroupRegisterPayload {
  jid: string;
  name: string;
  folder: string;
  trigger?: string;
  containerConfig?: unknown;
}

// ── Worker/Agent Payloads ───────────────────────────────────────────

export interface WorkerDelegatePayload {
  delegationId: string;
  workerId: string;
  prompt: string;
  context?: string;
}

export interface AgentSendPayload {
  requestId: string;
  targetAgent: string;
  prompt: string;
}

// ── Workflow Payloads ───────────────────────────────────────────────

export interface WorkflowRunPayload { workflowId: string; chatJid?: string }

export interface WorkflowPausePayload { runId: string }

export interface WorkflowCancelPayload { runId: string }

export interface WorkflowCreatePayload { requestId: string; workflow: unknown }

export interface WorkflowUpdatePayload {
  requestId: string;
  workflowId: string;
  workflow: unknown;
}

export interface WorkflowDeletePayload { requestId: string; workflowId: string }

export interface WorkflowValidatePayload { requestId: string; workflow: unknown }

export interface WorkflowClonePayload {
  requestId: string;
  sourceId: string;
  newId: string;
  newName?: string;
}

export interface WorkflowSchemaPayload { requestId: string }

// ── Integration Payloads ────────────────────────────────────────────

export interface IntegrationListPayload { chatJid: string }

export interface IntegrationEnablePayload { targetId: string }

export interface IntegrationDisablePayload { targetId: string }

export interface McpAddPayload {
  name: string;
  transport: string;
  url?: string;
  [key: string]: unknown;
}

export interface McpRemovePayload { targetId: string }

// ── Email Payloads ──────────────────────────────────────────────────

export interface EmailCheckPayload {
  requestId: string;
  query?: string;
  maxResults?: number;
}

export interface EmailReadPayload {
  requestId: string;
  messageId: string;
  includeRaw?: boolean;
}

// ── Notification Payloads ────────────────────────────────────────────

export interface NotificationSubmitPayload {
  category: string;
  priority?: 'critical' | 'high' | 'normal' | 'low' | 'info';
  summary: string;
  payload?: Record<string, unknown>;
}

export interface NotificationGetPayload {
  category?: string;
  priority?: 'critical' | 'high' | 'normal' | 'low' | 'info';
  limit?: number;
}

export interface NotificationAckPayload {
  ids: string[];
}

// ── Context Payloads ────────────────────────────────────────────────

export interface ContextSavePayload {
  content: string;
  filename?: string;
}

// ── Log Payloads ───────────────────────────────────────────────────

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogPayload {
  level: LogLevel;
  message: string;
}

// ── Error Payload ───────────────────────────────────────────────────

export interface ErrorPayload { error: string; details?: unknown }

// ── Auth Level ──────────────────────────────────────────────────────

/** Auth levels for command handlers. */
export type AuthLevel = 'any' | 'main-only' | 'self-or-main';

// ── Handshake Timeout ───────────────────────────────────────────────

/** Handshake timeout in milliseconds. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

// ── Frame Type Constants ────────────────────────────────────────────

export const FRAME_TYPES = {
  // Handshake
  HANDSHAKE: 'handshake',
  HANDSHAKE_ACK: 'handshake.ack',
  HANDSHAKE_REJECT: 'handshake.reject',
  // Messages
  MESSAGE_INPUT: 'message.input',
  MESSAGE_OUTBOUND: 'message.outbound',
  // Session
  SESSION_CLOSE: 'session.close',
  // Heartbeat
  PING: 'ping',
  PONG: 'pong',
  HEARTBEAT: 'heartbeat',
  // Output
  OUTPUT: 'output',
  // Tasks
  TASK_SCHEDULE: 'task.schedule',
  TASK_LIST: 'task.list',
  TASK_PAUSE: 'task.pause',
  TASK_RESUME: 'task.resume',
  TASK_CANCEL: 'task.cancel',
  TASK_SCHEDULED: 'task.scheduled',
  // Groups
  GROUP_REFRESH: 'group.refresh',
  GROUP_REGISTER: 'group.register',
  GROUP_UPDATE: 'group.update',
  // Workers
  WORKER_DELEGATE: 'worker.delegate',
  WORKER_RESULT: 'worker.result',
  // Agents
  AGENT_SEND: 'agent.send',
  AGENT_RESULT: 'agent.result',
  AGENT_CREATE: 'agent.create',
  AGENT_LIST: 'agent.list',
  AGENT_INVOKE: 'agent.invoke',
  AGENT_UPDATE: 'agent.update',
  AGENT_DELETE: 'agent.delete',
  // Workflows
  WORKFLOW_RUN: 'workflow.run',
  WORKFLOW_LIST: 'workflow.list',
  WORKFLOW_STATUS: 'workflow.status',
  WORKFLOW_PAUSE: 'workflow.pause',
  WORKFLOW_CANCEL: 'workflow.cancel',
  WORKFLOW_CREATE: 'workflow.create',
  WORKFLOW_UPDATE: 'workflow.update',
  WORKFLOW_DELETE: 'workflow.delete',
  WORKFLOW_VALIDATE: 'workflow.validate',
  WORKFLOW_CLONE: 'workflow.clone',
  WORKFLOW_SCHEMA: 'workflow.schema',
  WORKFLOW_RESULT: 'workflow.result',
  // Integrations
  INTEGRATION_LIST: 'integration.list',
  INTEGRATION_ENABLE: 'integration.enable',
  INTEGRATION_DISABLE: 'integration.disable',
  MCP_ADD: 'mcp.add',
  MCP_REMOVE: 'mcp.remove',
  // Email
  EMAIL_CHECK: 'email.check',
  EMAIL_READ: 'email.read',
  EMAIL_RESULT: 'email.result',
  // Bus
  BUS_MESSAGE: 'bus.message',
  // Notifications
  NOTIFICATION_SUBMIT: 'notification.submit',
  NOTIFICATION_GET: 'notification.get',
  NOTIFICATION_ACK: 'notification.ack',
  NOTIFICATION_RESULT: 'notification.result',
  // Context
  CONTEXT_SAVE: 'context.save',
  // Log
  LOG: 'log',
  // Error
  ERROR: 'error',
} as const;

export type FrameType = typeof FRAME_TYPES[keyof typeof FRAME_TYPES];

/** Alias for FRAME_TYPES used by handler modules. */
export const FrameTypes = FRAME_TYPES;
