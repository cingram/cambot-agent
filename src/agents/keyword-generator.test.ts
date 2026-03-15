import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../config/env.js', () => ({
  readEnvFile: vi.fn().mockReturnValue({ ANTHROPIC_API_KEY: 'test-key' }),
}));

import { generateRoutingKeywords, type RoutingKeywords } from './keyword-generator.js';

function mockFetch(keywords: RoutingKeywords) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({
      content: [{ type: 'text', text: JSON.stringify(keywords) }],
    }),
  });
}

describe('generateRoutingKeywords', () => {
  afterEach(() => vi.restoreAllMocks());

  it('generates words and phrases from Sonnet response', async () => {
    const expected: RoutingKeywords = {
      words: ['inbox', 'email', 'gmail', 'compose', 'triage'],
      phrases: ['clean up my inbox', 'check my email'],
    };
    globalThis.fetch = mockFetch(expected) as typeof fetch;

    const result = await generateRoutingKeywords(
      { credentials: { apiKey: 'test-key' } },
      { name: 'Email Agent', description: 'Manages email', capabilities: ['email'] },
    );

    expect(result.words).toEqual(expected.words);
    expect(result.phrases).toEqual(expected.phrases);
  });

  it('lowercases all words and phrases', async () => {
    globalThis.fetch = mockFetch({
      words: ['INBOX', 'Email', 'GMAIL'],
      phrases: ['Clean Up My Inbox'],
    }) as typeof fetch;

    const result = await generateRoutingKeywords(
      { credentials: { apiKey: 'test-key' } },
      { name: 'Email Agent', description: 'Email', capabilities: [] },
    );

    expect(result.words).toEqual(['inbox', 'email', 'gmail']);
    expect(result.phrases).toEqual(['clean up my inbox']);
  });

  it('filters out short words (< 3 chars)', async () => {
    globalThis.fetch = mockFetch({
      words: ['ok', 'to', 'inbox', 'email'],
      phrases: ['check mail'],
    }) as typeof fetch;

    const result = await generateRoutingKeywords(
      { credentials: { apiKey: 'test-key' } },
      { name: 'Test', description: 'Test', capabilities: [] },
    );

    expect(result.words).toEqual(['inbox', 'email']);
  });

  it('filters out single-word "phrases"', async () => {
    globalThis.fetch = mockFetch({
      words: ['inbox'],
      phrases: ['singleword', 'check my email'],
    }) as typeof fetch;

    const result = await generateRoutingKeywords(
      { credentials: { apiKey: 'test-key' } },
      { name: 'Test', description: 'Test', capabilities: [] },
    );

    expect(result.phrases).toEqual(['check my email']);
  });

  it('handles markdown fences in response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: '```json\n{"words":["inbox"],"phrases":["check mail"]}\n```' }],
      }),
    }) as typeof fetch;

    const result = await generateRoutingKeywords(
      { credentials: { apiKey: 'test-key' } },
      { name: 'Test', description: 'Test', capabilities: [] },
    );

    expect(result.words).toEqual(['inbox']);
    expect(result.phrases).toEqual(['check mail']);
  });

  it('returns empty on API error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as typeof fetch;

    const result = await generateRoutingKeywords(
      { credentials: { apiKey: 'test-key' } },
      { name: 'Test', description: 'Test', capabilities: [] },
    );

    expect(result.words).toEqual([]);
    expect(result.phrases).toEqual([]);
  });

  it('returns empty on invalid JSON response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        content: [{ type: 'text', text: 'not valid json' }],
      }),
    }) as typeof fetch;

    const result = await generateRoutingKeywords(
      { credentials: { apiKey: 'test-key' } },
      { name: 'Test', description: 'Test', capabilities: [] },
    );

    expect(result.words).toEqual([]);
    expect(result.phrases).toEqual([]);
  });

  it('sends correct API request body', async () => {
    const fetchSpy = mockFetch({ words: ['test'], phrases: ['test phrase'] });
    globalThis.fetch = fetchSpy as typeof fetch;

    await generateRoutingKeywords(
      { credentials: { apiKey: 'my-key' }, model: 'claude-sonnet-4-6' },
      { name: 'Research Agent', description: 'Does research', capabilities: ['websearch'] },
    );

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(opts.headers['x-api-key']).toBe('my-key');
    const body = JSON.parse(opts.body);
    expect(body.model).toBe('claude-sonnet-4-6');
    expect(body.messages[0].content).toContain('Research Agent');
    expect(body.messages[0].content).toContain('Does research');
    expect(body.messages[0].content).toContain('websearch');
  });
});
