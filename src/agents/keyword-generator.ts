/**
 * Keyword Generator — Uses Sonnet to generate routing keywords from agent descriptions.
 *
 * When an agent is created or its description changes, we call Sonnet once to
 * produce a rich set of words and phrases that users might say when they want
 * that agent. These are stored on the agent record and used by the local scorer
 * in the gateway router, making Haiku fallback rarely needed.
 */
import { readEnvFile } from '../config/env.js';
import { logger } from '../logger.js';
import { stripCodeFences } from '../workflows/index.js';
import type { AgentRepository } from '../db/agent-repository.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';

export interface RoutingKeywords {
  /** Single-word tokens for fast matching after tokenization. */
  words: string[];
  /** Multi-word phrases matched against the raw lowercased message. */
  phrases: string[];
}

const SYSTEM_PROMPT = `You are a keyword extraction engine for a message router. Given an agent's name, description, and capabilities, generate two lists:

1. **words**: Single lowercase tokens (3+ chars) that a user would say when they want this agent. Include:
   - Direct domain terms (e.g., "inbox", "email", "gmail")
   - Action verbs (e.g., "compose", "archive", "triage")
   - Synonyms and colloquialisms (e.g., "mail" for email, "lookup" for search)
   - Status terms (e.g., "unread", "spam", "flagged")
   - Tool/platform names (e.g., "gmail", "outlook", "calendar")
   Do NOT include generic words like "help", "please", "can", "the", etc.

2. **phrases**: Multi-word phrases (2-5 words, lowercase) that strongly signal this agent. Include:
   - Command phrases ("clean up my inbox", "send an email")
   - Question patterns ("do i have any emails", "what's on my calendar")
   - Colloquial requests ("too much email", "flooded with messages")
   Do NOT include phrases that could match multiple unrelated agents.

Output ONLY valid JSON: {"words": [...], "phrases": [...]}
No markdown fences, no explanation.
Aim for 30-60 words and 15-30 phrases. Quality over quantity — every entry should unambiguously point to THIS agent.`;

interface GeneratorDeps {
  apiKey: string;
  model?: string;
  apiUrl?: string;
}

interface AnthropicResponse {
  content: Array<{ type: string; text?: string }>;
}

export async function generateRoutingKeywords(
  deps: GeneratorDeps,
  agent: { name: string; description: string; capabilities: string[] },
): Promise<RoutingKeywords> {
  const { apiKey } = deps;
  const model = deps.model ?? DEFAULT_MODEL;
  const apiUrl = deps.apiUrl ?? DEFAULT_API_URL;

  const userMessage = `Agent: ${agent.name}
Description: ${agent.description}
Capabilities: ${agent.capabilities.join(', ') || '(none)'}`;

  try {
    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as AnthropicResponse;
    const text = json.content.find(b => b.type === 'text')?.text ?? '';

    const cleaned = stripCodeFences(text);
    const parsed = JSON.parse(cleaned) as { words?: unknown; phrases?: unknown };

    const words = Array.isArray(parsed.words)
      ? parsed.words.filter((w): w is string => typeof w === 'string' && w.length >= 3)
      : [];
    const phrases = Array.isArray(parsed.phrases)
      ? parsed.phrases.filter((p): p is string => typeof p === 'string' && p.includes(' '))
      : [];

    logger.info(
      { agent: agent.name, wordCount: words.length, phraseCount: phrases.length },
      `Generated routing keywords (${words.length} words, ${phrases.length} phrases)`,
    );

    return {
      words: words.map(w => w.toLowerCase()),
      phrases: phrases.map(p => p.toLowerCase()),
    };
  } catch (err) {
    logger.error({ err, agent: agent.name }, 'Failed to generate routing keywords');
    return { words: [], phrases: [] };
  }
}

// Cache the API key — it doesn't change at runtime
let cachedApiKey: string | null | undefined;

function getApiKey(): string | null {
  if (cachedApiKey === undefined) {
    const env = readEnvFile(['ANTHROPIC_API_KEY']);
    cachedApiKey = env.ANTHROPIC_API_KEY || null;
  }
  return cachedApiKey;
}

/** Create a generator that reads the API key from .env (cached). */
export function generateRoutingKeywordsFromEnv(
  agent: { name: string; description: string; capabilities: string[] },
): Promise<RoutingKeywords> {
  const apiKey = getApiKey();
  if (!apiKey) {
    logger.warn('ANTHROPIC_API_KEY not set — skipping keyword generation');
    return Promise.resolve({ words: [], phrases: [] });
  }
  return generateRoutingKeywords({ apiKey }, agent);
}

/**
 * Generate keywords for an agent and store them in the DB. Fire-and-forget.
 * Consolidates the repeated generate → update → invalidate pattern.
 */
export function generateAndStoreKeywords(
  agentRepo: AgentRepository,
  agent: { id: string; name: string; description: string; capabilities: string[] },
  onMutation?: () => void,
): void {
  generateRoutingKeywordsFromEnv(agent)
    .then(keywords => {
      if (keywords.words.length > 0) {
        agentRepo.update(agent.id, { routingKeywords: keywords });
        onMutation?.();
      }
    })
    .catch(() => { /* logged inside generator */ });
}
