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
import { InboundMessage } from '../bus/index.js';

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

function makeBusEvent(content: string, sender = 'web:user'): InboundMessage {
  return new InboundMessage(
    'web',
    'web:ui',
    makeMsg({ sender, content, chat_jid: 'web:ui' }),
    { channel: 'web' },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAdminKey = 'secretkey';
});

describe('createShadowAgent', () => {
  describe('feature toggle', () => {
    it('does not register bus handler when ADMIN_KEY is empty', () => {
      mockAdminKey = '';
      const bus = new MessageBus();
      const onSpy = vi.spyOn(bus, 'on');
      createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      expect(onSpy).not.toHaveBeenCalled();
    });

    it('passes through messages when disabled', async () => {
      mockAdminKey = '';
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: ADMIN_JID,
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin secretkey hello');
      await bus.emit(event);

      expect(event.cancelled).toBe(false);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });
  });

  describe('gate checks', () => {
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

    it('passes through for partial trigger match', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!adminfoo secretkey hello');
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

    it('cancels event on key only (no prompt)', async () => {
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

    it('cancels event on key + only whitespace prompt', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin secretkey   ');
      await bus.emit(event);

      expect(event.cancelled).toBe(true);
      expect(mockRunContainerAgent).not.toHaveBeenCalled();
    });
  });

  describe('bus interception', () => {
    it('subscribes to InboundMessage at priority 10', () => {
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

    it('any sender with correct key is accepted', async () => {
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

    it('strips trigger and key from prompt sent to container', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [makeChannel()],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin secretkey show me groups');
      await bus.emit(event);

      const containerInput = mockRunContainerAgent.mock.calls[0][1];
      expect(containerInput.prompt).toContain('show me groups');
      expect(containerInput.prompt).not.toContain('secretkey');
      expect(containerInput.prompt).not.toContain('!admin');
    });

    it('wraps prompt with admin_context tag', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [makeChannel()],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin secretkey hello');
      await bus.emit(event);

      const containerInput = mockRunContainerAgent.mock.calls[0][1];
      expect(containerInput.prompt).toContain('<admin_context source_chat="web:ui"');
    });

    it('spawns container with isMain: true', async () => {
      const bus = new MessageBus();
      createShadowAgent({
        adminJid: '',
        adminTrigger: '!admin',
        channels: [makeChannel()],
        messageBus: bus,
        getAgentOptions: stubGetAgentOptions,
      });

      const event = makeBusEvent('!admin secretkey hello');
      await bus.emit(event);

      const execution = mockRunContainerAgent.mock.calls[0][0];
      expect(execution.isMain).toBe(true);
    });

    it('always subscribes to bus when key is set', () => {
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
