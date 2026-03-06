import { describe, it, expect, vi } from 'vitest';
import { createEmailPipe } from './email-pipe.js';
import type { RawContent } from './content-pipe.js';

function makeRaw(overrides: Partial<RawContent> = {}): RawContent {
  return {
    id: 'email-abc',
    channel: 'email',
    source: 'bob@example.com',
    body: 'Hi there, please review the attached report.',
    metadata: { Subject: 'Report', From: 'bob@example.com' },
    receivedAt: '2026-03-05T10:00:00Z',
    ...overrides,
  };
}

function createMockDeps(options: {
  hasInjection?: boolean;
  summarizerResult?: { summary: string; intent: string };
  summarizerError?: boolean;
} = {}) {
  const summarizer = {
    summarize: options.summarizerError
      ? vi.fn().mockRejectedValue(new Error('LLM failed'))
      : vi.fn().mockResolvedValue(
          options.summarizerResult ?? { summary: 'A report review request.', intent: 'request' },
        ),
  };

  const injectionDetector = {
    scan: vi.fn().mockReturnValue({
      matches: options.hasInjection
        ? [{ severity: 'high' as const, category: 'prompt-injection', description: 'Found instruction' }]
        : [],
      hasInjection: options.hasInjection ?? false,
      maxSeverity: options.hasInjection ? 'high' : null,
    }),
    scanMultiple: vi.fn().mockReturnValue({ matches: [], hasInjection: false, maxSeverity: null }),
    getPatterns: vi.fn().mockReturnValue([]),
  };

  const inputSanitizer = {
    sanitizeString: vi.fn((s: string) => ({ value: s, violations: [] })),
    sanitizeParams: vi.fn(),
  };

  return { summarizer, injectionDetector, inputSanitizer };
}

describe('createEmailPipe', () => {
  it('produces a clean envelope for safe content', async () => {
    const deps = createMockDeps();
    const pipe = createEmailPipe(deps);

    const envelope = await pipe.process(makeRaw());

    expect(envelope.id).toBe('email-abc');
    expect(envelope.channel).toBe('email');
    expect(envelope.source).toBe('bob@example.com');
    expect(envelope.summary).toBe('A report review request.');
    expect(envelope.intent).toBe('request');
    expect(envelope.safetyFlags).toHaveLength(0);
    expect(envelope.rawAvailable).toBe(true);
  });

  it('sanitizes body and metadata before scanning', async () => {
    const deps = createMockDeps();
    const pipe = createEmailPipe(deps);

    await pipe.process(makeRaw());

    // Body sanitized
    expect(deps.inputSanitizer.sanitizeString).toHaveBeenCalledWith(
      'Hi there, please review the attached report.',
    );
    // Metadata values sanitized
    expect(deps.inputSanitizer.sanitizeString).toHaveBeenCalledWith('Report');
    expect(deps.inputSanitizer.sanitizeString).toHaveBeenCalledWith('bob@example.com');
  });

  it('adds safety flags when injection detected', async () => {
    const deps = createMockDeps({ hasInjection: true });
    const pipe = createEmailPipe(deps);

    const envelope = await pipe.process(makeRaw());

    expect(envelope.safetyFlags).toHaveLength(1);
    expect(envelope.safetyFlags[0].severity).toBe('high');
    expect(envelope.safetyFlags[0].category).toBe('prompt-injection');
  });

  it('overrides intent to suspicious on high-severity injection', async () => {
    const deps = createMockDeps({
      hasInjection: true,
      summarizerResult: { summary: 'Normal email.', intent: 'info' },
    });
    const pipe = createEmailPipe(deps);

    const envelope = await pipe.process(makeRaw());

    expect(envelope.intent).toBe('suspicious');
  });

  it('passes metadata to summarizer', async () => {
    const deps = createMockDeps();
    const pipe = createEmailPipe(deps);

    await pipe.process(makeRaw({ metadata: { Subject: 'Test' } }));

    expect(deps.summarizer.summarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ Subject: 'Test' }),
    );
  });
});
