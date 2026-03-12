/**
 * SocketDeps — dependency injection container for all cambot-socket handlers.
 *
 * Mirrors the deps that the file-based IPC watcher/task-handler needed,
 * restructured for the socket transport.
 */

import type { AgentOptions } from '../agents/agents.js';
import type { ContainerSpawner } from '../agents/persistent-agent-spawner.js';
import type { AvailableGroup } from '../container/snapshot-writers.js';
import type { AgentMessageRepository } from '../db/agent-message-repository.js';
import type { AgentRepository } from '../db/agent-repository.js';
import type { NotificationRepository } from '../db/notification-repository.js';
import type { RawContentRepository } from '../db/raw-content-repository.js';
import type { IntegrationManager } from '../integrations/types.js';
import type { ContentPipe } from '../pipes/content-pipe.js';
import type { MessageBus, RegisteredGroup, WorkerDefinition } from '../types.js';
import type { WorkflowBuilderService } from '../workflows/workflow-builder-service.js';
import type { WorkflowService } from '../workflows/workflow-service.js';
import type { CambotSocketServer } from './server.js';

export interface SocketDeps {
  /** Message bus for emitting events. */
  bus: MessageBus;

  /** Returns the current registered groups map. */
  registeredGroups: () => Record<string, RegisteredGroup>;

  /** Register or update a group entry. */
  registerGroup: (jid: string, group: RegisteredGroup) => void;

  /** Force sync group metadata from channels. */
  syncGroupMetadata: (force: boolean) => Promise<void>;

  /** Get available (discovered but not necessarily registered) groups. */
  getAvailableGroups: () => AvailableGroup[];

  /** Write the groups snapshot for a group's IPC directory. */
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;

  /** Workflow runtime engine (optional — may not be initialized). */
  workflowService?: WorkflowService;

  /** Workflow definition CRUD service (optional). */
  workflowBuilderService?: WorkflowBuilderService;

  /** Resolve container image + secret keys for a given agent ID. */
  resolveAgentImage: (agentId: string) => AgentOptions;

  /** Look up a worker/agent definition by ID. */
  getAgentDefinition: (id: string) => WorkerDefinition | undefined;

  /** Integration lifecycle manager (optional). */
  integrationManager?: IntegrationManager;

  /** Content pipe for email processing (optional). */
  contentPipe?: ContentPipe;

  /** Raw content store for email processing (optional). */
  rawContentStore?: RawContentRepository;

  /** Workspace MCP URL for email operations (optional). */
  workspaceMcpUrl?: string;

  /** Persistent agent spawner for inter-agent messaging (optional). */
  agentSpawner?: ContainerSpawner;

  /** Agent repository for looking up registered agents (optional). */
  agentRepo?: AgentRepository;

  /** Called after agent create/update/delete to refresh routing tables. */
  onAgentMutation?: () => void;

  /** Agent message repository for persisting inter-agent communication (optional). */
  agentMessageRepo?: AgentMessageRepository;

  /** Notification repository for admin inbox (optional). */
  notificationRepo?: NotificationRepository;

  /** Reference to the socket server for cross-group sends (optional — set after server creation). */
  socketServer?: CambotSocketServer;
}
