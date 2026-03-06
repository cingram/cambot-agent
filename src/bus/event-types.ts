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
] as const;

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export function registerAllEventTypes(bus: MessageBus): void {
  for (const entry of EVENT_TYPES) {
    bus.registerEventType(entry.type, entry.description);
  }
}
