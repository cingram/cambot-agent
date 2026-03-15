/**
 * Anthropic Credential Provider — manages credentials for Claude.
 *
 * Two authentication methods:
 *   1. OAuth token — read fresh from ~/.claude/.credentials.json each time
 *      (auto-refreshed by Claude Code). Works via the Claude Code SDK.
 *   2. API key — from ANTHROPIC_API_KEY env var. Works for direct API calls.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CredentialStatus {
  source: 'oauth' | 'api-key' | 'none';
  hasApiKey: boolean;
  hasOAuthToken: boolean;
}

// ---------------------------------------------------------------------------
// AnthropicCredentialProvider
// ---------------------------------------------------------------------------

const CREDENTIALS_PATH = path.join(os.homedir(), '.claude', '.credentials.json');

export class AnthropicCredentialProvider {
  private readonly envApiKey: string | undefined;

  constructor(opts?: { apiKey?: string }) {
    this.envApiKey = opts?.apiKey;

    const status = this.getStatus();
    if (status.hasOAuthToken && !status.hasApiKey) {
      logger.info('Anthropic auth: OAuth token from ~/.claude/.credentials.json');
    } else if (status.hasApiKey && status.hasOAuthToken) {
      logger.info('Anthropic auth: API key + OAuth token available');
    } else if (status.hasApiKey) {
      logger.info('Anthropic auth: API key available');
    } else {
      logger.warn(
        'No Anthropic credentials found. Log into Claude Code or set ANTHROPIC_API_KEY in .env',
      );
    }
  }

  /** Returns the API key for direct HTTP calls (x-api-key header). */
  getApiKey(): string | undefined {
    return this.envApiKey;
  }

  /** Reads the OAuth token fresh from ~/.claude/.credentials.json. */
  getOAuthToken(): string | undefined {
    return readClaudeOAuthToken();
  }

  /** Returns the best secret to pass to containers. */
  getContainerSecret(): { envVar: string; value: string } | undefined {
    if (this.envApiKey) {
      return { envVar: 'ANTHROPIC_API_KEY', value: this.envApiKey };
    }
    const token = readClaudeOAuthToken();
    if (token) {
      return { envVar: 'CLAUDE_CODE_OAUTH_TOKEN', value: token };
    }
    return undefined;
  }

  /** Returns the current credential status. */
  getStatus(): CredentialStatus {
    const hasApiKey = !!this.envApiKey;
    const hasOAuthToken = !!readClaudeOAuthToken();
    const source = hasApiKey ? 'api-key' as const
      : hasOAuthToken ? 'oauth' as const
      : 'none' as const;
    return { source, hasApiKey, hasOAuthToken };
  }
}

/** Read the OAuth token from Claude Code's credentials file. */
function readClaudeOAuthToken(): string | undefined {
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    return data.claudeAiOauth?.accessToken || undefined;
  } catch {
    return undefined;
  }
}
