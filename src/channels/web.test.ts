import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('../config/config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  MAIN_GROUP_FOLDER: 'main',
  WEB_CHANNEL_PORT: 0, // random port for tests
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../db/index.js', () => ({
  getChatHistory: vi.fn((jid: string) => {
    if (jid === 'web:ui:conv-1') {
      return [
        { id: 'msg-c1', content: 'Conv1 msg', sender_name: 'User', timestamp: '2025-01-01T00:00:00.000Z', is_bot_message: 0 },
      ];
    }
    return [
      { id: 'msg-1', content: 'Hello', sender_name: 'User', timestamp: '2025-01-01T00:00:00.000Z', is_bot_message: 0 },
      { id: 'msg-2', content: 'Hi there!', sender_name: 'Andy', timestamp: '2025-01-01T00:00:01.000Z', is_bot_message: 1 },
    ];
  }),
  listConversations: vi.fn(() => [
    { id: 'conv-1', title: 'Test', preview: 'Hello', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
  ]),
  upsertConversation: vi.fn(),
  getConversation: vi.fn((id: string) =>
    id === 'conv-1' ? { id: 'conv-1', title: 'Test', preview: '', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' } : undefined
  ),
  renameConversation: vi.fn(),
  deleteConversation: vi.fn(),
  updatePreview: vi.fn(),
}));

import { WebChannel } from './web.js';
import { ChannelOpts, MessageBus } from '../types.js';

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({})),
    registerGroup: vi.fn(),
    messageBus: new MessageBus(),
    ...overrides,
  };
}

/** Get the server's actual port after it starts listening on port 0. */
function getPort(channel: WebChannel): number {
  // Access the private server field
  const server = (channel as any).server;
  const addr = server?.address();
  return typeof addr === 'object' ? addr.port : 0;
}

function buildUrl(channel: WebChannel, path: string): string {
  return `http://127.0.0.1:${getPort(channel)}${path}`;
}

