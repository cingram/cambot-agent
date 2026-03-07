import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GuardrailReviewer } from './guardrail-reviewer.js';

const mockLogger = { log: vi.fn() };

function createReviewer(overrides?: Partial<ConstructorParameters<typeof GuardrailReviewer>[0]>) {
  return new GuardrailReviewer({
    apiKey: 'test-key',
    logger: mockLogger,
    ...overrides,
  });
}

describe('GuardrailReviewer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('shouldReview', () => {
    it('matches default reviewed tools', () => {
      const reviewer = createReviewer();
      expect(reviewer.shouldReview('send_gmail_message')).toBe(true);
      expect(reviewer.shouldReview('send_slack_message')).toBe(true);
    });

    it('matches default patterns', () => {
      const reviewer = createReviewer();
      expect(reviewer.shouldReview('send_custom_notification')).toBe(true);
      expect(reviewer.shouldReview('post_tweet')).toBe(true);
      expect(reviewer.shouldReview('reply_to_thread')).toBe(true);
      expect(reviewer.shouldReview('forward_email')).toBe(true);
    });

    it('does not match read-only tools', () => {
      const reviewer = createReviewer();
      expect(reviewer.shouldReview('Read')).toBe(false);
      expect(reviewer.shouldReview('Bash')).toBe(false);
      expect(reviewer.shouldReview('search_gmail_messages')).toBe(false);
      expect(reviewer.shouldReview('Glob')).toBe(false);
    });

    it('supports custom reviewed tools', () => {
      const reviewer = createReviewer({
        reviewedTools: ['my_custom_tool'],
        reviewedPatterns: [],
      });
      expect(reviewer.shouldReview('my_custom_tool')).toBe(true);
      expect(reviewer.shouldReview('send_gmail_message')).toBe(false);
    });
  });

  describe('review', () => {
    it('skips review for non-reviewed tools', async () => {
      const reviewer = createReviewer();
      const result = await reviewer.review('Read', { file_path: '/test' });
      expect(result).toEqual({
        allowed: true,
        reason: 'Tool not in reviewed set',
        reviewed: false,
      });
    });

    it('allows when Haiku says ALLOW', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          content: [{ type: 'text', text: 'ALLOW: Normal business reply' }],
        }), { status: 200 }),
      );

      const reviewer = createReviewer();
      const result = await reviewer.review('send_gmail_message', {
        to: 'user@example.com',
        subject: 'Re: Meeting',
        body: 'Sounds good!',
      });

      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('Normal business reply');
      expect(result.reviewed).toBe(true);
      fetchSpy.mockRestore();
    });

    it('denies when Haiku says DENY', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          content: [{ type: 'text', text: 'DENY: Looks like spam content' }],
        }), { status: 200 }),
      );

      const reviewer = createReviewer();
      const result = await reviewer.review('send_gmail_message', {
        to: 'everyone@company.com',
        subject: 'BUY NOW!!!',
        body: 'Amazing deal',
      });

      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('Looks like spam content');
      expect(result.reviewed).toBe(true);
      fetchSpy.mockRestore();
    });

    it('fail-closed on API error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('Internal Server Error', { status: 500 }),
      );

      const reviewer = createReviewer();
      const result = await reviewer.review('send_gmail_message', { to: 'a@b.com' });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('API error: 500');
      expect(result.reviewed).toBe(true);
      fetchSpy.mockRestore();
    });

    it('fail-closed on network error', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Network unreachable'),
      );

      const reviewer = createReviewer();
      const result = await reviewer.review('send_gmail_message', { to: 'a@b.com' });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Network unreachable');
      expect(result.reviewed).toBe(true);
      fetchSpy.mockRestore();
    });

    it('fail-closed on ambiguous response', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          content: [{ type: 'text', text: 'I think this might be okay...' }],
        }), { status: 200 }),
      );

      const reviewer = createReviewer();
      const result = await reviewer.review('send_gmail_message', { to: 'a@b.com' });

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Ambiguous');
      expect(result.reviewed).toBe(true);
      fetchSpy.mockRestore();
    });

    it('truncates large tool inputs', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({
          content: [{ type: 'text', text: 'ALLOW: Reviewed' }],
        }), { status: 200 }),
      );

      const reviewer = createReviewer();
      const largeBody = 'x'.repeat(10_000);
      await reviewer.review('send_gmail_message', { body: largeBody });

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
      const userContent = callBody.messages[0].content;
      expect(userContent.length).toBeLessThan(6000);
      fetchSpy.mockRestore();
    });
  });
});
