/**
 * Shared HTTP helpers for API route handlers.
 */
import type http from 'http';

import { logger } from '../logger.js';

export function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function error(res: http.ServerResponse, status: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err }, 'API error');
  json(res, status, { error: message });
}

export function readBody(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  handler: (body: Record<string, unknown>) => void | Promise<void>,
): void {
  let raw = '';
  req.on('data', (chunk: Buffer) => { raw += chunk; });
  req.on('end', () => {
    try {
      const parsed = JSON.parse(raw);
      Promise.resolve(handler(parsed)).catch((err) => {
        if (!res.headersSent) {
          logger.error({ err }, 'Unhandled error in route handler');
          json(res, 500, { error: 'Internal error' });
        }
      });
    } catch {
      json(res, 400, { error: 'Invalid JSON' });
    }
  });
}
