import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { MessageBus } from '../bus/message-bus.js';
import { InboundMessage } from '../bus/events/inbound-message.js';
import { registerContentPipeHandler } from './content-pipe-handler.js';
import type { ContentPipe, ContentEnvelope, RawContent } from './content-pipe.js';
import type { RawContentRepository } from '../db/raw-content-repository.js';
import type { NewMessage } from '../types.js';

function makeMessage(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@g.us',
    sender: 'user@example.com',
    sender_name: 'User',
    content: 'Hello from email',
    timestamp: '2026-03-05T12:00:00Z',
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

function makeEnvelope(id: string): ContentEnvelope {
  return {
    id,
    source: 'user@example.com',
    channel: 'email',
    receivedAt: '2026-03-05T12:00:00Z',
    metadata: {},
    summary: 'Summarized content.',
    intent: 'info',
    safetyFlags: [],
    rawAvailable: true,
  };
}

function createMockPipe(): ContentPipe {
  return {
    process: vi.fn(async (raw: RawContent) => makeEnvelope(raw.id)),
  };
}

function createMockRawStore(): RawContentRepository {
  return {
    store: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    exists: vi.fn().mockReturnValue(false),
    getRecent: vi.fn().mockReturnValue([]),
    cleanupExpired: vi.fn().mockReturnValue(0),
  };
}

describe('registerContentPipeHandler', () => {
  let bus: MessageBus;
  let pipe: ContentPipe;
  let rawStore: RawContentRepository;

  beforeEach(() => {
    bus = new MessageBus();
    pipe = createMockPipe();
    rawStore = createMockRawStore();
  });

  it('registers at priority 20 with sequential: true', () => {
    const onSpy = vi.spyOn(bus, 'on');

    registerContentPipeHandler({
      bus,
      pipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: false,
    });

    expect(onSpy).toHaveBeenCalledWith(
      InboundMessage,
      expect.any(Function),
      expect.objectContaining({ priority: 20, sequential: true }),
    );
  });

  it('processes messages from untrusted channels', async () => {
    registerContentPipeHandler({
      bus,
      pipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: false,
    });

    const event = new InboundMessage('email', 'group@g.us', makeMessage(), { channel: 'email' });
    await bus.emit(event);

    expect(pipe.process).toHaveBeenCalled();
    expect(rawStore.store).toHaveBeenCalled();
    expect(event.message.content).toContain('Summarized content.');
  });

  it('skips messages from trusted channels', async () => {
    registerContentPipeHandler({
      bus,
      pipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: false,
    });

    const event = new InboundMessage('whatsapp', 'group@g.us', makeMessage(), { channel: 'whatsapp' });
    await bus.emit(event);

    expect(pipe.process).not.toHaveBeenCalled();
    expect(event.message.content).toBe('Hello from email');
  });

  it('skips messages with no channel', async () => {
    registerContentPipeHandler({
      bus,
      pipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: false,
    });

    const event = new InboundMessage('unknown', 'group@g.us', makeMessage());
    await bus.emit(event);

    expect(pipe.process).not.toHaveBeenCalled();
  });

  it('cancels event on critical injection when blockOnCritical is true', async () => {
    const criticalPipe: ContentPipe = {
      process: vi.fn(async (raw: RawContent) => ({
        ...makeEnvelope(raw.id),
        safetyFlags: [{ severity: 'critical' as const, category: 'injection', description: 'test' }],
      })),
    };

    registerContentPipeHandler({
      bus,
      pipe: criticalPipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: true,
    });

    const event = new InboundMessage('email', 'group@g.us', makeMessage(), { channel: 'email' });
    await bus.emit(event);

    expect(event.cancelled).toBe(true);
  });

  it('does not cancel on critical when blockOnCritical is false', async () => {
    const criticalPipe: ContentPipe = {
      process: vi.fn(async (raw: RawContent) => ({
        ...makeEnvelope(raw.id),
        safetyFlags: [{ severity: 'critical' as const, category: 'injection', description: 'test' }],
      })),
    };

    registerContentPipeHandler({
      bus,
      pipe: criticalPipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: false,
    });

    const event = new InboundMessage('email', 'group@g.us', makeMessage(), { channel: 'email' });
    await bus.emit(event);

    expect(event.cancelled).not.toBe(true);
  });

  it('passes raw message through on pipe error (fail-open)', async () => {
    const failingPipe: ContentPipe = {
      process: vi.fn().mockRejectedValue(new Error('LLM unreachable')),
    };

    registerContentPipeHandler({
      bus,
      pipe: failingPipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: false,
    });

    const event = new InboundMessage('email', 'group@g.us', makeMessage(), { channel: 'email' });
    await bus.emit(event);

    // Content unchanged — fail-open
    expect(event.message.content).toBe('Hello from email');
    expect(event.cancelled).not.toBe(true);
  });

  it('returns unsubscribe function', () => {
    const unsub = registerContentPipeHandler({
      bus,
      pipe,
      rawContentStore: rawStore,
      untrustedChannels: new Set(['email']),
      blockOnCritical: false,
    });

    expect(typeof unsub).toBe('function');
  });
});
