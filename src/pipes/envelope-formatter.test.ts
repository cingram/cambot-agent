import { describe, it, expect } from 'vitest';
import { formatEnvelope } from './envelope-formatter.js';
import type { ContentEnvelope } from './content-pipe.js';

function makeEnvelope(overrides: Partial<ContentEnvelope> = {}): ContentEnvelope {
  return {
    id: 'test-123',
    source: 'alice@example.com',
    channel: 'email',
    receivedAt: '2026-03-05T12:00:00Z',
    metadata: { Subject: 'Hello', From: 'alice@example.com' },
    summary: 'Alice says hello.',
    intent: 'info',
    safetyFlags: [],
    rawAvailable: true,
    ...overrides,
  };
}

describe('formatEnvelope', () => {
  it('formats clean envelope with metadata and summary', () => {
    const result = formatEnvelope(makeEnvelope());

    expect(result).toContain('[EMAIL from alice@example.com');
    expect(result).toContain('Subject: Hello');
    expect(result).toContain('From: alice@example.com');
    expect(result).toContain('Intent: info');
    expect(result).toContain('Summary: Alice says hello.');
    expect(result).toContain('Content ID: test-123');
    expect(result).toContain('Safety: clean');
  });

  it('shows safety flags with max severity', () => {
    const result = formatEnvelope(makeEnvelope({
      safetyFlags: [
        { severity: 'medium', category: 'prompt-injection', description: 'Found instruction' },
        { severity: 'high', category: 'social-engineering', description: 'Urgency tactic' },
      ],
    }));

    expect(result).toContain('Safety: HIGH');
    expect(result).toContain('prompt-injection');
    expect(result).toContain('social-engineering');
    expect(result).not.toContain('Safety: clean');
  });

  it('deduplicates safety flag categories', () => {
    const result = formatEnvelope(makeEnvelope({
      safetyFlags: [
        { severity: 'low', category: 'prompt-injection', description: 'A' },
        { severity: 'low', category: 'prompt-injection', description: 'B' },
      ],
    }));

    const matches = result.match(/prompt-injection/g);
    expect(matches).toHaveLength(1);
  });

  it('omits content ID line when rawAvailable is false', () => {
    const result = formatEnvelope(makeEnvelope({ rawAvailable: false }));
    expect(result).not.toContain('Content ID');
  });

  it('uppercases channel tag', () => {
    const result = formatEnvelope(makeEnvelope({ channel: 'rss' }));
    expect(result).toContain('[RSS from');
  });

  it('shows critical severity first', () => {
    const result = formatEnvelope(makeEnvelope({
      safetyFlags: [
        { severity: 'low', category: 'a', description: 'x' },
        { severity: 'critical', category: 'b', description: 'y' },
      ],
    }));
    expect(result).toContain('Safety: CRITICAL');
  });
});
