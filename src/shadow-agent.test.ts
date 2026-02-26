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

// Mock config — ADMIN_KEY is mutable so tests can toggle it
let mockAdminKey = 'secretkey';
vi.mock('./config.js', () => ({
  get ADMIN_KEY() { return mockAdminKey; },
  ADMIN_TRIGGER: '!admin',
  GROUPS_DIR: '/tmp/test-groups',
}));

// Mock fs — prevent real filesystem operations
vi.mock('fs', () => ({
  default: {
    mkdirSync: vi.fn(),
    existsSync: vi.fn(() => true),
    writeFileSync: vi.fn(),
  },
}));

// Mock container runner — prevent real container spawns
const mockRunContainerAgent = vi.fn().mockResolvedValue({ status: 'success', result: null });
vi.mock('./container-runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
}));

// Mock db
vi.mock('./db.js', () => ({
  getSession: vi.fn(() => undefined),
  setSession: vi.fn(),
}));

// Mock router
vi.mock('./router.js', () => ({
  formatOutbound: vi.fn((text: string) => text),
}));

import { createShadowAgent } from './shadow-agent.js';
import { NewMessage, MessageBusEvent } from './types.js';

const ADMIN_JID = '1234567890@s.whatsapp.net';

function makeMsg(overrides: Partial<NewMessage> = {}): NewMessage {
  return {
    id: 'msg-1',
    chat_jid: 'group@g.us',
    sender: ADMIN_JID,
    sender_name: 'Admin',
    content: '',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeChannel(ownsJid = true) {
  return {
    name: 'test',
    connect: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => ownsJid),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminKey = 'secretkey';
});

// --- Feature toggle ---

describe('createShadowAgent', () => {
  describe('feature toggle', () => {
    it('returns no-op when ADMIN_KEY is empty', () => {
      mockAdminKey = '';
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      const msg = makeMsg({ content: '!admin secretkey hello' });
      expect(interceptor('group@g.us', msg)).toBe(false);
    });
  });

  // --- Callback path (WhatsApp) ---

  describe('callback path', () => {
    it('gate 1: passes through when sender is not admin', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      const msg = makeMsg({
        sender: '9999999999@s.whatsapp.net',
        content: '!admin secretkey hello',
      });
      expect(interceptor('group@g.us', msg)).toBe(false);
    });

    it('gate 1: matches admin JID with device suffix', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [makeChannel()],
      });

      const msg = makeMsg({
        sender: '1234567890:5@s.whatsapp.net',
        content: '!admin secretkey hello',
      });
      expect(interceptor('group@g.us', msg)).toBe(true);
    });

    it('gate 2: passes through when no trigger prefix', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      const msg = makeMsg({ content: 'just a normal message' });
      expect(interceptor('group@g.us', msg)).toBe(false);
    });

    it('gate 2: passes through for partial trigger match', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      const msg = makeMsg({ content: '!adminfoo secretkey hello' });
      expect(interceptor('group@g.us', msg)).toBe(false);
    });

    it('gate 3: silently drops when key is wrong', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      const msg = makeMsg({ content: '!admin wrongkey hello' });
      expect(interceptor('group@g.us', msg)).toBe(true);
    });

    it('gate 3: silently drops when key only (no prompt)', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      const msg = makeMsg({ content: '!admin secretkey' });
      expect(interceptor('group@g.us', msg)).toBe(true);
    });

    it('gate 3: silently drops when key + only whitespace prompt', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      const msg = makeMsg({ content: '!admin secretkey   ' });
      expect(interceptor('group@g.us', msg)).toBe(true);
    });

    it('all gates pass: intercepts and spawns container', () => {
      const channel = makeChannel();
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [channel],
      });

      const msg = makeMsg({ content: '!admin secretkey show me groups' });
      expect(interceptor('group@g.us', msg)).toBe(true);
      expect(mockRunContainerAgent).toHaveBeenCalled();
    });

    it('strips trigger and key from prompt sent to container', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [makeChannel()],
      });

      const msg = makeMsg({ content: '!admin secretkey show me groups' });
      interceptor('group@g.us', msg);

      const containerInput = mockRunContainerAgent.mock.calls[0][1];
      expect(containerInput.prompt).toContain('show me groups');
      expect(containerInput.prompt).not.toContain('secretkey');
      expect(containerInput.prompt).not.toContain('!admin');
    });

    it('wraps prompt with admin_context tag', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [makeChannel()],
      });

      const msg = makeMsg({ content: '!admin secretkey hello' });
      interceptor('some-chat@g.us', msg);

      const containerInput = mockRunContainerAgent.mock.calls[0][1];
      expect(containerInput.prompt).toContain('<admin_context source_chat="some-chat@g.us"');
    });

    it('spawns container with isMain: true', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [makeChannel()],
      });

      const msg = makeMsg({ content: '!admin secretkey hello' });
      interceptor('group@g.us', msg);

      const containerInput = mockRunContainerAgent.mock.calls[0][1];
      expect(containerInput.isMain).toBe(true);
    });
  });

  // --- Bus path (Web channel) ---

  describe('bus path', () => {
    function makeBus() {
      const handlers: Array<{ handler: (e: MessageBusEvent) => void | Promise<void>; priority: number }> = [];
      return {
        emit: vi.fn(),
        emitAsync: vi.fn(),
        on: vi.fn((
          _type: string,
          handler: (e: MessageBusEvent) => void | Promise<void>,
          opts?: { priority?: number },
        ) => {
          handlers.push({ handler, priority: opts?.priority ?? 100 });
          return () => {};
        }),
        _handlers: handlers,
        _fire(event: MessageBusEvent) {
          // Sort by priority and run, like the real bus
          const sorted = [...handlers].sort((a, b) => a.priority - b.priority);
          for (const h of sorted) {
            if (event.cancelled) break;
            h.handler(event);
          }
        },
      };
    }

    function makeBusEvent(content: string, sender = 'web:user'): MessageBusEvent {
      return {
        type: 'message.inbound',
        source: 'web',
        timestamp: new Date().toISOString(),
        data: {
          jid: 'web:ui',
          message: makeMsg({ sender, content, chat_jid: 'web:ui' }),
        },
      };
    }

    it('subscribes at priority 10', () => {
      const bus = makeBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
      });

      expect(bus.on).toHaveBeenCalledWith(
        'message.inbound',
        expect.any(Function),
        expect.objectContaining({ priority: 10 }),
      );
    });

    it('skips JID check — any sender with correct key is accepted', () => {
      const bus = makeBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [makeChannel()],
        messageBus: bus,
      });

      const event = makeBusEvent('!admin secretkey hello', 'web:user');
      bus._fire(event);

      expect(event.cancelled).toBe(true);
      expect(mockRunContainerAgent).toHaveBeenCalled();
    });

    it('passes through normal messages without trigger', () => {
      const bus = makeBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
      });

      const event = makeBusEvent('hello world');
      bus._fire(event);

      expect(event.cancelled).toBeUndefined();
    });

    it('cancels event on wrong key (silent drop)', () => {
      const bus = makeBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
      });

      const event = makeBusEvent('!admin wrongkey hello');
      bus._fire(event);

      expect(event.cancelled).toBe(true);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('cancels event on empty prompt after key', () => {
      const bus = makeBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
      });

      const event = makeBusEvent('!admin secretkey');
      bus._fire(event);

      expect(event.cancelled).toBe(true);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('does not subscribe when no messageBus provided', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
      });

      // Just returns the callback — no bus interaction
      expect(typeof interceptor).toBe('function');
    });
  });
});
