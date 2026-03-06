import { randomBytes } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { STORE_DIR } from '../config/config.js';

const TOKEN_FILE = path.join(STORE_DIR, 'web-auth-token');
const TOKEN_BYTES = 32; // 256-bit

export interface WebAuth {
  /** The token value (hex string). */
  readonly token: string;
  /** Validate a Bearer token from an HTTP request. Constant-time comparison. */
  validate(candidate: string | undefined): boolean;
}

/**
 * Creates the web channel auth gate.
 *
 * Token resolution order:
 * 1. `WEB_AUTH_TOKEN` env var / .env
 * 2. Persisted token from `store/web-auth-token`
 * 3. Auto-generated (written to file for cambot-core-ui to read)
 */
export function createWebAuth(envToken?: string): WebAuth {
  const token = resolveToken(envToken);

  return {
    get token() {
      return token;
    },
    validate(candidate: string | undefined): boolean {
      if (!candidate) return false;
      // Strip "Bearer " prefix if present
      const raw = candidate.startsWith('Bearer ')
        ? candidate.slice(7)
        : candidate;
      return timingSafeEqual(raw, token);
    },
  };
}

function resolveToken(envToken?: string): string {
  // 1. Explicit env var
  if (envToken && envToken.length >= 16) {
    logger.info('Web auth: using token from WEB_AUTH_TOKEN env var');
    return envToken;
  }

  // 2. Persisted token file
  if (fs.existsSync(TOKEN_FILE)) {
    const persisted = fs.readFileSync(TOKEN_FILE, 'utf-8').trim();
    if (persisted.length >= 16) {
      logger.info('Web auth: using persisted token from store/web-auth-token');
      return persisted;
    }
  }

  // 3. Auto-generate
  const generated = randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, generated, { mode: 0o600 });
  logger.info(
    { path: TOKEN_FILE },
    'Web auth: generated new token and wrote to store/web-auth-token',
  );
  return generated;
}

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
