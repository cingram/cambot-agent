import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

// Sentinel markers must match container-runner.ts
const OUTPUT_START_MARKER = '---CAMBOT_AGENT_OUTPUT_START---';
const OUTPUT_END_MARKER = '---CAMBOT_AGENT_OUTPUT_END---';

// Mock config
vi.mock('../config/config.js', () => ({
  CONTAINER_MAX_OUTPUT_SIZE: 10485760,
  DATA_DIR: '/tmp/cambot-agent-test-data',
  GROUPS_DIR: '/tmp/cambot-agent-test-groups',
  STORE_DIR: '/tmp/cambot-agent-test-store',
  IDLE_TIMEOUT: 1800000, // 30min
  HEARTBEAT_INTERVAL_MS: 5000,
  TIMEZONE: 'America/Los_Angeles',
  MEMORY_MODE: 'both',
  EMAIL_GUARDRAIL_ENABLED: false,
}));

// Mock agents module
vi.mock('../agents/agents.js', () => ({
  AgentOptions: {},
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock fs
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
      statSync: vi.fn(() => ({ isDirectory: () => false })),
      copyFileSync: vi.fn(),
    },
  };
});

// Mock mount-security
vi.mock('./mount-security.js', () => ({
  validateAdditionalMounts: vi.fn(() => []),
}));

// Mock runtime
vi.mock('./runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  killContainersForGroup: vi.fn(),
  readonlyMountArgs: vi.fn((host: string, container: string) => ['-v', `${host}:${container}:ro`]),
  stopContainer: vi.fn((name: string) => `docker stop ${name}`),
}));

// Mock group-folder
vi.mock('../groups/group-folder.js', () => ({
  resolveGroupFolderPath: vi.fn((folder: string) => `/tmp/cambot-agent-test-groups/${folder}`),
  resolveGroupIpcPath: vi.fn((folder: string) => `/tmp/cambot-agent-test-data/ipc/${folder}`),
}));

// Mock config/env
vi.mock('../config/env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

// Mock heartbeat monitor
const mockMonitor = {
  start: vi.fn(),
  stop: vi.fn(),
  acknowledgeActivity: vi.fn(),
};
vi.mock('./heartbeat-monitor.js', () => ({
  createHeartbeatMonitor: vi.fn(() => mockMonitor),
}));

// Create a controllable fake ChildProcess
function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

let fakeProc: ReturnType<typeof createFakeProcess>;

// Mock child_process.spawn
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn(() => fakeProc),
    exec: vi.fn((_cmd: string, _opts: unknown, cb?: (err: Error | null) => void) => {
      if (cb) cb(null);
      return new EventEmitter();
    }),
  };
});

import { runContainerAgent, ContainerOutput } from './runner.js';
import type { AgentOptions } from '../agents/agents.js';
import type { ExecutionContext } from '../types.js';

const testExecution: ExecutionContext = {
  name: 'Test Group',
  folder: 'test-group',
  isMain: false,
};

const testInput = {
  prompt: 'Hello',
  groupFolder: 'test-group',
  chatJid: 'test@g.us',
  isMain: false,
};

const testAgentOptions: AgentOptions = {
  containerImage: 'cambot-agent-claude:latest',
  secretKeys: ['ANTHROPIC_API_KEY'],
};

function emitOutputMarker(proc: ReturnType<typeof createFakeProcess>, output: ContainerOutput) {
  const json = JSON.stringify(output);
  proc.stdout.push(`${OUTPUT_START_MARKER}\n${json}\n${OUTPUT_END_MARKER}\n`);
}

describe('container-runner heartbeat and exit behavior', () => {
  // These tests don't need fake timers — they control the fake process directly.
  // Using real timers avoids microtask starvation from deeply chained promises.
  const tick = () => new Promise(resolve => setTimeout(resolve, 20));

  beforeEach(() => {
    fakeProc = createFakeProcess();
    vi.clearAllMocks();
  });

  it('starts and stops heartbeat monitor', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testExecution,
      testInput,
      () => {},
      onOutput,
      testAgentOptions,
    );

    expect(mockMonitor.start).toHaveBeenCalledTimes(1);

    fakeProc.emit('close', 0);
    await tick();

    await resultPromise;
    expect(mockMonitor.stop).toHaveBeenCalledTimes(1);
  });

  it('acknowledges activity on output markers', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testExecution,
      testInput,
      () => {},
      onOutput,
      testAgentOptions,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    await tick();
    expect(mockMonitor.acknowledgeActivity).toHaveBeenCalledTimes(1);

    fakeProc.emit('close', 0);
    await tick();

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
  });

  it('non-zero exit after output resolves as success (heartbeat shutdown)', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testExecution,
      testInput,
      () => {},
      onOutput,
      testAgentOptions,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Here is my response',
      newSessionId: 'session-123',
    });

    await tick();

    // Container killed by heartbeat escalation (code 137 = SIGKILL)
    fakeProc.emit('close', 137);
    await tick();

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-123');
  });

  it('non-zero exit without output resolves as error', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testExecution,
      testInput,
      () => {},
      onOutput,
      testAgentOptions,
    );

    // No output emitted — container killed by heartbeat
    fakeProc.emit('close', 137);
    await tick();

    const result = await resultPromise;
    expect(result.status).toBe('error');
    expect(result.error).toContain('exited with code 137');
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('normal exit after output resolves as success', async () => {
    const onOutput = vi.fn(async () => {});
    const resultPromise = runContainerAgent(
      testExecution,
      testInput,
      () => {},
      onOutput,
      testAgentOptions,
    );

    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'Done',
      newSessionId: 'session-456',
    });

    await tick();

    fakeProc.emit('close', 0);
    await tick();

    const result = await resultPromise;
    expect(result.status).toBe('success');
    expect(result.newSessionId).toBe('session-456');
  });
});
