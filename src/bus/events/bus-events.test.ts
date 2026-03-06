import { describe, it, expect } from 'vitest';
import { BusEvent } from '../bus-event.js';
import { InboundMessage } from './inbound-message.js';
import { OutboundMessage } from './outbound-message.js';
import { ChatMetadata } from './chat-metadata.js';
import { TypingUpdate } from './typing-update.js';
import { AgentTelemetry } from './agent-telemetry.js';
import { AgentError } from './agent-error.js';

// ---------------------------------------------------------------------------
// Shared test fixture
// ---------------------------------------------------------------------------

const mockMessage = {
  id: 'msg-1',
  chat_jid: 'test@g.us',
  sender: 'user@s.whatsapp.net',
  sender_name: 'Test User',
  content: 'hello',
  timestamp: new Date().toISOString(),
  is_from_me: false,
  is_bot_message: false,
};

// ---------------------------------------------------------------------------
// InboundMessage
// ---------------------------------------------------------------------------

describe('InboundMessage', () => {
  it('has type "message.inbound"', () => {
    const event = new InboundMessage('whatsapp', 'chat@g.us', mockMessage);
    expect(event.type).toBe('message.inbound');
  });

  it('sets jid and message correctly', () => {
    const event = new InboundMessage('whatsapp', 'chat@g.us', mockMessage);
    expect(event.jid).toBe('chat@g.us');
    expect(event.message).toBe(mockMessage);
  });

  it('passes channel from opts to the envelope', () => {
    const event = new InboundMessage('whatsapp', 'chat@g.us', mockMessage, {
      channel: 'web',
    });
    expect(event.channel).toBe('web');
  });

  it('works without opts (channel is undefined)', () => {
    const event = new InboundMessage('whatsapp', 'chat@g.us', mockMessage);
    expect(event.channel).toBeUndefined();
  });

  it('has a UUID id', () => {
    const event = new InboundMessage('whatsapp', 'chat@g.us', mockMessage);
    expect(event.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it('is an instance of BusEvent', () => {
    const event = new InboundMessage('whatsapp', 'chat@g.us', mockMessage);
    expect(event).toBeInstanceOf(BusEvent);
  });

  it('passes envelope options through to BusEvent', () => {
    const event = new InboundMessage('whatsapp', 'chat@g.us', mockMessage, {
      channel: 'web',
      correlationId: 'corr-in',
      causationId: 'cause-in',
    });
    expect(event.correlationId).toBe('corr-in');
    expect(event.causationId).toBe('cause-in');
    expect(event.channel).toBe('web');
  });
});

// ---------------------------------------------------------------------------
// OutboundMessage
// ---------------------------------------------------------------------------

describe('OutboundMessage', () => {
  it('has type "message.outbound"', () => {
    const event = new OutboundMessage('router', 'chat@g.us', 'Hello!');
    expect(event.type).toBe('message.outbound');
  });

  it('sets all domain properties correctly', () => {
    const event = new OutboundMessage('router', 'chat@g.us', 'Hello!', {
      groupFolder: 'main',
      broadcast: true,
      agentId: 'agent-1',
    });
    expect(event.jid).toBe('chat@g.us');
    expect(event.text).toBe('Hello!');
    expect(event.groupFolder).toBe('main');
    expect(event.broadcast).toBe(true);
    expect(event.agentId).toBe('agent-1');
  });

  it('domain opts default to undefined when not provided', () => {
    const event = new OutboundMessage('router', 'chat@g.us', 'Hello!');
    expect(event.groupFolder).toBeUndefined();
    expect(event.broadcast).toBeUndefined();
    expect(event.agentId).toBeUndefined();
  });

  it('passes envelope options through alongside domain opts', () => {
    const event = new OutboundMessage('router', 'chat@g.us', 'Hello!', {
      groupFolder: 'main',
      correlationId: 'corr-out',
      channel: 'whatsapp',
    });
    expect(event.correlationId).toBe('corr-out');
    expect(event.channel).toBe('whatsapp');
    expect(event.groupFolder).toBe('main');
  });

  it('is an instance of BusEvent', () => {
    const event = new OutboundMessage('router', 'chat@g.us', 'Hello!');
    expect(event).toBeInstanceOf(BusEvent);
  });
});

// ---------------------------------------------------------------------------
// ChatMetadata
// ---------------------------------------------------------------------------

describe('ChatMetadata', () => {
  it('has type "chat.metadata"', () => {
    const event = new ChatMetadata('whatsapp', 'chat@g.us');
    expect(event.type).toBe('chat.metadata');
  });

  it('sets jid correctly', () => {
    const event = new ChatMetadata('whatsapp', 'chat@g.us');
    expect(event.jid).toBe('chat@g.us');
  });

  it('sets domain opts (name, isGroup)', () => {
    const event = new ChatMetadata('whatsapp', 'chat@g.us', {
      name: 'Dev Chat',
      isGroup: true,
    });
    expect(event.name).toBe('Dev Chat');
    expect(event.isGroup).toBe(true);
  });

  it('domain and envelope opts coexist', () => {
    const event = new ChatMetadata('whatsapp', 'chat@g.us', {
      name: 'Dev Chat',
      isGroup: true,
      channel: 'whatsapp',
      correlationId: 'corr-meta',
    });
    expect(event.name).toBe('Dev Chat');
    expect(event.isGroup).toBe(true);
    expect(event.channel).toBe('whatsapp');
    expect(event.correlationId).toBe('corr-meta');
  });

  it('works without opts', () => {
    const event = new ChatMetadata('whatsapp', 'chat@g.us');
    expect(event.name).toBeUndefined();
    expect(event.isGroup).toBeUndefined();
    expect(event.channel).toBeUndefined();
  });

  it('is an instance of BusEvent', () => {
    const event = new ChatMetadata('whatsapp', 'chat@g.us');
    expect(event).toBeInstanceOf(BusEvent);
  });
});

// ---------------------------------------------------------------------------
// TypingUpdate
// ---------------------------------------------------------------------------

describe('TypingUpdate', () => {
  it('has type "typing.update"', () => {
    const event = new TypingUpdate('whatsapp', 'chat@g.us', true);
    expect(event.type).toBe('typing.update');
  });

  it('sets jid and isTyping correctly', () => {
    const event = new TypingUpdate('whatsapp', 'chat@g.us', true);
    expect(event.jid).toBe('chat@g.us');
    expect(event.isTyping).toBe(true);
  });

  it('handles isTyping false', () => {
    const event = new TypingUpdate('whatsapp', 'chat@g.us', false);
    expect(event.isTyping).toBe(false);
  });

  it('accepts optional envelope', () => {
    const event = new TypingUpdate('whatsapp', 'chat@g.us', true, {
      correlationId: 'corr-typing',
      channel: 'web',
    });
    expect(event.correlationId).toBe('corr-typing');
    expect(event.channel).toBe('web');
  });

  it('works without envelope (envelope fields undefined)', () => {
    const event = new TypingUpdate('whatsapp', 'chat@g.us', true);
    expect(event.correlationId).toBeUndefined();
    expect(event.channel).toBeUndefined();
  });

  it('is an instance of BusEvent', () => {
    const event = new TypingUpdate('whatsapp', 'chat@g.us', true);
    expect(event).toBeInstanceOf(BusEvent);
  });
});

// ---------------------------------------------------------------------------
// AgentTelemetry
// ---------------------------------------------------------------------------

describe('AgentTelemetry', () => {
  it('has type "agent.telemetry"', () => {
    const event = new AgentTelemetry('runner', 'chat@g.us', {
      durationMs: 1500,
    });
    expect(event.type).toBe('agent.telemetry');
  });

  it('sets all domain fields correctly', () => {
    const event = new AgentTelemetry('runner', 'chat@g.us', {
      durationMs: 1500,
      inputTokens: 100,
      outputTokens: 200,
      totalCostUsd: 0.005,
    });
    expect(event.chatJid).toBe('chat@g.us');
    expect(event.durationMs).toBe(1500);
    expect(event.inputTokens).toBe(100);
    expect(event.outputTokens).toBe(200);
    expect(event.totalCostUsd).toBe(0.005);
  });

  it('optional domain fields default to undefined', () => {
    const event = new AgentTelemetry('runner', 'chat@g.us', {
      durationMs: 500,
    });
    expect(event.inputTokens).toBeUndefined();
    expect(event.outputTokens).toBeUndefined();
    expect(event.totalCostUsd).toBeUndefined();
  });

  it('opts include both domain fields and envelope fields', () => {
    const event = new AgentTelemetry('runner', 'chat@g.us', {
      durationMs: 1500,
      inputTokens: 100,
      correlationId: 'corr-tele',
      channel: 'whatsapp',
    });
    expect(event.durationMs).toBe(1500);
    expect(event.inputTokens).toBe(100);
    expect(event.correlationId).toBe('corr-tele');
    expect(event.channel).toBe('whatsapp');
  });

  it('is an instance of BusEvent', () => {
    const event = new AgentTelemetry('runner', 'chat@g.us', {
      durationMs: 100,
    });
    expect(event).toBeInstanceOf(BusEvent);
  });
});

// ---------------------------------------------------------------------------
// AgentError
// ---------------------------------------------------------------------------

describe('AgentError', () => {
  it('has type "agent.error"', () => {
    const event = new AgentError('runner', 'chat@g.us', 'timeout', 3000);
    expect(event.type).toBe('agent.error');
  });

  it('sets positional args correctly', () => {
    const event = new AgentError('runner', 'chat@g.us', 'out of memory', 5000);
    expect(event.source).toBe('runner');
    expect(event.chatJid).toBe('chat@g.us');
    expect(event.error).toBe('out of memory');
    expect(event.durationMs).toBe(5000);
  });

  it('accepts optional envelope', () => {
    const event = new AgentError('runner', 'chat@g.us', 'fail', 100, {
      correlationId: 'corr-err',
      channel: 'email',
      causationId: 'cause-err',
    });
    expect(event.correlationId).toBe('corr-err');
    expect(event.channel).toBe('email');
    expect(event.causationId).toBe('cause-err');
  });

  it('works without envelope (envelope fields undefined)', () => {
    const event = new AgentError('runner', 'chat@g.us', 'fail', 100);
    expect(event.correlationId).toBeUndefined();
    expect(event.channel).toBeUndefined();
  });

  it('is an instance of BusEvent', () => {
    const event = new AgentError('runner', 'chat@g.us', 'fail', 100);
    expect(event).toBeInstanceOf(BusEvent);
  });
});
