import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createMessageBus } from '../bus/message-bus.js';
import type { MessageBus } from '../bus/message-bus.js';
import { InboundMessage } from '../bus/events/inbound-message.js';
import { TypingUpdate } from '../bus/events/typing-update.js';
import { registerMessageRouter, type MessageRouterDeps } from './message-router.js';
import type { RouterState } from './router-state.js';
import type { GroupQueue } from '../groups/group-queue.js';
import type { Channel } from '../types.js';

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
    sendMessage: vi.fn(() => false),
    enqueueMessageCheck: vi.fn(),
    getLastPipedTimestamp: vi.fn(() => null),
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

describe('registerMessageRouter', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = createMessageBus();
    vi.clearAllMocks();
  });

  it('routes registered group with trigger to enqueueMessageCheck', async () => {
    const queue = createMockQueue();
    const state = createMockState({
      getRegisteredGroup: vi.fn(() => ({ name: 'Side', folder: 'side', requiresTrigger: true })),
    } as unknown as Partial<RouterState>);

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
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
    expect(queue.sendMessage).not.toHaveBeenCalled();
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
    expect(queue.sendMessage).not.toHaveBeenCalled();
  });

  it('pipes to active container when sendMessage returns true', async () => {
    const queue = createMockQueue({
      sendMessage: vi.fn(() => true),
    } as unknown as Partial<GroupQueue>);
    const state = createMockState();
    const msg = makeMessage('hello', '2024-01-01T00:00:01.000Z');

    vi.mocked(getMessagesSince).mockReturnValue([msg]);
    vi.mocked(formatMessages).mockReturnValue('formatted-content');

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', msg));

    expect(queue.sendMessage).toHaveBeenCalledWith('group@g.us', 'formatted-content', '2024-01-01T00:00:01.000Z');
  });

  it('falls back to enqueue when sendMessage returns false', async () => {
    const queue = createMockQueue({
      sendMessage: vi.fn(() => false),
    } as unknown as Partial<GroupQueue>);
    const state = createMockState();

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', makeMessage('hello')));

    expect(queue.enqueueMessageCheck).toHaveBeenCalledWith('group@g.us');
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
    expect(queue.sendMessage).not.toHaveBeenCalled();
  });

  it('advances cursor after successful pipe', async () => {
    const queue = createMockQueue({
      sendMessage: vi.fn(() => true),
    } as unknown as Partial<GroupQueue>);
    const state = createMockState();
    const msg = makeMessage('hello', '2024-01-01T00:00:05.000Z');

    vi.mocked(getMessagesSince).mockReturnValue([msg]);

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', msg));

    expect(state.setAgentTimestamp).toHaveBeenCalledWith('group@g.us', '2024-01-01T00:00:05.000Z');
    expect(state.save).toHaveBeenCalled();
  });

  it('emits TypingUpdate after successful pipe', async () => {
    const queue = createMockQueue({
      sendMessage: vi.fn(() => true),
    } as unknown as Partial<GroupQueue>);
    const state = createMockState();
    const typingHandler = vi.fn();

    registerMessageRouter({
      bus, state, queue,
      getChannels: () => [createMockChannel('group@g.us')],
      getInterceptor: () => null,
    });

    bus.on(TypingUpdate, typingHandler);

    vi.mocked(getMessagesSince).mockReturnValue([makeMessage('hello')]);

    await bus.emit(new InboundMessage('whatsapp', 'group@g.us', makeMessage('hello')));

    // TypingUpdate is emitted async, give it a tick
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(typingHandler).toHaveBeenCalledOnce();
    expect(typingHandler.mock.calls[0][0].jid).toBe('group@g.us');
    expect(typingHandler.mock.calls[0][0].isTyping).toBe(true);
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
    expect(queue.sendMessage).not.toHaveBeenCalled();
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
    expect(queue.sendMessage).not.toHaveBeenCalled();
  });
});
