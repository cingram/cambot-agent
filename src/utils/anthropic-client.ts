/**
 * Shared Anthropic API client — supports both direct HTTP (API key)
 * and Claude Code SDK (OAuth token) authentication.
 *
 * When an API key is available, uses direct HTTP for speed.
 * When only an OAuth token is available, falls back to the Claude Code SDK.
 */

import { logger } from '../logger.js';

export const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export interface AnthropicResponse {
  content: Array<{
    type: string;
    name?: string;
    input?: Record<string, unknown>;
    text?: string;
  }>;
  stop_reason?: string;
}

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools?: unknown[];
  tool_choice?: unknown;
}

const DEFAULT_TIMEOUT_MS = 30_000;

// ── Direct HTTP (API key) ────────────────────────────────────

/**
 * Call the Anthropic Messages API directly via HTTP.
 * Requires an API key. Fast (~50ms overhead).
 */
export async function callAnthropicApi(
  apiKey: string,
  body: AnthropicRequestBody,
  apiUrl = ANTHROPIC_API_URL,
): Promise<AnthropicResponse> {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Anthropic API error: ${response.status} ${response.statusText}${detail ? ` — ${detail}` : ''}`);
  }

  return response.json() as Promise<AnthropicResponse>;
}

// ── Claude Code SDK (OAuth token) ────────────────────────────

/**
 * Call Claude via the Claude Code SDK, which handles OAuth internally.
 * Slower (~200ms overhead) but works with CLAUDE_CODE_OAUTH_TOKEN.
 *
 * Note: The SDK doesn't support forced tool_use. For structured output,
 * use a JSON-response system prompt and parse the result text.
 */
export async function callAnthropicSdk(
  oauthToken: string,
  body: AnthropicRequestBody,
): Promise<AnthropicResponse> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');

  const userMessage = body.messages.find(m => m.role === 'user')?.content ?? '';

  // Build a prompt that includes the system instructions and asks for JSON
  const systemWithJson = body.tools
    ? `${body.system}\n\nRespond with ONLY valid JSON matching the tool schema. No markdown fences.`
    : body.system;

  const result = await new Promise<string>((resolve, reject) => {
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
      reject(new Error('SDK query timed out'));
    }, DEFAULT_TIMEOUT_MS);

    (async () => {
      try {
        for await (const message of query({
          prompt: userMessage,
          options: {
            model: body.model,
            systemPrompt: systemWithJson,
            maxTurns: 1,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            tools: [],
            abortController,
            env: {
              CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
            },
          },
        })) {
          if (message.type === 'result') {
            clearTimeout(timeout);
            if (message.subtype === 'success') {
              resolve(message.result);
            } else {
              reject(new Error(`SDK query failed: ${message.subtype}`));
            }
            return;
          }
        }
        clearTimeout(timeout);
        reject(new Error('SDK query ended without result'));
      } catch (err) {
        clearTimeout(timeout);
        reject(err);
      }
    })();
  });

  // If there were tools in the original request, parse the text as tool_use JSON
  if (body.tools && body.tool_choice) {
    const toolName = (body.tool_choice as { name?: string }).name ?? 'unknown';
    try {
      const cleaned = result.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
      const input = JSON.parse(cleaned);
      return {
        content: [{ type: 'tool_use', name: toolName, input }],
      };
    } catch {
      logger.warn({ result: result.slice(0, 200) }, 'SDK response was not valid JSON, returning as text');
    }
  }

  return {
    content: [{ type: 'text', text: result }],
  };
}

// ── Unified caller ───────────────────────────────────────────

export interface AnthropicCallerDeps {
  apiKey?: string;
  oauthToken?: string;
  apiUrl?: string;
}

/**
 * Call Anthropic using the best available auth method.
 * API key → direct HTTP (fast). OAuth token → SDK (slower but works with subscriptions).
 */
export async function callAnthropic(
  deps: AnthropicCallerDeps,
  body: AnthropicRequestBody,
): Promise<AnthropicResponse> {
  if (deps.apiKey) {
    return callAnthropicApi(deps.apiKey, body, deps.apiUrl);
  }
  if (deps.oauthToken) {
    return callAnthropicSdk(deps.oauthToken, body);
  }
  throw new Error('No Anthropic credentials available (need ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)');
}
