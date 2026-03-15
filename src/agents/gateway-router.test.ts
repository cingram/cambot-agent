import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

import { createGatewayRouter, type GatewayRouter, scoreRoute, scoreContinuation, extractAgentKeywords, type AgentRegistryEntry } from './gateway-router.js';

// Suppress logger output in tests
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

let router: GatewayRouter;

beforeEach(() => {
  router = createGatewayRouter({
    credentials: { apiKey: 'test-key', apiUrl: 'https://test.api/v1/messages' },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── classifyContinuation ─────────────────────────────────────

describe('classifyContinuation', () => {
  it('returns continue when API says continue', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'classify_continuation',
            input: { action: 'continue' },
          },
        ],
      }),
    } as Response);

    const result = await router.classifyContinuation(
      'now archive the ones from last week',
      'email-agent',
      'organize inbox',
    );

    expect(result.action).toBe('continue');
  });

  it('returns pivot when API says pivot', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'classify_continuation',
            input: { action: 'pivot' },
          },
        ],
      }),
    } as Response);

    const result = await router.classifyContinuation(
      'what is the weather today?',
      'email-agent',
      'organize inbox',
    );

    expect(result.action).toBe('pivot');
  });

  it('defaults to continue on API error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('Network error'));

    const result = await router.classifyContinuation(
      'follow up message',
      'email-agent',
      'organize inbox',
    );

    expect(result.action).toBe('continue');
  });

  it('defaults to continue on non-ok response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    const result = await router.classifyContinuation(
      'follow up',
      'email-agent',
      'organize inbox',
    );

    expect(result.action).toBe('continue');
  });

  it('defaults to continue when tool_use is missing from response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'some unexpected text' }],
      }),
    } as Response);

    const result = await router.classifyContinuation(
      'follow up',
      'email-agent',
      null,
    );

    expect(result.action).toBe('continue');
  });

  it('sends correct API payload', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'classify_continuation',
            input: { action: 'continue' },
          },
        ],
      }),
    } as Response);

    await router.classifyContinuation('test message', 'email-agent', 'check emails');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://test.api/v1/messages');

    const body = JSON.parse((opts as RequestInit).body as string);
    expect(body.max_tokens).toBe(256);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].name).toBe('classify_continuation');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'classify_continuation' });
    expect(body.system).toContain('email-agent');
    expect(body.system).toContain('check emails');
  });

  it('uses fallback intent text when intent is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'classify_continuation',
            input: { action: 'continue' },
          },
        ],
      }),
    } as Response);

    await router.classifyContinuation('test', 'agent-a', null);

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body.system).toContain('a task');
  });
});

// ── route ────────────────────────────────────────────────────

describe('route', () => {
  it('returns delegate decision', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'route',
            input: {
              action: 'delegate',
              target_agent: 'email-agent',
              prompt: 'Organize inbox emails from last week',
            },
          },
        ],
      }),
    } as Response);

    const result = await router.route('organize my inbox', [
      { id: 'email-agent', name: 'Email Agent', description: 'Handles email', capabilities: [] },
    ]);

    expect(result.action).toBe('delegate');
    expect(result.targetAgent).toBe('email-agent');
    expect(result.prompt).toBe('Organize inbox emails from last week');
  });

  it('returns respond decision', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [
          {
            type: 'tool_use',
            name: 'route',
            input: {
              action: 'respond',
              response: 'Hello! How can I help you?',
            },
          },
        ],
      }),
    } as Response);

    const result = await router.route('hello', []);

    expect(result.action).toBe('respond');
    expect(result.response).toBe('Hello! How can I help you?');
  });

  it('falls back to error response on network failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('timeout'));

    const result = await router.route('test', []);

    expect(result.action).toBe('respond');
    expect(result.response).toContain('error');
  });
});

// ── Local Scoring ────────────────────────────────────────────

const AGENTS: AgentRegistryEntry[] = [
  { id: 'email-agent', name: 'Email Agent', description: 'Email management', capabilities: ['email'] },
  { id: 'search-agent', name: 'Search Agent', description: 'Web search and research', capabilities: ['WebSearch'] },
  { id: 'scheduler-agent', name: 'Scheduler', description: 'Task scheduling', capabilities: ['scheduling'] },
  { id: 'code-agent', name: 'Code Agent', description: 'Code review and generation', capabilities: ['code'] },
];

describe('extractAgentKeywords', () => {
  it('extracts words from id, name, description, capabilities', () => {
    const kw = extractAgentKeywords(AGENTS[0]);
    expect(kw.has('email')).toBe(true);
    expect(kw.has('management')).toBe(true);
    expect(kw.has('agent')).toBe(true);
  });

  it('expands domain keywords', () => {
    const kw = extractAgentKeywords(AGENTS[0]);
    // 'email' capability should expand to inbox, unread, gmail, etc.
    expect(kw.has('inbox')).toBe(true);
    expect(kw.has('unread')).toBe(true);
    expect(kw.has('gmail')).toBe(true);
  });

  it('handles camelCase capabilities', () => {
    const kw = extractAgentKeywords(AGENTS[1]);
    // WebSearch → web, search + expansions
    expect(kw.has('web')).toBe(true);
    expect(kw.has('search')).toBe(true);
    expect(kw.has('weather')).toBe(true);
  });
});

