/**
 * E2E tests for the Agent & Template REST API.
 *
 * Covers CRUD operations, validation, channel exclusivity,
 * folder uniqueness, tool policies, and auth enforcement.
 *
 * Run:
 *   CAMBOT_AUTH_TOKEN=<token> npx playwright test tests/e2e/agent-api.spec.ts
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_URL = process.env.CAMBOT_BASE_URL || 'http://127.0.0.1:3100';
const AUTH_TOKEN = process.env.CAMBOT_AUTH_TOKEN || 'test-token';

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Agent CRUD
// ---------------------------------------------------------------------------

test.describe('Agent API — CRUD', () => {
  let agentId: string;
  let folder: string;

  test.beforeAll(() => {
    agentId = uniqueId('qa');
    folder = uniqueId('qa-folder');
  });

  test.afterAll(async ({ request }) => {
    // Cleanup — ignore errors if already deleted
    await request.delete(`/api/agents/${agentId}`);
  });

  test('POST /api/agents — create agent with all fields', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: {
        id: agentId,
        name: 'QA Agent',
        description: 'E2E test agent',
        folder,
        channels: [],
        mcpServers: ['workspace-mcp'],
        capabilities: ['browser'],
        concurrency: 2,
        timeoutMs: 60000,
        provider: 'openai',
        model: 'gpt-4o',
        secretKeys: ['OPENAI_API_KEY'],
        tools: ['web_search'],
        systemPrompt: 'You are a QA helper.',
        temperature: 0.7,
        maxTokens: 4096,
        baseUrl: 'https://api.openai.com',
      },
    });

    expect(res.status()).toBe(201);
    const body = await res.json();

    expect(body.id).toBe(agentId);
    expect(body.name).toBe('QA Agent');
    expect(body.description).toBe('E2E test agent');
    expect(body.folder).toBe(folder);
    expect(body.channels).toEqual([]);
    expect(body.mcpServers).toEqual(['workspace-mcp']);
    expect(body.capabilities).toEqual(['browser']);
    expect(body.concurrency).toBe(2);
    expect(body.timeoutMs).toBe(60000);
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-4o');
    expect(body.secretKeys).toEqual(['OPENAI_API_KEY']);
    expect(body.tools).toEqual(['web_search']);
    expect(body.systemPrompt).toBe('You are a QA helper.');
    expect(body.temperature).toBe(0.7);
    expect(body.maxTokens).toBe(4096);
    expect(body.baseUrl).toBe('https://api.openai.com');
    expect(body.createdAt).toBeTruthy();
    expect(body.updatedAt).toBeTruthy();
  });

  test('GET /api/agents/:id — retrieve created agent', async ({ request }) => {
    const res = await request.get(`/api/agents/${agentId}`);
    expect(res.status()).toBe(200);

    const body = await res.json();
    expect(body.id).toBe(agentId);
    expect(body.name).toBe('QA Agent');
  });

  test('GET /api/agents — list includes created agent', async ({ request }) => {
    const res = await request.get('/api/agents');
    expect(res.ok()).toBeTruthy();

    const { agents } = await res.json();
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.some((a: { id: string }) => a.id === agentId)).toBe(true);
  });

  test('PUT /api/agents/:id — partial update preserves other fields', async ({ request }) => {
    const res = await request.put(`/api/agents/${agentId}`, {
      data: { name: 'Updated QA Agent', concurrency: 5 },
    });

    expect(res.status()).toBe(200);
    const body = await res.json();

    expect(body.name).toBe('Updated QA Agent');
    expect(body.concurrency).toBe(5);
    // Unchanged fields preserved
    expect(body.description).toBe('E2E test agent');
    expect(body.provider).toBe('openai');
    expect(body.model).toBe('gpt-4o');
    expect(body.folder).toBe(folder);
  });

  test('PUT /api/agents/:id — updatedAt changes on update', async ({ request }) => {
    const before = await (await request.get(`/api/agents/${agentId}`)).json();

    const res = await request.put(`/api/agents/${agentId}`, {
      data: { description: 'Timestamp check' },
    });
    const after = await res.json();

    expect(after.updatedAt >= before.updatedAt).toBe(true);
  });

  test('DELETE /api/agents/:id — removes agent', async ({ request }) => {
    const res = await request.delete(`/api/agents/${agentId}`);
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Verify gone
    const getRes = await request.get(`/api/agents/${agentId}`);
    expect(getRes.status()).toBe(404);
  });

  test('DELETE /api/agents/:id — idempotent (404 for missing)', async ({ request }) => {
    const res = await request.delete(`/api/agents/${agentId}`);
    expect(res.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Agent Validation
// ---------------------------------------------------------------------------

test.describe('Agent API — Validation', () => {
  test('rejects missing required fields', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { name: 'No ID or folder' },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('required');
  });

  test('rejects concurrency < 1', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { id: uniqueId('c'), name: 'Bad', folder: uniqueId('f'), concurrency: 0 },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('concurrency');
  });

  test('rejects timeoutMs < 1000', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { id: uniqueId('t'), name: 'Bad', folder: uniqueId('f'), timeoutMs: 500 },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('timeoutMs');
  });

  test('rejects invalid JSON body', async ({ request }) => {
    const res = await request.post('/api/agents', {
      headers: { 'Content-Type': 'application/json' },
      data: 'not-json{{{',
    });
    expect(res.status()).toBe(400);
  });

  test('returns 404 for GET on missing agent', async ({ request }) => {
    const res = await request.get('/api/agents/nonexistent-agent');
    expect(res.status()).toBe(404);
  });

  test('returns 400 for PUT on missing agent', async ({ request }) => {
    const res = await request.put('/api/agents/nonexistent-agent', {
      data: { name: 'Ghost' },
    });
    expect(res.status()).toBe(400);
  });

  test('returns 404 for unknown /api/ path', async ({ request }) => {
    const res = await request.get('/api/unknown-route');
    expect(res.status()).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Channel Exclusivity & Folder Uniqueness
// ---------------------------------------------------------------------------

test.describe('Agent API — Constraints', () => {
  const ownerAgent = uniqueId('owner');
  const ownerFolder = uniqueId('owner-f');

  test.beforeAll(async ({ request }) => {
    await request.post('/api/agents', {
      data: { id: ownerAgent, name: 'Owner', folder: ownerFolder, channels: ['telegram'] },
    });
  });

  test.afterAll(async ({ request }) => {
    await request.delete(`/api/agents/${ownerAgent}`);
  });

  test('rejects duplicate channel on create', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { id: uniqueId('dup'), name: 'Dup', folder: uniqueId('f'), channels: ['telegram'] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('telegram');
  });

  test('rejects duplicate folder on create', async ({ request }) => {
    const res = await request.post('/api/agents', {
      data: { id: uniqueId('dup'), name: 'Dup', folder: ownerFolder },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain(ownerFolder);
  });

  test('rejects channel steal on update', async ({ request }) => {
    const thief = uniqueId('thief');
    await request.post('/api/agents', {
      data: { id: thief, name: 'Thief', folder: uniqueId('f') },
    });

    const res = await request.put(`/api/agents/${thief}`, {
      data: { channels: ['telegram'] },
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('telegram');

    await request.delete(`/api/agents/${thief}`);
  });

  test('allows owner to keep its own channel on update', async ({ request }) => {
    const res = await request.put(`/api/agents/${ownerAgent}`, {
      data: { channels: ['telegram', 'discord'] },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).channels).toEqual(['telegram', 'discord']);
  });
});

// ---------------------------------------------------------------------------
// Tool Policy & Container Config
// ---------------------------------------------------------------------------

test.describe('Agent API — Tool Policy & Container Config', () => {
  test('persists and retrieves toolPolicy', async ({ request }) => {
    const id = uniqueId('policy');
    const res = await request.post('/api/agents', {
      data: {
        id,
        name: 'Policy Agent',
        folder: uniqueId('f'),
        toolPolicy: { preset: 'readonly', add: ['Bash'], deny: ['WebFetch'] },
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.toolPolicy).toEqual({ preset: 'readonly', add: ['Bash'], deny: ['WebFetch'] });

    await request.delete(`/api/agents/${id}`);
  });

  test('persists and retrieves containerConfig', async ({ request }) => {
    const id = uniqueId('container');
    const res = await request.post('/api/agents', {
      data: {
        id,
        name: 'Container Agent',
        folder: uniqueId('f'),
        containerConfig: {
          additionalMounts: [{ hostPath: 'C:/data', containerPath: 'data', readonly: true }],
          timeout: 600000,
        },
      },
    });
    expect(res.status()).toBe(201);

    const body = await res.json();
    expect(body.containerConfig.additionalMounts).toHaveLength(1);
    expect(body.containerConfig.timeout).toBe(600000);

    await request.delete(`/api/agents/${id}`);
  });
});

// ---------------------------------------------------------------------------
// Template API
// ---------------------------------------------------------------------------

test.describe('Template API', () => {
  test('GET /api/templates — lists templates', async ({ request }) => {
    const res = await request.get('/api/templates');
    expect(res.ok()).toBeTruthy();

    const { templates } = await res.json();
    expect(Array.isArray(templates)).toBe(true);

    // Should have at least identity and soul (seeded on first run)
    const keys = templates.map((t: { key: string }) => t.key);
    expect(keys).toContain('identity');
    expect(keys).toContain('soul');
  });

  test('PUT /api/templates/:key — updates template value', async ({ request }) => {
    // Read original
    const before = await (await request.get('/api/templates')).json();
    const originalSoul = before.templates.find((t: { key: string }) => t.key === 'soul');

    // Update
    const res = await request.put('/api/templates/soul', {
      data: { value: 'QA test soul value' },
    });
    expect(res.status()).toBe(200);
    expect((await res.json()).success).toBe(true);

    // Verify
    const after = await (await request.get('/api/templates')).json();
    const updatedSoul = after.templates.find((t: { key: string }) => t.key === 'soul');
    expect(updatedSoul.value).toBe('QA test soul value');

    // Restore
    if (originalSoul) {
      await request.put('/api/templates/soul', {
        data: { value: originalSoul.value },
      });
    }
  });

  test('PUT /api/templates/:key — rejects missing value', async ({ request }) => {
    const res = await request.put('/api/templates/soul', { data: {} });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain('value');
  });

  test('PUT /api/templates/:key — creates new template', async ({ request }) => {
    const key = uniqueId('qa-template');
    const res = await request.put(`/api/templates/${key}`, {
      data: { value: 'test value' },
    });
    expect(res.status()).toBe(200);

    const all = await (await request.get('/api/templates')).json();
    const created = all.templates.find((t: { key: string }) => t.key === key);
    expect(created).toBeDefined();
    expect(created.value).toBe('test value');
  });
});

// ---------------------------------------------------------------------------
// Authentication enforcement on /api/ routes
// ---------------------------------------------------------------------------

test.describe('Agent API — Auth', () => {
  test('rejects unauthenticated requests', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Authorization: '' },
    });
    try {
      const res = await ctx.get('/api/agents');
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });

  test('rejects wrong token', async ({ playwright }) => {
    const ctx = await playwright.request.newContext({
      baseURL: BASE_URL,
      extraHTTPHeaders: { Authorization: 'Bearer wrong-token' },
    });
    try {
      const res = await ctx.get('/api/agents');
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
