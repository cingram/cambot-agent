import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMessageBus } from '../bus/message-bus.js';
import type { MessageBus } from '../bus/message-bus.js';
import { InboundMessage } from '../bus/events/inbound-message.js';
import { TypingUpdate } from '../bus/events/typing-update.js';
import { registerMessageRouter, type MessageRouterDeps } from './message-router.js';
import type { RouterState } from './router-state.js';
import type { GroupQueue } from '../groups/group-queue.js';
import type { Channel } from '../types.js';
import type { CambotSocketServer } from '../cambot-socket/server.js';

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
  MAIN_GROUP_FOLDER: 'main',
  TRIGGER_PATTERN: /@Andy/i,
}));

vi.mock('../db/index.js', () => ({
  getMessagesSince: vi.fn(() => []),
}));

vi.mock('../utils/router.js', () => ({
  formatMessages: vi.fn((msgs: unknown[]) => `formatted:${msgs.length}`),
}));

import { getMessagesSince } from '../db/index.js';
import { formatMessages } from '../utils/router.js';

function makeMessage(content: string, timestamp = new Date().toISOString()) {
  return {
    id: `msg-${Date.now()}`,
    chat_jid: 'group@g.us',
    sender: 'user@s.whatsapp.net',
    sender_name: 'User',
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  };
}

function createMockState(overrides: Partial<RouterState> = {}): RouterState {
  return {
    getRegisteredGroup: vi.fn(() => ({ name: 'Test', folder: 'main', requiresTrigger: false })),
    getRegisteredGroups: vi.fn(() => ({})),
    getAgentTimestamp: vi.fn(() => ''),
    setAgentTimestamp: vi.fn(),
    save: vi.fn(),
    ...overrides,
  } as unknown as RouterState;
}

function createMockQueue(overrides: Partial<GroupQueue> = {}): GroupQueue {
  return {
    enqueueMessageCheck: vi.fn(),
    getLastPipedTimestamp: vi.fn(() => null),
    recordPipedTimestamp: vi.fn(),
    ...overrides,
  } as unknown as GroupQueue;
}

function createMockChannel(jid: string): Channel {
  return {
    name: 'test',
    ownsJid: vi.fn((j: string) => j === jid),
    isConnected: vi.fn(() => true),
    sendMessage: vi.fn(),
  } as unknown as Channel;
}

function createMockSocketServer(hasConnection = false): CambotSocketServer {
  return {
    hasConnection: vi.fn(() => hasConnection),
    send: vi.fn(),
  } as unknown as CambotSocketServer;
}

describe('registerMessageRouter', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = createMessageBus();
    vi.clearAllMocks();
  });

  it('routes registered group with trigger to socket when connected', async () => {
    const queue = createMockQueue();
    const state = createMockState({
      getRegisteredGroup: vi.fn(() => ({ name: 'Side', folder: 'side', requiresTrigger: true })),
    } as unknown as Partial<RouterState>);
    const socketServer = createMockSocketServer(true);
    const msg = makeMessage('Hey @Andy help me');
    vi.mocked(getMessagesSince).mockReturnValue([msg]);

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
      socketServer,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', msg));

    expect(socketServer.send).toHaveBeenCalledWith('side', expect.objectContaining({
      type: 'message.input',
    }));
  });

  it('falls back to enqueue when no socket connection', async () => {
    const queue = createMockQueue();
    const state = createMockState({
      getRegisteredGroup: vi.fn(() => ({ name: 'Side', folder: 'side', requiresTrigger: true })),
    } as unknown as Partial<RouterState>);
    const socketServer = createMockSocketServer(false);

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
      socketServer,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', makeMessage('Hey @Andy help me')));

    expect(queue.enqueueMessageCheck).toHaveBeenCalledWith('group@g.us');
  });

  it('ignores unregistered JID', async () => {
    const queue = createMockQueue();
    const state = createMockState({
      getRegisteredGroup: vi.fn(() => undefined),
    } as unknown as Partial<RouterState>);

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    await bus.emit(new InboundMessage('whatsapp', 'unknown@g.us', makeMessage('hello')));

    expect(queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('ignores non-main group without trigger', async () => {
    const queue = createMockQueue();
    const state = createMockState({
      getRegisteredGroup: vi.fn(() => ({ name: 'Side', folder: 'side', requiresTrigger: true })),
    } as unknown as Partial<RouterState>);

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', makeMessage('hello no trigger')));

    expect(queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('does not route cancelled events', async () => {
    const queue = createMockQueue();
    const state = createMockState();

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    // Register a higher-priority handler that cancels
    bus.on(InboundMessage, (event) => {
      event.cancelled = true;
    }, { priority: 1, sequential: true });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', makeMessage('hello')));

    expect(queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('advances cursor after successful socket pipe', async () => {
    const queue = createMockQueue();
    const state = createMockState();
    const socketServer = createMockSocketServer(true);
    const msg = makeMessage('hello', '2024-01-01T00:00:05.000Z');

    vi.mocked(getMessagesSince).mockReturnValue([msg]);

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
      socketServer,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', msg));

    expect(state.setAgentTimestamp).toHaveBeenCalledWith('group@g.us', '2024-01-01T00:00:05.000Z');
    expect(state.save).toHaveBeenCalled();
  });

  it('returns an unsubscribe function', async () => {
    const queue = createMockQueue();
    const state = createMockState();

    const unsub = registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    unsub();

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', makeMessage('hello')));

    expect(queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('skips JID not owned by any channel', async () => {
    const queue = createMockQueue();
    const state = createMockState();

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('other@g.us')], // different JID
      getInterceptor: () => null,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', makeMessage('hello')));

    expect(queue.enqueueMessageCheck).not.toHaveBeenCalled();
  });
});
