import type { MessageBus } from './message-bus.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EventTypeEntry {
  type: string;
  description: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const EVENT_TYPES: readonly EventTypeEntry[] = [
  // Message
  { type: 'message.inbound', description: 'User sent a message' },
  { type: 'message.outbound', description: 'Bot sending a message' },
  { type: 'message.delivered', description: 'Message confirmed delivered to platform' },
  { type: 'chat.metadata', description: 'Chat metadata update' },
  { type: 'typing.update', description: 'Typing indicator change' },

  // Agent
  { type: 'agent.telemetry', description: 'Agent execution metrics' },
  { type: 'agent.error', description: 'Agent execution error' },
  { type: 'agent.spawned', description: 'Agent container spawned' },
  { type: 'agent.completed', description: 'Agent execution completed' },

  // Memory
  { type: 'memory.session_summarized', description: 'Session summarized for long-term memory' },
  { type: 'memory.short_term_promoted', description: 'Short-term notes promoted to long-term memory' },
  { type: 'memory.fact_contradicted', description: 'New fact superseded a contradicting fact' },
  { type: 'memory.reflections_generated', description: 'Reflection meta-insights synthesized' },

  // Telemetry
  { type: 'telemetry.api_call', description: 'Outbound API call recorded' },
  { type: 'telemetry.tool_invocation', description: 'Tool invocation recorded' },
  { type: 'telemetry.error', description: 'Error detected' },

  // Security
  { type: 'security.anomaly', description: 'Security anomaly detected' },
  { type: 'security.injection_detected', description: 'Prompt injection pattern detected' },
  { type: 'security.tool_blocked', description: 'Tool call blocked by circuit breaker' },
  { type: 'security.alert_escalated', description: 'Critical security event escalated' },

  // System
  { type: 'system.startup', description: 'System started' },
  { type: 'system.shutdown', description: 'System shutting down' },
  { type: 'bus.backpressure', description: 'Bus backpressure threshold exceeded' },
  { type: 'bus.dead_letter', description: 'Event moved to dead letter queue' },

  // Task
  { type: 'task.prompt', description: 'Scheduled task prompt ready for execution' },

  // Workflow
  { type: 'workflow.trigger', description: 'Request to trigger a workflow run' },
  { type: 'workflow.agent.request', description: 'Workflow step requesting agent execution' },
  { type: 'workflow.agent.response', description: 'Agent execution result for a workflow step' },
  { type: 'workflow.started', description: 'Workflow run started' },
  { type: 'workflow.completed', description: 'Workflow run completed' },
  { type: 'workflow.failed', description: 'Workflow run failed' },
] as const;

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export function registerAllEventTypes(bus: MessageBus): void {
  for (const entry of EVENT_TYPES) {
    bus.registerEventType(entry.type, entry.description);
  }
}