describe('scoreRoute', () => {
  it('scores greetings as high-confidence respond', () => {
    const result = scoreRoute('hello', AGENTS);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.decision.action).toBe('respond');
  });

  it('scores clear email message as high-confidence delegate', () => {
    const result = scoreRoute('check my inbox for unread emails', AGENTS);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.decision.action).toBe('delegate');
    expect(result.decision.targetAgent).toBe('email-agent');
  });

  it('scores clear search message as high-confidence delegate', () => {
    const result = scoreRoute('search for the latest news about AI', AGENTS);
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.decision.action).toBe('delegate');
    expect(result.decision.targetAgent).toBe('search-agent');
  });

  it('returns low confidence for ambiguous messages', () => {
    // "find that email" matches both search (find) and email (email)
    const result = scoreRoute('find that email', AGENTS);
    expect(result.confidence).toBeLessThan(0.7);
  });

  it('returns zero confidence when no keywords match', () => {
    const result = scoreRoute('the quick brown fox jumped over the lazy dog', AGENTS);
    expect(result.confidence).toBe(0);
  });

  it('scores scheduling messages correctly', () => {
    const result = scoreRoute('schedule a meeting tomorrow at 3pm', AGENTS);
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.decision.targetAgent).toBe('scheduler-agent');
  });
});

describe('scoreContinuation', () => {
  it('scores follow-up words as high-confidence continue', () => {
    const result = scoreContinuation('yes do it', 'email-agent', 'organize inbox', AGENTS);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    expect(result.decision.action).toBe('continue');
  });

  it('scores "also" / "then" as continue', () => {
    const r1 = scoreContinuation('also archive the spam', 'email-agent', 'organize inbox', AGENTS);
    expect(r1.decision.action).toBe('continue');
    expect(r1.confidence).toBeGreaterThanOrEqual(0.9);

    const r2 = scoreContinuation('then mark them as read', 'email-agent', 'organize inbox', AGENTS);
    expect(r2.decision.action).toBe('continue');
  });

  it('scores intent keyword overlap as high-confidence continue', () => {
    const result = scoreContinuation(
      'organize the inbox newsletters too',
      'email-agent',
      'organize inbox emails',
      AGENTS,
    );
    // "organize" and "inbox" overlap with intent → 2 matches
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    expect(result.decision.action).toBe('continue');
  });

  it('scores clear domain pivot as pivot', () => {
    const result = scoreContinuation(
      'what is the weather in Tokyo?',
      'email-agent',
      'organize inbox',
      AGENTS,
    );
    expect(result.decision.action).toBe('pivot');
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('returns low confidence for ambiguous messages', () => {
    // Matches both email (mail) and search (find) — ambiguous
    const result = scoreContinuation(
      'find the mail about the weather report',
      'email-agent',
      'organize inbox',
      AGENTS,
    );
    expect(result.confidence).toBeLessThan(0.7);
  });

  it('returns low confidence when no keywords match at all', () => {
    const result = scoreContinuation(
      'banana smoothie',
      'email-agent',
      'organize inbox',
      AGENTS,
    );
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.decision.action).toBe('continue'); // default
  });
});

// ── AI-Generated Routing Keywords ────────────────────────────

describe('routing with AI-generated keywords', () => {
  const AGENTS_WITH_KEYWORDS: AgentRegistryEntry[] = [
    {
      id: 'email-agent',
      name: 'Email Agent',
      description: 'Email management',
      capabilities: ['email'],
      routingKeywords: {
        words: ['inbox', 'email', 'gmail', 'unread', 'spam', 'newsletter', 'compose', 'triage', 'cleanup'],
        phrases: ['clean up my inbox', 'check my email', 'organize my mail'],
      },
    },
    {
      id: 'finance-agent',
      name: 'Finance Agent',
      description: 'Financial tracking and budgeting',
      capabilities: [],
      routingKeywords: {
        words: ['budget', 'expense', 'expenses', 'spending', 'savings', 'income', 'transaction', 'bank', 'statement'],
        phrases: ['track my spending', 'how much did i spend', 'whats my budget'],
      },
    },
  ];

  it('uses stored keywords instead of domain lexicons', () => {
    const kw = extractAgentKeywords(AGENTS_WITH_KEYWORDS[0]);
    // From routingKeywords
    expect(kw.has('inbox')).toBe(true);
    expect(kw.has('triage')).toBe(true);
    expect(kw.has('cleanup')).toBe(true);
    // From identity tokens (always included)
    expect(kw.has('email')).toBe(true);
    expect(kw.has('agent')).toBe(true);
  });

  it('routes to agent with matching keywords', () => {
    const result = scoreRoute('track my spending this month', AGENTS_WITH_KEYWORDS);
    expect(result.decision.action).toBe('delegate');
    expect(result.decision.targetAgent).toBe('finance-agent');
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('matches stored phrases for higher confidence', () => {
    const result = scoreRoute('how much did i spend on food', AGENTS_WITH_KEYWORDS);
    expect(result.decision.targetAgent).toBe('finance-agent');
    // Phrase match ("how much did i spend") = 2 pts + word matches
    expect(result.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('differentiates agents by custom keywords', () => {
    const emailResult = scoreRoute('check my email for spam', AGENTS_WITH_KEYWORDS);
    const financeResult = scoreRoute('whats my bank statement', AGENTS_WITH_KEYWORDS);

    expect(emailResult.decision.targetAgent).toBe('email-agent');
    expect(financeResult.decision.targetAgent).toBe('finance-agent');
  });

  it('falls back to domain lexicons when no routingKeywords', () => {
    const agentsWithoutKeywords: AgentRegistryEntry[] = [
      { id: 'email-agent', name: 'Email Agent', description: 'Email management', capabilities: ['email'] },
    ];
    const kw = extractAgentKeywords(agentsWithoutKeywords[0]);
    // Should still get domain lexicon expansion
    expect(kw.has('inbox')).toBe(true);
    expect(kw.has('unread')).toBe(true);
  });
});
