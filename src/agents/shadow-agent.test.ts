import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock config — ADMIN_KEY is mutable so tests can toggle it
let mockAdminKey = 'secretkey';
vi.mock('../config/config.js', () => ({
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
vi.mock('../container/runner.js', () => ({
  runContainerAgent: (...args: unknown[]) => mockRunContainerAgent(...args),
}));

// Mock db
vi.mock('../db/index.js', () => ({
  getSession: vi.fn(() => undefined),
  setSession: vi.fn(),
}));

// Mock router
vi.mock('../utils/router.js', () => ({
  formatOutbound: vi.fn((text: string) => text),
}));

import { createShadowAgent } from './shadow-agent.js';
import { NewMessage, MessageBus } from '../types.js';
import { BusEvent, InboundMessage } from '../bus/index.js';
import type { EventClass, HandlerOptions } from '../bus/index.js';

function stubBus(): MessageBus {
  return new MessageBus();
}

const stubGetAgentOptions = () => ({ containerImage: 'test:latest', secretKeys: [] });

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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
      });

      const msg = makeMsg({ content: 'just a normal message' });
      expect(interceptor('group@g.us', msg)).toBe(false);
    });

    it('gate 2: passes through for partial trigger match', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
      });

      const msg = makeMsg({ content: '!adminfoo secretkey hello' });
      expect(interceptor('group@g.us', msg)).toBe(false);
    });

    it('gate 3: silently drops when key is wrong', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
      });

      const msg = makeMsg({ content: '!admin wrongkey hello' });
      expect(interceptor('group@g.us', msg)).toBe(true);
    });

    it('gate 3: silently drops when key only (no prompt)', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
      });

      const msg = makeMsg({ content: '!admin secretkey' });
      expect(interceptor('group@g.us', msg)).toBe(true);
    });

    it('gate 3: silently drops when key + only whitespace prompt', () => {
      const interceptor = createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
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
        messageBus: stubBus(),
        getAgentOptions: stubGetAgentOptions,
      });

      const msg = makeMsg({ content: '!admin secretkey hello' });
      interceptor('group@g.us', msg);

      const containerInput = mockRunContainerAgent.mock.calls[0][1];
      expect(containerInput.isMain).toBe(true);
    });
  });

  // --- Bus path (Web channel) ---

  describe('bus path', () => {
    function makeBusEvent(content: string, sender = 'web:user'): InboundMessage {
      return new InboundMessage(
        'web',
        'web:ui',
        makeMsg({ sender, content, chat_jid: 'web:ui' }),
        'web',
      );
    }

    it('subscribes to InboundMessage', () => {
      const bus = new MessageBus();
      const onSpy = vi.spyOn(bus, 'on');
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      expect(onSpy).toHaveBeenCalledWith(
        InboundMessage,
        expect.any(Function),
        expect.objectContaining({ priority: 10, sequential: true }),
      );
    });

    it('skips JID check — any sender with correct key is accepted', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [makeChannel()],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin secretkey hello', 'web:user');
      await bus.emit(event);

      expect(event.cancelled).toBe(true);
      expect(mockRunContainerAgent).toHaveBeenCalled();
    });

    it('passes through normal messages without trigger', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('hello world');
      await bus.emit(event);

      expect(event.cancelled).toBe(false);
    });

    it('cancels event on wrong key (silent drop)', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin wrongkey hello');
      await bus.emit(event);

      expect(event.cancelled).toBe(true);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('cancels event on empty prompt after key', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin secretkey');
      await bus.emit(event);

      expect(event.cancelled).toBe(true);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });

    it('always subscribes to bus for message interception', () => {
      const bus = new MessageBus();
      const onSpy = vi.spyOn(bus, 'on');
      createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      expect(onSpy).toHaveBeenCalledWith(
        InboundMessage,
        expect.any(Function),
        expect.objectContaining({ priority: 10 }),
      );
    });
  });
});
