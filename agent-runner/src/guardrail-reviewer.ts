/**
 * Inline Haiku Guardrail — reviews high-risk tool calls before execution.
 *
 * Runs inside the agent container as a PreToolUse hook. When the main agent
 * (Sonnet/Opus) tries to call a tool that has external side effects (sending
 * emails, posting messages, etc.), this reviewer calls Haiku to evaluate
 * whether the action is appropriate.
 *
 * Haiku acts as a fast, cheap "supervisor" that can block bad actions before
 * they take effect. The main agent sees the denial and can adjust.
 *
 * Design decisions:
 * - Fail-closed for send actions: if Haiku is unreachable, block the tool
 * - Fail-open for read actions: never reviewed (no side effects)
 * - Uses direct fetch (no SDK dependency) for minimal overhead
 * - ~200ms latency per reviewed call
 */

import type { Logger } from './logger.js';

export interface GuardrailReviewerDeps {
  apiKey: string;
  logger: Logger;
  /** Model to use for review. Default: claude-haiku-4-5-20251001 */
  model?: string;
  /** Tool names that trigger review. Default: send-type tools */
  reviewedTools?: string[];
  /** Tool name patterns (regex) that trigger review. */
  reviewedPatterns?: RegExp[];
  /** Max ms to wait for Haiku response before fail-closed. Default: 5000 */
  timeoutMs?: number;
}

export interface ReviewResult {
  allowed: boolean;
  reason: string;
  /** Whether the review actually ran (false if tool wasn't in the reviewed set) */
  reviewed: boolean;
}

/** Tools that are reviewed by default — anything that sends externally. */
const DEFAULT_REVIEWED_TOOLS = [
  'send_gmail_message',
  'send_slack_message',
  'send_discord_message',
];

/** Patterns that catch MCP tool variants. */
const DEFAULT_REVIEWED_PATTERNS = [
  /^send_/i,
  /^post_/i,
  /^reply_/i,
  /^create_.*message/i,
  /^forward_/i,
];

const SYSTEM_PROMPT = `You are a safety reviewer for an AI agent system. Your job is to evaluate whether a tool call should be allowed to proceed.

You will receive:
- The tool name being called
- The tool input (arguments)
- Context about what the agent is supposed to be doing

Evaluate the tool call against these criteria:
1. Does this action make sense given the context?
2. Is the content appropriate and professional?
3. Could this cause harm (spam, harassment, data leak, unintended side effects)?
4. Is the recipient correct and expected?
5. Does the volume/frequency seem reasonable?

Respond with EXACTLY one of:
ALLOW: <brief reason>
DENY: <brief reason>

Be conservative but not paranoid. Normal business replies are fine. Block things that look like:
- Spam or mass sending
- Replying to automated/no-reply addresses
- Content that doesn't match the conversation context
- Potentially harmful or inappropriate content
- Sending sensitive data to wrong recipients`;

export class GuardrailReviewer {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly reviewedTools: Set<string>;
  private readonly reviewedPatterns: RegExp[];
  private readonly timeoutMs: number;
  private readonly logger: Logger;

  constructor(deps: GuardrailReviewerDeps) {
    this.apiKey = deps.apiKey;
    this.model = deps.model ?? 'claude-haiku-4-5-20251001';
    this.reviewedTools = new Set(deps.reviewedTools ?? DEFAULT_REVIEWED_TOOLS);
    this.reviewedPatterns = deps.reviewedPatterns ?? DEFAULT_REVIEWED_PATTERNS;
    this.timeoutMs = deps.timeoutMs ?? 5000;
    this.logger = deps.logger;
  }

  /** Check if a tool name should be reviewed. */
  shouldReview(toolName: string): boolean {
    if (this.reviewedTools.has(toolName)) return true;
    return this.reviewedPatterns.some(p => p.test(toolName));
  }

  /** Review a tool call. Returns allow/deny with reason. */
  async review(toolName: string, toolInput: unknown, agentContext?: string): Promise<ReviewResult> {
    if (!this.shouldReview(toolName)) {
      return { allowed: true, reason: 'Tool not in reviewed set', reviewed: false };
    }

    const inputStr = typeof toolInput === 'string'
      ? toolInput
      : JSON.stringify(toolInput, null, 2);

    // Truncate large inputs to keep Haiku fast
    const truncatedInput = inputStr.length > 4000
      ? inputStr.slice(0, 4000) + '\n...(truncated)'
      : inputStr;

    const userPrompt = [
      `## Tool Call to Review`,
      `**Tool:** ${toolName}`,
      `**Input:**\n\`\`\`json\n${truncatedInput}\n\`\`\``,
      agentContext ? `\n## Agent Context\n${agentContext}` : '',
    ].join('\n');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 150,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        this.logger.log(`Guardrail API error: ${response.status} — fail-closed`);
        return { allowed: false, reason: `Guardrail API error: ${response.status}`, reviewed: true };
      }

      const json = await response.json() as {
        content?: Array<{ type: string; text?: string }>;
      };

      const text = json.content
        ?.filter(c => c.type === 'text' && c.text)
        .map(c => c.text)
        .join('') ?? '';

      return this.parseDecision(text, toolName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.log(`Guardrail review failed: ${msg} — fail-closed`);
      return { allowed: false, reason: `Guardrail unavailable: ${msg}`, reviewed: true };
    }
  }

  private parseDecision(text: string, toolName: string): ReviewResult {
    // Strip <think>...</think> blocks (Qwen3 thinking mode)
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Strip markdown bold/heading formatting
    cleaned = cleaned.replace(/^[#*\s]+/gm, '').trim();

    // Check each line for ALLOW/DENY (some models prefix with reasoning)
    for (const line of cleaned.split('\n')) {
      const l = line.trim();
      if (/^ALLOW\b/i.test(l)) {
        const reason = l.replace(/^ALLOW[:\s]*/i, '').trim() || 'Approved by guardrail';
        this.logger.log(`Guardrail ALLOW [${toolName}]: ${reason}`);
        return { allowed: true, reason, reviewed: true };
      }
      if (/^DENY\b/i.test(l)) {
        const reason = l.replace(/^DENY[:\s]*/i, '').trim() || 'Denied by guardrail';
        this.logger.log(`Guardrail DENY [${toolName}]: ${reason}`);
        return { allowed: false, reason, reviewed: true };
      }
    }

    // Ambiguous response — fail-closed
    this.logger.log(`Guardrail ambiguous response for [${toolName}]: ${cleaned.slice(0, 100)} — fail-closed`);
    return { allowed: false, reason: 'Ambiguous guardrail response — blocked for safety', reviewed: true };
  }
}
