import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ContainerOutput } from '../container/runner.js';
import type { RegisteredGroup } from '../types.js';
import type { RouterState } from './router-state.js';
import type { GroupQueue } from '../groups/group-queue.js';
import type { WorkflowService } from '../workflows/workflow-service.js';
import type { WorkflowBuilderService } from '../workflows/workflow-builder-service.js';
import type { IntegrationManager } from '../integrations/index.js';
import { AgentRunner } from './agent-runner.js';

// Mock all heavy dependencies
vi.mock('../config/config.js', () => ({
  DATA_DIR: '/tmp/cambot-test',
  GROUPS_DIR: '/tmp/cambot-test-groups',
  MAIN_GROUP_FOLDER: 'main',
  CONVERSATION_ROTATION_ENABLED: false,
  CONVERSATION_IDLE_TIMEOUT_MS: 14_400_000,
  CONVERSATION_MAX_SIZE_KB: 500,
}));

vi.mock('../agents/agents.js', () => ({
  getLeadAgentId: vi.fn(() => 'lead'),
  resolveAgentImage: vi.fn(() => ({
    containerImage: 'test:latest',
    secretKeys: [],
  })),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      readFileSync: vi.fn(() => ''),
      readdirSync: vi.fn(() => []),
      statSync: vi.fn(() => ({ size: 1024 })),
    },
  };
});

vi.mock('../container/snapshot-writers.js', () => ({
  writeCustomAgentsSnapshot: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeArchivedTasksSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
  writeWorkflowsSnapshot: vi.fn(),
  writeWorkflowSchemaSnapshot: vi.fn(),
  writeWorkersSnapshot: vi.fn(),
  writePersistentAgentsSnapshot: vi.fn(),
}));

vi.mock('../db/index.js', () => ({
  getAllAgentDefinitions: vi.fn(() => []),
  getAllChats: vi.fn(() => []),
  getAllTasks: vi.fn(() => []),
  getArchivedTasks: vi.fn(() => []),
  getDatabase: vi.fn(() => ({})),
}));

vi.mock('../db/agent-repository.js', () => ({
  createAgentRepository: vi.fn(() => ({
    getByFolder: vi.fn(() => undefined),
    getAll: vi.fn(() => []),
  })),
}));

vi.mock('../db/agent-template-repository.js', () => ({
  createAgentTemplateRepository: vi.fn(() => ({
    get: vi.fn(() => undefined),
  })),
}));

vi.mock('../groups/group-folder.js', () => ({
  resolveGroupIpcPath: vi.fn(() => '/tmp/ipc'),
}));

vi.mock('../utils/context-files.js', () => ({
  buildAgentContext: vi.fn(() => ({})),
}));

// Mock conversation repository
const mockConversations = new Map<string, { id: string; sessionId: string | null; agentFolder: string }>();
let convCounter = 0;
const mockResolveActiveConversation = vi.fn(
  (folder: string, _channel: string, _chatJid?: string) => {
    const existing = [...mockConversations.values()].find(c => c.agentFolder === folder);
    if (existing) return existing;
    const id = `conv-${++convCounter}`;
    const conv = { id, sessionId: null, agentFolder: folder, isActive: true };
    mockConversations.set(id, conv);
    return conv;
  },
);
const mockSetConversationSession = vi.fn((convId: string, sessionId: string) => {
  const conv = mockConversations.get(convId);
  if (conv) conv.sessionId = sessionId;
});
const mockUpdatePreview = vi.fn();

vi.mock('../db/conversation-repository.js', () => ({
  resolveActiveConversation: (...args: unknown[]) => mockResolveActiveConversation(...(args as Parameters<typeof mockResolveActiveConversation>)),
  setConversationSession: (...args: unknown[]) => mockSetConversationSession(...(args as Parameters<typeof mockSetConversationSession>)),
  updatePreview: (...args: unknown[]) => mockUpdatePreview(...(args as Parameters<typeof mockUpdatePreview>)),
}));

// Capture runContainerAgent calls
const mockRunContainerAgent = vi.fn<(...args: unknown[]) => Promise<ContainerOutput>>();
vi.mock('../container/runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
}));

function createMockState(): RouterState {
  return {
    getAvailableGroups: vi.fn(() => []),
    getRegisteredGroups: vi.fn(() => ({})),
  } as unknown as RouterState;
}

function createMockQueue(): GroupQueue {
  return {
    registerProcess: vi.fn(),
  } as unknown as GroupQueue;
}

const webGroup: RegisteredGroup = {
  name: 'Web',
  folder: 'main',
  trigger: '@cambot',
  added_at: '2026-01-01T00:00:00Z',
};

describe('AgentRunner conversation management', () => {
  let runner: AgentRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConversations.clear();
    convCounter = 0;
    runner = new AgentRunner({
      state: createMockState(),
      queue: createMockQueue(),
      getWorkflowService: () => null as unknown as WorkflowService,
      getWorkflowBuilderService: () => null as unknown as WorkflowBuilderService,
      getIntegrationManager: () => null as unknown as IntegrationManager,
    });
    mockRunContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'ok',
      newSessionId: undefined,
    });
  });

  it('resolves active conversation for the group folder', async () => {
    await runner.run(webGroup, 'hello', 'web:ui:conv1');
    expect(mockResolveActiveConversation).toHaveBeenCalledWith('main', 'web', 'web:ui:conv1');
  });

  it('persists session via conversation repository', async () => {
    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-new',
    });

    await runner.run(webGroup, 'hello', 'web:ui:conv1');

    expect(mockSetConversationSession).toHaveBeenCalledWith('conv-1', 'session-new');
  });

  it('does not set session when container returns no new session', async () => {
    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: undefined,
    });

    await runner.run(webGroup, 'hello', 'web:ui:conv1');

    expect(mockSetConversationSession).not.toHaveBeenCalled();
  });

  it('non-web channels use group folder for conversation', async () => {
    const whatsappGroup: RegisteredGroup = {
      name: 'Friends',
      folder: 'friends-group',
      trigger: '@cambot',
      added_at: '2026-01-01T00:00:00Z',
    };

    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-wa',
    });

    await runner.run(whatsappGroup, 'hey', '12345@g.us');

    expect(mockResolveActiveConversation).toHaveBeenCalledWith('friends-group', 'whatsapp', '12345@g.us');
  });
});
