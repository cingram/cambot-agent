/**
 * Shared Anthropic Messages API client — thin fetch wrapper.
 *
 * Eliminates duplicated fetch boilerplate, headers, URL constants,
 * and response types across keyword-generator, gateway-router, and summarizer.
 */

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

/**
 * Call the Anthropic Messages API with standard headers.
 * Throws on non-2xx responses or timeout.
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
