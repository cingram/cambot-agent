/**
 * Barrel export for the cambot-socket shared protocol module.
 */

// Frame types and payload interfaces
export type {
  SocketFrame,
  HeartbeatPhase,
  HandshakeAckPayload,
  HandshakeRejectPayload,
  MessageInputPayload,
  SessionClosePayload,
  PingPayload,
  HandshakePayload,
  PongPayload,
  HeartbeatPayload,
  OutputPayload,
  MessageOutboundPayload,
  TaskSchedulePayload,
  TaskPausePayload,
  TaskResumePayload,
  TaskCancelPayload,
  GroupRefreshPayload,
  GroupRegisterPayload,
  WorkerDelegatePayload,
  AgentSendPayload,
  WorkflowRunPayload,
  WorkflowPausePayload,
  WorkflowCancelPayload,
  WorkflowCreatePayload,
  WorkflowUpdatePayload,
  WorkflowDeletePayload,
  WorkflowValidatePayload,
  WorkflowClonePayload,
  WorkflowSchemaPayload,
  IntegrationListPayload,
  IntegrationEnablePayload,
  IntegrationDisablePayload,
  McpAddPayload,
  McpRemovePayload,
  EmailCheckPayload,
  EmailReadPayload,
  ErrorPayload,
  FrameType,
} from './types.js';

export { FRAME_TYPES } from './types.js';

// Codec (encoder/decoder)
export { encodeFrame, FrameDecoder, FrameSizeError, MAX_FRAME_SIZE } from './codec.js';
