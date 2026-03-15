import type http from 'http';
import { randomBytes } from 'node:crypto';
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import type { AuthProvider, AuthResult } from './types.js';
import { timingSafeEqual } from './timing.js';

const TOKEN_BYTES = 32;
const MIN_TOKEN_LENGTH = 16;

export interface ApiKeyProviderOpts {
  envToken?: string;
  storeDir: string;
}

export class ApiKeyProvider implements AuthProvider {
  private readonly token: string;

  constructor(opts: ApiKeyProviderOpts) {
    this.token = resolveToken(opts.envToken, opts.storeDir);
  }

  authenticateRequest(req: http.IncomingMessage): AuthResult {
    const header = req.headers.authorization;
    if (!header) return { authenticated: false, reason: 'Missing Authorization header' };

    const raw = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!timingSafeEqual(raw, this.token)) {
      return { authenticated: false, reason: 'Invalid token' };
    }
    return { authenticated: true, principalId: 'apikey:bearer' };
  }

  authenticateUpgrade(_req: http.IncomingMessage, url: URL): AuthResult {
    const token = url.searchParams.get('token');
    if (!token) return { authenticated: false, reason: 'Missing token query param' };

    if (!timingSafeEqual(token, this.token)) {
      return { authenticated: false, reason: 'Invalid token' };
    }
    return { authenticated: true, principalId: 'apikey:bearer' };
  }

  /** Expose token for external consumers (e.g., cambot-core-ui reads it from disk). */
  getToken(): string {
    return this.token;
  }

  destroy(): void {
    // No cleanup needed
  }
}

function resolveToken(envToken: string | undefined, storeDir: string): string {
  // 1. Explicit env var
  if (envToken && envToken.length >= MIN_TOKEN_LENGTH) {
    logger.info('Auth: using API key from WEB_AUTH_TOKEN env var');
    return envToken;
  }

  // 2. Persisted token file
  const tokenFile = path.join(storeDir, 'web-auth-token');
  if (fs.existsSync(tokenFile)) {
    const persisted = fs.readFileSync(tokenFile, 'utf-8').trim();
    if (persisted.length >= MIN_TOKEN_LENGTH) {
      logger.info('Auth: using persisted API key from store/web-auth-token');
      return persisted;
    }
  }

  // 3. Auto-generate
  const generated = randomBytes(TOKEN_BYTES).toString('hex');
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
  fs.writeFileSync(tokenFile, generated, { mode: 0o600 });
  logger.info({ path: tokenFile }, 'Auth: generated new API key and wrote to store/web-auth-token');
  return generated;
}
