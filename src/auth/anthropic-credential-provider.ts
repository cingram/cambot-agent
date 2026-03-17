/**
 * Anthropic Credential Provider — manages credentials for Claude.
 *
 * Authentication methods (checked in order):
 *   1. API key — from ANTHROPIC_API_KEY env var. Works for direct API calls.
 *   2. OAuth token from CLAUDE_CODE_OAUTH_TOKEN env var.
 *   3. OAuth token from ~/.claude/.credentials.json (Linux, older Claude Code).
 *   4. OAuth token from macOS Keychain (macOS, current Claude Code).
 */

import { execSync } from 'child_process';
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
      logger.info('Anthropic auth: OAuth token available');
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

/**
 * Read the OAuth token from all known sources:
 *   1. CLAUDE_CODE_OAUTH_TOKEN env var
 *   2. ~/.claude/.credentials.json (Linux, older Claude Code)
 *   3. macOS Keychain (current Claude Code on macOS)
 */
function readClaudeOAuthToken(): string | undefined {
  // 1. Env var (set explicitly or by install script)
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return envToken;

  // 2. Credentials file (Linux, older Claude Code versions)
  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf-8');
    const data = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: string } };
    if (data.claudeAiOauth?.accessToken) return data.claudeAiOauth.accessToken;
  } catch {
    // File doesn't exist or isn't valid JSON — try next source
  }

  // 3. macOS Keychain (current Claude Code stores tokens here)
  if (process.platform === 'darwin') {
    try {
      const token = execSync('security find-generic-password -s "claude" -w 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
      if (token) return token;
    } catch {
      // Not in Keychain
    }
  }

  return undefined;
}
