import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  killContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  killContainersForGroup,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('returns stop command using CONTAINER_RUNTIME_BIN', () => {
    expect(stopContainer('cambot-agent-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} stop cambot-agent-test-123`,
    );
  });
});

describe('killContainer', () => {
  it('returns kill command using CONTAINER_RUNTIME_BIN', () => {
    expect(killContainer('cambot-agent-test-123')).toBe(
      `${CONTAINER_RUNTIME_BIN} kill cambot-agent-test-123`,
    );
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} info`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(logger.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('kills orphaned cambot-agent containers and verifies', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('cambot-agent-group1-111\ncambot-agent-group2-222\n');
    // kill calls succeed
    mockExecSync.mockReturnValueOnce('');
    mockExecSync.mockReturnValueOnce('');
    // verification ps returns empty (all killed)
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    // ps + 2 kill calls + verification ps = 4
    expect(mockExecSync).toHaveBeenCalledTimes(4);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} kill cambot-agent-group1-111`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} kill cambot-agent-group2-222`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['cambot-agent-group1-111', 'cambot-agent-group2-222'] },
      'Killed orphaned containers',
    );
  });

  it('warns when orphans survive cleanup', () => {
    mockExecSync.mockReturnValueOnce('cambot-agent-stubborn-111\n');
    // kill call succeeds (but container survives somehow)
    mockExecSync.mockReturnValueOnce('');
    // verification ps still shows it
    mockExecSync.mockReturnValueOnce('cambot-agent-stubborn-111\n');

    cleanupOrphans();

    expect(logger.warn).toHaveBeenCalledWith(
      { count: 1, names: ['cambot-agent-stubborn-111'] },
      'Some orphaned containers survived cleanup',
    );
  });

  it('strips quotes from container names (Windows quoting bug)', () => {
    // Windows cmd.exe passes single quotes literally in --format
    mockExecSync.mockReturnValueOnce("'cambot-agent-main-111'\n");
    mockExecSync.mockReturnValueOnce('');
    // verification ps returns empty
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    // Kill should use the cleaned name (no quotes)
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} kill cambot-agent-main-111`,
      { stdio: 'pipe', timeout: 10000 },
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues killing remaining containers when one kill fails', () => {
    mockExecSync.mockReturnValueOnce('cambot-agent-a-1\ncambot-agent-b-2\n');
    // First kill fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already dead');
    });
    // Second kill succeeds
    mockExecSync.mockReturnValueOnce('');
    // verification ps returns empty
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(4);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['cambot-agent-a-1', 'cambot-agent-b-2'] },
      'Killed orphaned containers',
    );
  });
});

// --- killContainersForGroup ---

describe('killContainersForGroup', () => {
  it('kills containers matching the group name', () => {
    mockExecSync.mockReturnValueOnce('cambot-agent-main-111\n');
    mockExecSync.mockReturnValueOnce('');

    killContainersForGroup('main');

    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      `${CONTAINER_RUNTIME_BIN} ps --filter name=cambot-agent-main- --format {{.Names}}`,
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} kill cambot-agent-main-111`,
      { stdio: 'pipe', timeout: 10000 },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { group: 'main', container: 'cambot-agent-main-111' },
      'Killed stale group container',
    );
  });

  it('does nothing when no containers match', () => {
    mockExecSync.mockReturnValueOnce('');

    killContainersForGroup('main');

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('sanitizes group folder name for filter', () => {
    mockExecSync.mockReturnValueOnce('');

    killContainersForGroup('group with spaces');

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter name=cambot-agent-group-with-spaces- --format {{.Names}}`,
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });
});
