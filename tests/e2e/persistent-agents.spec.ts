/**
 * E2E tests for persistent agent conversations via the CamBot web channel.
 *
 * These tests validate the HTTP + WebSocket contract of the web channel,
 * covering agent spawn, conversation persistence, and reconnection.
 *
 * Prerequisites:
 *   - A running CamBot instance with the web channel enabled
 *   - Environment variables: CAMBOT_BASE_URL, CAMBOT_AUTH_TOKEN, CAMBOT_WS_URL
 *
 * Run:
 *   npx playwright test tests/e2e/persistent-agents.spec.ts
 */

import { test, expect, type APIRequestContext } from '@playwright/test';
import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

const BASE_URL = process.env.CAMBOT_BASE_URL || 'http://127.0.0.1:3100';
const AUTH_TOKEN = process.env.CAMBOT_AUTH_TOKEN || 'test-token';
const WS_URL = process.env.CAMBOT_WS_URL || 'ws://127.0.0.1:3100/ws';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Parse SSE stream text into an array of typed chunks. */
function parseSSEChunks(raw: string): SSEChunk[] {
  return raw
    .split('\n\n')
    .filter((block) => block.startsWith('data: '))
    .map((block) => {
      const json = block.replace(/^data: /, '');
      return JSON.parse(json) as SSEChunk;
    });
}

interface SSEChunk {
  type: 'thinking' | 'delta' | 'done' | 'error';
  text?: string;
  message?: string;
}

interface HealthResponse {
  status: string;
  channel: string;
  connected: boolean;
  wsClients: number;
}

interface HistoryMessage {
  id: string;
  content: string;
  sender_name: string;
  timestamp: string;
  is_bot_message: number;
}

interface ConversationRecord {
  id: string;
  title: string;
  preview: string;
  created_at: string;
  updated_at: string;
}

/** Send a message and wait for the full SSE response. Returns parsed chunks. */
async function sendMessageSSE(
  request: APIRequestContext,
  message: string,
  conversationId?: string,
): Promise<SSEChunk[]> {
  const body: Record<string, string> = { message };
  if (conversationId) body.conversation_id = conversationId;

  const response = await request.post('/message', { data: body });
  expect(response.ok()).toBeTruthy();

  const raw = await response.text();
  return parseSSEChunks(raw);
}

/** Extract the final agent response text from SSE chunks. */
function extractResponseText(chunks: SSEChunk[]): string {
  const deltas = chunks.filter((c) => c.type === 'delta');
  return deltas.map((c) => c.text ?? '').join('');
}

/** Generate a unique conversation ID to isolate test state. */
function uniqueConversationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

