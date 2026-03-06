import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recoverPendingMessages } from './message-recovery.js';
import type { RouterState } from './router-state.js';
import type { GroupQueue } from '../groups/group-queue.js';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../config/config.js', () => ({
  ASSISTANT_NAME: 'Andy',
}));

vi.mock('../db/index.js', () => ({
  getMessagesSince: vi.fn(() => []),
}));

import { getMessagesSince } from '../db/index.js';

function createMockState(groups: Record<string, { name: string }> = {}): RouterState {
  return {
    getRegisteredGroups: vi.fn(() => groups),
    getAgentTimestamp: vi.fn(() => ''),
  } as unknown as RouterState;
}

function createMockQueue(): GroupQueue {
  return {
    enqueueMessageCheck: vi.fn(),
  } as unknown as GroupQueue;
}

describe('recoverPendingMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues groups with pending messages', () => {
    const state = createMockState({
      'group1@g.us': { name: 'Group 1' },
      'group2@g.us': { name: 'Group 2' },
    });
    const queue = createMockQueue();

    vi.mocked(getMessagesSince)
      .mockReturnValueOnce([{ id: 'msg1', content: 'hello' }] as any)
      .mockReturnValueOnce([]);

    recoverPendingMessages(state, queue);

    expect(queue.enqueueMessageCheck).toHaveBeenCalledOnce();
    expect(queue.enqueueMessageCheck).toHaveBeenCalledWith('group1@g.us');
  });

  it('skips groups with no pending messages', () => {
    const state = createMockState({
      'group1@g.us': { name: 'Group 1' },
    });
    const queue = createMockQueue();

    vi.mocked(getMessagesSince).mockReturnValue([]);

    recoverPendingMessages(state, queue);

    expect(queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('handles empty registered groups', () => {
    const state = createMockState({});
    const queue = createMockQueue();

    recoverPendingMessages(state, queue);

    expect(queue.enqueueMessageCheck).not.toHaveBeenCalled();
    expect(getMessagesSince).not.toHaveBeenCalled();
  });
});
