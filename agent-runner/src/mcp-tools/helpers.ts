/**
 * Shared helpers for MCP tool handlers.
 */
import crypto from 'crypto';
import fs from 'fs';
import type { SocketFrame } from '../cambot-socket/types.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';
import type { CambotSocketClient } from '../cambot-socket-client.js';

export const uuid = (): string => crypto.randomUUID();

export function extractReplyResult(reply: SocketFrame): { text: string; isError: boolean } {
  const payload = reply.payload as { status?: string; result?: string; error?: string };
  if (reply.type === FRAME_TYPES.ERROR || payload.status === 'error') {
    return { text: payload.error ?? 'Unknown error', isError: true };
  }
  return { text: payload.result ?? 'No response', isError: false };
}

export function mcpText(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function mcpError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

/** Read a file as UTF-8 or return a fallback string on any error. */
export function readFileOr(filePath: string, fallback: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return fallback;
  }
}

export async function requestWithTimeout(
  client: CambotSocketClient,
  frame: SocketFrame,
  timeoutMs: number,
  timeoutLabel: string,
): Promise<{ text: string; isError: boolean }> {
  try {
    const reply = await client.request(frame, timeoutMs);
    return extractReplyResult(reply);
  } catch {
    return { text: `${timeoutLabel} timed out`, isError: true };
  }
}