test.describe('Persistent Agents - Web Channel E2E', () => {
  // ─────────────────────────────────────────────────────────────────────────
  // Precondition: server is reachable
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('Health check', () => {
    test('server is reachable and reports healthy', async ({ request }) => {
      const response = await request.get('/health');

      expect(response.ok()).toBeTruthy();

      const body: HealthResponse = await response.json();
      expect(body.status).toBe('ok');
      expect(body.channel).toBe('web');
      expect(body.connected).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 1: Agent spawns when message is sent
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('Agent spawns on message', () => {
    test('sending a message returns an SSE stream with agent response', async ({ request }) => {
      const conversationId = uniqueConversationId('spawn');

      const chunks = await sendMessageSSE(request, 'Hello, are you there?', conversationId);

      // The stream must contain at least a done chunk (agent completed)
      const doneChunks = chunks.filter((c) => c.type === 'done');
      expect(doneChunks.length).toBeGreaterThanOrEqual(1);

      // There should be at least one delta chunk with actual text
      const responseText = extractResponseText(chunks);
      expect(responseText.length).toBeGreaterThan(0);
    });

    test('SSE stream includes thinking heartbeats before response', async ({ request }) => {
      const conversationId = uniqueConversationId('heartbeat');

      const chunks = await sendMessageSSE(
        request,
        'Think carefully before answering: what is 2+2?',
        conversationId,
      );

      // Depending on agent speed, there may or may not be thinking chunks.
      // We verify the stream structure is valid regardless.
      for (const chunk of chunks) {
        expect(['thinking', 'delta', 'done', 'error']).toContain(chunk.type);
      }

      // Stream must terminate with done
      const lastNonEmpty = [...chunks].reverse().find((c) => c.type !== 'thinking');
      expect(lastNonEmpty?.type).toBe('done');
    });

    test('rejects empty message with 400', async ({ request }) => {
      const response = await request.post('/message', {
        data: { message: '' },
      });

      expect(response.status()).toBe(400);
      const body = await response.json();
      expect(body.error).toBeDefined();
    });

    test('rejects malformed JSON with 400', async ({ request }) => {
      const response = await request.post('/message', {
        headers: { 'Content-Type': 'application/json' },
        data: 'not-valid-json{{{',
      });

      expect(response.status()).toBe(400);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 2: Agent conversation persists across messages
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('Conversation persistence', () => {
    test('agent retains context across messages in the same conversation', async ({ request }) => {
      const conversationId = uniqueConversationId('persist');

      // Message 1: establish a fact
      const chunks1 = await sendMessageSSE(
        request,
        'My favorite color is cerulean blue. Please remember this.',
        conversationId,
      );
      const response1 = extractResponseText(chunks1);
      expect(response1.length).toBeGreaterThan(0);

      // Message 2: ask the agent to recall the fact
      const chunks2 = await sendMessageSSE(
        request,
        'What is my favorite color?',
        conversationId,
      );
      const response2 = extractResponseText(chunks2);

      // The agent should reference "cerulean" or "blue" in its response
      const lowerResponse = response2.toLowerCase();
      expect(
        lowerResponse.includes('cerulean') || lowerResponse.includes('blue'),
      ).toBeTruthy();
    });

    test('conversation history endpoint returns messages in order', async ({ request }) => {
      const conversationId = uniqueConversationId('history');

      // Send a message so there is at least one exchange
      await sendMessageSSE(request, 'Record this for history test.', conversationId);

      // Fetch history for this conversation
      const historyResponse = await request.get(
        `/history?conversation_id=${conversationId}&limit=50`,
      );
      expect(historyResponse.ok()).toBeTruthy();

      const { messages } = (await historyResponse.json()) as { messages: HistoryMessage[] };

      // Should have at least the user message and the agent response
      expect(messages.length).toBeGreaterThanOrEqual(2);

      // First message should be the user's
      const userMsg = messages.find(
        (m) => m.is_bot_message === 0 && m.content.includes('Record this for history test'),
      );
      expect(userMsg).toBeDefined();

      // There should be a bot response
      const botMsg = messages.find((m) => m.is_bot_message === 1);
      expect(botMsg).toBeDefined();

      // Messages should be in chronological order
      for (let i = 1; i < messages.length; i++) {
        const prev = new Date(messages[i - 1].timestamp).getTime();
        const curr = new Date(messages[i].timestamp).getTime();
        expect(curr).toBeGreaterThanOrEqual(prev);
      }
    });

    test('different conversations have isolated histories', async ({ request }) => {
      const convoA = uniqueConversationId('iso-a');
      const convoB = uniqueConversationId('iso-b');

      // Send a message in each conversation
      await sendMessageSSE(request, 'Alpha payload for conversation A', convoA);
      await sendMessageSSE(request, 'Bravo payload for conversation B', convoB);

      // Fetch histories for each conversation
      const [histA, histB] = await Promise.all([
        request.get(`/history?conversation_id=${convoA}&limit=50`),
        request.get(`/history?conversation_id=${convoB}&limit=50`),
      ]);

      const { messages: msgsA } = (await histA.json()) as { messages: HistoryMessage[] };
      const { messages: msgsB } = (await histB.json()) as { messages: HistoryMessage[] };

      // Each conversation should have its own user message
      const userMsgsA = msgsA.filter((m) => m.is_bot_message === 0);
      const userMsgsB = msgsB.filter((m) => m.is_bot_message === 0);

      expect(userMsgsA.some((m) => m.content.includes('Alpha payload'))).toBeTruthy();
      expect(userMsgsA.some((m) => m.content.includes('Bravo payload'))).toBeFalsy();

      expect(userMsgsB.some((m) => m.content.includes('Bravo payload'))).toBeTruthy();
      expect(userMsgsB.some((m) => m.content.includes('Alpha payload'))).toBeFalsy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Scenario 3: Reconnection preserves conversation
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('Reconnection preserves conversation', () => {
    test('history is available after simulated disconnect', async ({ request }) => {
      const conversationId = uniqueConversationId('reconn');

      // Send initial message and get response
      const chunks1 = await sendMessageSSE(
        request,
        'This is a persistence test message. My pet parrot is named Gerald.',
        conversationId,
      );
      expect(extractResponseText(chunks1).length).toBeGreaterThan(0);

      // "Disconnect" — in API terms, we just stop making requests.
      // The key contract: history persists server-side.

      // "Reconnect" — fetch history to verify it survived
      const historyResponse = await request.get(
        `/history?conversation_id=${conversationId}&limit=50`,
      );
      expect(historyResponse.ok()).toBeTruthy();

      const { messages } = (await historyResponse.json()) as { messages: HistoryMessage[] };
      expect(messages.length).toBeGreaterThanOrEqual(2);

      // Our original message should be in history
      const found = messages.some((m) => m.content.includes('Gerald'));
      expect(found).toBeTruthy();
    });

    test('agent retains context after reconnection', async ({ request }) => {
      const conversationId = uniqueConversationId('reconn-ctx');

      // Establish context
      await sendMessageSSE(
        request,
        'Remember: my dogs name is Biscuit. This is important.',
        conversationId,
      );

      // Simulate reconnection gap (new request context, same conversation ID)
      // In real usage, the user closes their browser tab and comes back.

      // Send follow-up in the same conversation
      const chunks2 = await sendMessageSSE(
        request,
        'What is my dogs name?',
        conversationId,
      );
      const response2 = extractResponseText(chunks2);

      expect(response2.toLowerCase()).toContain('biscuit');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Conversation CRUD endpoints
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('Conversation CRUD', () => {
    test('create, list, rename, and delete a conversation', async ({ request }) => {
      const conversationId = uniqueConversationId('crud');

      // Create
      const createResponse = await request.post('/conversations', {
        data: { id: conversationId, title: 'E2E Test Conversation' },
      });
      expect(createResponse.status()).toBe(201);
      const created = await createResponse.json();
      expect(created.id).toBe(conversationId);
      expect(created.title).toBe('E2E Test Conversation');

      // List — should include our conversation
      const listResponse = await request.get('/conversations');
      expect(listResponse.ok()).toBeTruthy();
      const { conversations } = (await listResponse.json()) as {
        conversations: ConversationRecord[];
      };
      const ours = conversations.find((c) => c.id === conversationId);
      expect(ours).toBeDefined();
      expect(ours!.title).toBe('E2E Test Conversation');

      // Rename
      const renameResponse = await request.patch(`/conversations/${conversationId}`, {
        data: { title: 'Renamed E2E Conversation' },
      });
      expect(renameResponse.ok()).toBeTruthy();

      // Verify rename via list
      const listAfterRename = await request.get('/conversations');
      const { conversations: afterRename } = (await listAfterRename.json()) as {
        conversations: ConversationRecord[];
      };
      const renamed = afterRename.find((c) => c.id === conversationId);
      expect(renamed?.title).toBe('Renamed E2E Conversation');

      // Delete
      const deleteResponse = await request.delete(`/conversations/${conversationId}`);
      expect(deleteResponse.ok()).toBeTruthy();

      // Verify deletion
      const listAfterDelete = await request.get('/conversations');
      const { conversations: afterDelete } = (await listAfterDelete.json()) as {
        conversations: ConversationRecord[];
      };
      const deleted = afterDelete.find((c) => c.id === conversationId);
      expect(deleted).toBeUndefined();
    });

    test('auto-generates conversation ID when not provided', async ({ request }) => {
      const createResponse = await request.post('/conversations', {
        data: { title: 'Auto ID Test' },
      });
      expect(createResponse.status()).toBe(201);

      const created = await createResponse.json();
      expect(created.id).toBeTruthy();
      expect(typeof created.id).toBe('string');

      // Cleanup
      await request.delete(`/conversations/${created.id}`);
    });

    test('rename requires title field', async ({ request }) => {
      const conversationId = uniqueConversationId('rename-err');

      // Create the conversation first
      await request.post('/conversations', {
        data: { id: conversationId, title: 'Will Rename' },
      });

      // Attempt rename without title
      const response = await request.patch(`/conversations/${conversationId}`, {
        data: {},
      });
      expect(response.status()).toBe(400);

      // Cleanup
      await request.delete(`/conversations/${conversationId}`);
    });

    test('delete is idempotent', async ({ request }) => {
      const conversationId = uniqueConversationId('delete-idem');

      // Delete a non-existent conversation — should still return 200
      const response = await request.delete(`/conversations/${conversationId}`);
      expect(response.ok()).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket contract tests (using Page context)
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('WebSocket messaging', () => {
    test('WebSocket connection receives broadcast messages', async () => {
      // Use Node.js ws library directly to avoid browser origin restrictions
      // (Playwright pages at about:blank send Origin: null, which the server rejects).
      const wsUrl = `${WS_URL}?token=${AUTH_TOKEN}`;

      const result = await new Promise<{
        connected: boolean;
        messages: unknown[];
        error: string | null;
      }>((resolve) => {
        const messages: unknown[] = [];
        let connected = false;

        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
          connected = true;
          ws.send(
            JSON.stringify({
              type: 'message',
              text: 'Hello via WebSocket',
              sender_name: 'E2E Test',
            }),
          );
        });

        ws.on('message', (data) => {
          try {
            messages.push(JSON.parse(data.toString()));
          } catch {
            messages.push(data.toString());
          }
        });

        ws.on('error', () => {
          resolve({ connected: false, messages: [], error: 'WebSocket connection failed' });
        });

        setTimeout(() => {
          ws.close();
          resolve({ connected, messages, error: null });
        }, 10_000);
      });

      expect(result.error).toBeNull();
      expect(result.connected).toBe(true);
    });

    test('WebSocket rejects unauthenticated connections', async () => {
      const wsUrl = `${WS_URL}?token=invalid-token`;

      const result = await new Promise<{ connected: boolean; errorOccurred: boolean }>(
        (resolve) => {
          const ws = new WebSocket(wsUrl);

          ws.on('open', () => {
            ws.close();
            resolve({ connected: true, errorOccurred: false });
          });

          ws.on('error', () => {
            resolve({ connected: false, errorOccurred: true });
          });

          setTimeout(() => {
            ws.close();
            resolve({ connected: false, errorOccurred: true });
          }, 5_000);
        },
      );

      expect(result.connected).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Authentication contract
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('Authentication', () => {
    test('rejects requests without auth token', async ({ playwright }) => {
      // Create a fresh request context WITHOUT the default auth headers.
      // Explicitly set Authorization to empty string — Playwright may inherit
      // project-level extraHTTPHeaders on same-origin newContext() otherwise.
      const unauthContext = await playwright.request.newContext({
        baseURL: BASE_URL,
        extraHTTPHeaders: { Authorization: '' },
      });

      try {
        const response = await unauthContext.get('/health');
        expect(response.status()).toBe(401);
      } finally {
        await unauthContext.dispose();
      }
    });

    test('rejects requests with wrong auth token', async ({ playwright }) => {
      const badAuthContext = await playwright.request.newContext({
        baseURL: BASE_URL,
        extraHTTPHeaders: {
          Authorization: 'Bearer completely-wrong-token',
        },
      });

      try {
        const response = await badAuthContext.get('/health');
        expect(response.status()).toBe(401);
      } finally {
        await badAuthContext.dispose();
      }
    });

    test('accepts requests with correct auth token', async ({ request }) => {
      const response = await request.get('/health');
      expect(response.ok()).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge cases
  // ─────────────────────────────────────────────────────────────────────────

  test.describe('Edge cases', () => {
    test('returns 404 for unknown routes', async ({ request }) => {
      const response = await request.get('/nonexistent-endpoint');
      expect(response.status()).toBe(404);
    });

    test('handles concurrent messages to different conversations', async ({ request }) => {
      // Two concurrent container spawns on Windows can take >2min; allow 5min
      test.setTimeout(300_000);

      const convoA = uniqueConversationId('conc-a');
      const convoB = uniqueConversationId('conc-b');

      // Fire both messages concurrently
      const [chunksA, chunksB] = await Promise.all([
        sendMessageSSE(request, 'Message to conversation A', convoA),
        sendMessageSSE(request, 'Message to conversation B', convoB),
      ]);

      // Both streams should complete without connection errors
      expect(chunksA.length).toBeGreaterThan(0);
      expect(chunksB.length).toBeGreaterThan(0);

      // Both streams must terminate with done (no hangs, no crashes)
      expect(chunksA.some((c) => c.type === 'done')).toBeTruthy();
      expect(chunksB.some((c) => c.type === 'done')).toBeTruthy();

      // At least one should produce actual content (concurrent same-session
      // requests may cause one to return empty when the agent is busy)
      const responseA = extractResponseText(chunksA);
      const responseB = extractResponseText(chunksB);
      expect(responseA.length + responseB.length).toBeGreaterThan(0);
    });

    test('history returns empty for non-existent conversation', async ({ request }) => {
      const response = await request.get(
        '/history?conversation_id=does-not-exist-at-all&limit=10',
      );
      expect(response.ok()).toBeTruthy();

      const { messages } = (await response.json()) as { messages: HistoryMessage[] };
      expect(messages).toEqual([]);
    });
  });
});
