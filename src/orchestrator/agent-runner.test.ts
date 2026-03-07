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
  writeContextFiles: vi.fn(),
}));

// Capture runContainerAgent calls
const mockRunContainerAgent = vi.fn<(...args: unknown[]) => Promise<ContainerOutput>>();
vi.mock('../container/runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
}));

function createMockState(): RouterState {
  const sessions: Record<string, string> = {};
  return {
    getSession: vi.fn((key: string) => sessions[key]),
    setSession: vi.fn((key: string, id: string) => { sessions[key] = id; }),
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

describe('AgentRunner session keying', () => {
  let state: RouterState;
  let runner: AgentRunner;

  beforeEach(() => {
    vi.clearAllMocks();
    state = createMockState();
    runner = new AgentRunner({
      state,
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

  it('uses chatJid as session key, not group.folder', async () => {
    await runner.run(webGroup, 'hello', 'web:ui:conv1');

    expect(state.getSession).toHaveBeenCalledWith('web:ui:conv1');
    expect(state.getSession).not.toHaveBeenCalledWith('main');
  });

  it('different chatJids get different sessions', async () => {
    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-aaa',
    });
    await runner.run(webGroup, 'hello', 'web:ui:conv1');

    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-bbb',
    });
    await runner.run(webGroup, 'hello', 'web:ui:conv2');

    expect(state.setSession).toHaveBeenCalledWith('web:ui:conv1', 'session-aaa');
    expect(state.setSession).toHaveBeenCalledWith('web:ui:conv2', 'session-bbb');
  });

  it('same chatJid resumes the same session', async () => {
    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-aaa',
    });
    await runner.run(webGroup, 'hello', 'web:ui:conv1');

    // Second call should look up session for same JID
    await runner.run(webGroup, 'follow up', 'web:ui:conv1');

    const getCalls = (state.getSession as ReturnType<typeof vi.fn>).mock.calls;
    expect(getCalls).toEqual([['web:ui:conv1'], ['web:ui:conv1']]);
  });

  it('persists session under chatJid after container run', async () => {
    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: 'session-new',
    });

    await runner.run(webGroup, 'hello', 'web:ui:conv1');

    expect(state.setSession).toHaveBeenCalledWith('web:ui:conv1', 'session-new');
    expect(state.setSession).not.toHaveBeenCalledWith('main', expect.any(String));
  });

  it('does not set session when container returns no new session', async () => {
    mockRunContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: 'ok',
      newSessionId: undefined,
    });

    await runner.run(webGroup, 'hello', 'web:ui:conv1');

    expect(state.setSession).not.toHaveBeenCalled();
  });

  it('non-web channels are unaffected (JID already unique)', async () => {
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

    expect(state.getSession).toHaveBeenCalledWith('12345@g.us');
    expect(state.setSession).toHaveBeenCalledWith('12345@g.us', 'session-wa');
  });
});
