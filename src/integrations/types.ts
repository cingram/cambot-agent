/**
 * Internal integration types for cambot-agent's runtime lifecycle manager.
 *
 * These extend the shared cambot-integrations contracts with runtime details
 * like process handles, channels, and context dependencies.
 */

import type { IntegrationBackend, IntegrationInfo, McpServerConfig } from 'cambot-integrations';
import type { Channel, ChannelOpts, MessageBus } from '../types.js';
import type { WorkspaceMcpService } from '../workspace-mcp-service.js';

export type IntegrationType = 'channel' | 'mcp-server' | 'skill';

export interface IntegrationRequirement {
  name: string;
  check: () => boolean;
}

export interface IntegrationDefinition {
  id: string;
  name: string;
  type: IntegrationType;
  description: string;
  requirements: IntegrationRequirement[];
  isConfigured: () => boolean;
  start: (ctx: IntegrationContext) => Promise<IntegrationHandle>;
  healthCheck?: () => Promise<boolean>;
  builtIn: boolean;
}

export interface IntegrationHandle {
  stop: () => Promise<void>;
  channel?: Channel;
  mcpService?: WorkspaceMcpService;
}

export interface IntegrationContext {
  messageBus: MessageBus;
  channelOpts: ChannelOpts;
}

export interface IntegrationState {
  id: string;
  enabled: boolean;
  status: 'unconfigured' | 'disabled' | 'configured' | 'starting' | 'active' | 'error' | 'stopping';
  lastError: string | null;
  lastHealthCheck: string | null;
  updatedAt: string;
}

export interface McpServerEntry {
  name: string;
  transport: 'http' | 'sse';
  url: string;
}

export interface IntegrationManager extends IntegrationBackend {
  initialize(ctx: IntegrationContext): Promise<void>;
  getActiveChannels(): Channel[];
  getActiveMcpServers(): McpServerEntry[];
  shutdown(): Promise<void>;
}