describe('WebChannel', () => {
  let channel: WebChannel;
  let opts: ChannelOpts;

  beforeEach(async () => {
    vi.clearAllMocks();
    opts = createTestOpts();
    channel = new WebChannel(opts, 0);
  });

  afterEach(async () => {
    if (channel.isConnected()) {
      await channel.disconnect();
    }
  });

  describe('channel properties', () => {
    it('has name "web"', () => {
      expect(channel.name).toBe('web');
    });
  });

  describe('ownsJid', () => {
    it('owns web: prefixed JIDs', () => {
      expect(channel.ownsJid('web:ui')).toBe(true);
      expect(channel.ownsJid('web:other')).toBe(true);
    });

    it('does not own other JID formats', () => {
      expect(channel.ownsJid('cli:console')).toBe(false);
      expect(channel.ownsJid('12345@g.us')).toBe(false);
      expect(channel.ownsJid('tg:12345')).toBe(false);
      expect(channel.ownsJid('dc:12345')).toBe(false);
    });
  });

  describe('connect', () => {
    it('registers as main group with requiresTrigger false', async () => {
      await channel.connect();

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'web:ui',
        expect.objectContaining({
          name: 'Web UI',
          folder: 'main',
          requiresTrigger: false,
        }),
      );
    });

    it('sets connected to true', async () => {
      expect(channel.isConnected()).toBe(false);
      await channel.connect();
      expect(channel.isConnected()).toBe(true);
    });

    it('starts HTTP server', async () => {
      await channel.connect();
      const port = getPort(channel);
      expect(port).toBeGreaterThan(0);
    });
  });

  describe('disconnect', () => {
    it('sets connected to false and stops HTTP server', async () => {
      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  describe('GET /health', () => {
    it('returns status ok', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/health'));
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toEqual({
        status: 'ok',
        channel: 'web',
        connected: true,
        wsClients: 0,
      });
    });
  });

  describe('GET /history', () => {
    it('returns conversation history', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/history'));
      const body = (await res.json()) as { messages: Array<{ content: string }> };

      expect(res.status).toBe(200);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].content).toBe('Hello');
      expect(body.messages[1].content).toBe('Hi there!');
    });
  });

  describe('POST /message', () => {
    it('rejects empty message', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: '' }),
      });

      expect(res.status).toBe(400);
    });

    it('rejects invalid JSON', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(res.status).toBe(400);
    });

    it('delivers message to orchestrator and streams response', async () => {
      await channel.connect();

      // The web channel now uses messageBus.emit for message delivery.
      // Subscribe to InboundMessage on the bus to simulate the orchestrator
      // responding via sendMessage.
      const { InboundMessage } = await import('../bus/index.js');
      opts.messageBus.on(InboundMessage, () => {
        setTimeout(() => {
          channel.sendMessage('web:ui', 'Hello from the agent!');
        }, 50);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'Hello', sender_name: 'Test User' }),
      });

      const text = await res.text();
      const chunks = text
        .split('\n\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => JSON.parse(line.replace('data: ', '')));

      // Should have at least a delta and done chunk
      const deltaChunk = chunks.find((c: any) => c.type === 'delta');
      const doneChunk = chunks.find((c: any) => c.type === 'done');

      expect(deltaChunk).toBeDefined();
      expect(deltaChunk.text).toBe('Hello from the agent!');
      expect(doneChunk).toBeDefined();
    });

    it('uses default sender_name when not provided', async () => {
      await channel.connect();

      const { InboundMessage } = await import('../bus/index.js');
      opts.messageBus.on(InboundMessage, (event) => {
        expect(event.message.sender_name).toBe('User');
        setTimeout(() => channel.sendMessage('web:ui', 'ok'), 10);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test' }),
      });

      await res.text(); // consume the response
    });
  });

  describe('sendMessage', () => {
    it('buffers message when no WS clients or pending request exists', async () => {
      const { logger } = await import('../logger.js');
      await channel.connect();
      await channel.sendMessage('web:ui', 'orphan message');
      // With no WS clients and no pending SSE request, message is buffered
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ jid: 'web:ui', buffered: 1 }),
        'No WebSocket clients — message buffered for delivery on next connect',
      );
    });
  });

  describe('404 handling', () => {
    it('returns 404 for unknown routes', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/unknown'));
      expect(res.status).toBe(404);
    });
  });

  describe('CORS', () => {
    it('handles OPTIONS preflight', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/health'), {
        method: 'OPTIONS',
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
    });
  });

  // --- Conversation-aware endpoints ---

  describe('GET /history with conversation_id', () => {
    it('returns only messages for the specified conversation', async () => {
      await channel.connect();
      const { getChatHistory } = await import('../db/index.js');

      const res = await fetch(buildUrl(channel, '/history?conversation_id=conv-1'));
      const body = (await res.json()) as { messages: Array<{ content: string }> };

      expect(res.status).toBe(200);
      expect(getChatHistory).toHaveBeenCalledWith('web:ui:conv-1', 200);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toBe('Conv1 msg');
    });

    it('returns all messages when no conversation_id', async () => {
      await channel.connect();
      const { getChatHistory } = await import('../db/index.js');

      const res = await fetch(buildUrl(channel, '/history'));
      await res.json();

      expect(getChatHistory).toHaveBeenCalledWith('web:ui', 200);
    });
  });

  describe('POST /message with conversation_id', () => {
    it('stores message under composite JID web:ui:{id}', async () => {
      await channel.connect();

      const { InboundMessage } = await import('../bus/index.js');
      opts.messageBus.on(InboundMessage, (event) => {
        expect(event.message.chat_jid).toBe('web:ui:conv-1');
        setTimeout(() => channel.sendMessage('web:ui:conv-1', 'ok'), 10);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test', conversation_id: 'conv-1' }),
      });

      await res.text();
    });

    it('auto-creates conversation if not exists', async () => {
      await channel.connect();
      const { upsertConversation } = await import('../db/index.js');

      const { InboundMessage } = await import('../bus/index.js');
      opts.messageBus.on(InboundMessage, () => {
        setTimeout(() => channel.sendMessage('web:ui:new-conv', 'ok'), 10);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'hello', conversation_id: 'new-conv' }),
      });

      await res.text();
      expect(upsertConversation).toHaveBeenCalledWith('new-conv', 'New conversation', '');
    });

    it('registers group for composite JID', async () => {
      await channel.connect();
      vi.mocked(opts.registerGroup).mockClear();

      const { InboundMessage } = await import('../bus/index.js');
      opts.messageBus.on(InboundMessage, () => {
        setTimeout(() => channel.sendMessage('web:ui:conv-1', 'ok'), 10);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'test', conversation_id: 'conv-1' }),
      });

      await res.text();

      expect(opts.registerGroup).toHaveBeenCalledWith(
        'web:ui:conv-1',
        expect.objectContaining({ name: 'Web UI', folder: 'main', requiresTrigger: false }),
      );
    });

    it('works without conversation_id (backward compat)', async () => {
      await channel.connect();

      const { InboundMessage } = await import('../bus/index.js');
      opts.messageBus.on(InboundMessage, (event) => {
        expect(event.message.chat_jid).toBe('web:ui');
        setTimeout(() => channel.sendMessage('web:ui', 'ok'), 10);
      });

      const res = await fetch(buildUrl(channel, '/message'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'no convo id' }),
      });

      await res.text();
    });
  });

  describe('GET /conversations', () => {
    it('returns list of conversations', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/conversations'));
      const body = (await res.json()) as { conversations: Array<{ id: string }> };

      expect(res.status).toBe(200);
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].id).toBe('conv-1');
    });
  });

  describe('POST /conversations', () => {
    it('creates a new conversation', async () => {
      await channel.connect();
      const { upsertConversation } = await import('../db/index.js');

      const res = await fetch(buildUrl(channel, '/conversations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'my-conv', title: 'My Conversation' }),
      });

      const body = (await res.json()) as { id: string };
      expect(res.status).toBe(201);
      expect(body.id).toBe('my-conv');
      expect(upsertConversation).toHaveBeenCalledWith('my-conv', 'My Conversation', '');
    });

    it('generates id if not provided', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/conversations'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Auto ID' }),
      });

      const body = (await res.json()) as { id: string };
      expect(res.status).toBe(201);
      expect(body.id).toBeTruthy();
      expect(typeof body.id).toBe('string');
    });
  });

  describe('PATCH /conversations/:id', () => {
    it('renames a conversation', async () => {
      await channel.connect();
      const { renameConversation } = await import('../db/index.js');

      const res = await fetch(buildUrl(channel, '/conversations/conv-1'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Renamed' }),
      });

      expect(res.status).toBe(200);
      expect(renameConversation).toHaveBeenCalledWith('conv-1', 'Renamed');
    });

    it('returns 400 for missing title', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/conversations/conv-1'), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /conversations/:id', () => {
    it('deletes conversation and messages', async () => {
      await channel.connect();
      const { deleteConversation } = await import('../db/index.js');

      const res = await fetch(buildUrl(channel, '/conversations/conv-1'), {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      expect(deleteConversation).toHaveBeenCalledWith('conv-1');
    });

    it('returns 200 for non-existent (idempotent)', async () => {
      await channel.connect();

      const res = await fetch(buildUrl(channel, '/conversations/nope'), {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
    });
  });
});
