import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type http from 'http';

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { ApiKeyProvider } from './api-key-provider.js';

const VALID_ENV_TOKEN = 'env-token-that-is-long-enough-1234';
const SHORT_TOKEN = 'short';
const FILE_TOKEN = 'file-token-persisted-on-disk-abcdef';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apikey-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeReq(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

// --- Token resolution ---

describe('token resolution', () => {
  it('uses env token when provided and long enough', () => {
    const provider = new ApiKeyProvider({ envToken: VALID_ENV_TOKEN, storeDir: tmpDir });
    expect(provider.getToken()).toBe(VALID_ENV_TOKEN);
  });

  it('falls back to file when env token is missing', () => {
    fs.writeFileSync(path.join(tmpDir, 'web-auth-token'), FILE_TOKEN);
    const provider = new ApiKeyProvider({ storeDir: tmpDir });
    expect(provider.getToken()).toBe(FILE_TOKEN);
  });

  it('falls back to file when env token is too short', () => {
    fs.writeFileSync(path.join(tmpDir, 'web-auth-token'), FILE_TOKEN);
    const provider = new ApiKeyProvider({ envToken: SHORT_TOKEN, storeDir: tmpDir });
    expect(provider.getToken()).toBe(FILE_TOKEN);
  });

  it('auto-generates when no file exists and no valid env token', () => {
    const provider = new ApiKeyProvider({ storeDir: tmpDir });
    const token = provider.getToken();

    // 32 random bytes -> 64 hex chars
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    // Token is persisted to disk
    const persisted = fs.readFileSync(path.join(tmpDir, 'web-auth-token'), 'utf-8');
    expect(persisted).toBe(token);
  });
});

// --- authenticateRequest ---

describe('authenticateRequest', () => {
  let provider: ApiKeyProvider;

  beforeEach(() => {
    provider = new ApiKeyProvider({ envToken: VALID_ENV_TOKEN, storeDir: tmpDir });
  });

  it('accepts valid Bearer token', () => {
    const result = provider.authenticateRequest(
      makeReq({ authorization: `Bearer ${VALID_ENV_TOKEN}` }),
    );
    expect(result).toEqual({ authenticated: true, principalId: 'apikey:bearer' });
  });

  it('accepts raw token without Bearer prefix', () => {
    const result = provider.authenticateRequest(
      makeReq({ authorization: VALID_ENV_TOKEN }),
    );
    expect(result).toEqual({ authenticated: true, principalId: 'apikey:bearer' });
  });

  it('rejects missing Authorization header', () => {
    const result = provider.authenticateRequest(makeReq());
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe('Missing Authorization header');
  });

  it('rejects wrong token', () => {
    const result = provider.authenticateRequest(
      makeReq({ authorization: 'Bearer wrong-token-value-here-padding' }),
    );
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe('Invalid token');
  });
});

// --- authenticateUpgrade ---

describe('authenticateUpgrade', () => {
  let provider: ApiKeyProvider;

  beforeEach(() => {
    provider = new ApiKeyProvider({ envToken: VALID_ENV_TOKEN, storeDir: tmpDir });
  });

  it('accepts valid token query param', () => {
    const url = new URL(`http://localhost/?token=${VALID_ENV_TOKEN}`);
    const result = provider.authenticateUpgrade(makeReq(), url);
    expect(result).toEqual({ authenticated: true, principalId: 'apikey:bearer' });
  });

  it('rejects missing token query param', () => {
    const url = new URL('http://localhost/');
    const result = provider.authenticateUpgrade(makeReq(), url);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe('Missing token query param');
  });

  it('rejects wrong token', () => {
    const url = new URL('http://localhost/?token=wrong-token-value-padding-here');
    const result = provider.authenticateUpgrade(makeReq(), url);
    expect(result.authenticated).toBe(false);
    expect(result.reason).toBe('Invalid token');
  });
});

// --- Lifecycle ---

describe('lifecycle', () => {
  it('destroy is a no-op (does not throw)', () => {
    const provider = new ApiKeyProvider({ envToken: VALID_ENV_TOKEN, storeDir: tmpDir });
    expect(() => provider.destroy()).not.toThrow();
  });

  it('getToken returns the resolved token', () => {
    const provider = new ApiKeyProvider({ envToken: VALID_ENV_TOKEN, storeDir: tmpDir });
    expect(provider.getToken()).toBe(VALID_ENV_TOKEN);
  });
});
