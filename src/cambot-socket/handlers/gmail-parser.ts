/**
 * Gmail response parsing utilities.
 *
 * Extracted from email.ts to keep single responsibility per module.
 * Parses text-based Gmail batch responses into structured messages,
 * and runs messages through the content pipe for injection detection.
 */

import { formatEnvelope } from '../../pipes/envelope-formatter.js';
import type { ContentPipe } from '../../pipes/content-pipe.js';
import type { RawContentRepository } from '../../db/raw-content-repository.js';

// ── Types ─────────────────────────────────────────────────

export interface GmailMessage {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
  body?: string;
}

// ── Parsing ───────────────────────────────────────────────

export function parseGmailBatchResponse(text: string, fallbackIds: string[]): GmailMessage[] {
  const messages: GmailMessage[] = [];
  const blocks = text.split(/(?=Message \d+|--- Message |\n={3,}\n)/);

  for (const block of blocks) {
    if (!block.trim()) continue;

    const subject = block.match(/Subject:\s*(.+)/i)?.[1]?.trim();
    const from = block.match(/From:\s*(.+)/i)?.[1]?.trim();
    const date = block.match(/Date:\s*(.+)/i)?.[1]?.trim();
    const messageId = block.match(/Message[ -]?ID:\s*([a-f0-9]+)/i)?.[1];

    let body: string | undefined;
    const bodyMatch = block.match(/(?:Body|Content):\s*([\s\S]*?)(?=(?:\n(?:Message \d+|--- |={3,}))|$)/i);
    if (bodyMatch) body = bodyMatch[1].trim();

    if (subject || from || body) {
      messages.push({
        id: messageId || fallbackIds[messages.length] || 'unknown',
        subject,
        from,
        date,
        body,
      });
    }
  }

  if (messages.length === 0) {
    return fallbackIds.length > 0 ? [{ id: fallbackIds[0], body: text }] : [];
  }

  return messages;
}

// ── Content pipe processing ──────────────────────────────

export async function processMessageThroughPipe(
  msg: GmailMessage,
  pipe: ContentPipe,
  rawStore?: RawContentRepository,
): Promise<string> {
  const raw = {
    id: `email-${msg.id}`,
    channel: 'email',
    source: msg.from || 'unknown',
    body: msg.body || '(empty)',
    metadata: {
      ...(msg.subject ? { Subject: msg.subject } : {}),
      ...(msg.from ? { From: msg.from } : {}),
      ...(msg.date ? { Date: msg.date } : {}),
    },
    receivedAt: msg.date || new Date().toISOString(),
  };

  const envelope = await pipe.process(raw);
  if (rawStore) rawStore.store(raw, envelope.safetyFlags);
  return formatEnvelope(envelope);
}
