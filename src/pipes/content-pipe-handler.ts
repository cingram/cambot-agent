/**
 * Content Pipe Bus Handler — intercepts InboundMessage events from untrusted
 * channels, runs them through the content pipe, and replaces message content
 * with a sanitized envelope.
 *
 * Registers at priority 20 (after shadow agent at 10, before DB storage at 100).
 */

import type { MessageBus } from '../bus/message-bus.js';
import type { RawContentRepository } from '../db/raw-content-repository.js';
import type { ContentPipe, RawContent } from './content-pipe.js';
import { formatEnvelope } from './envelope-formatter.js';
import { InboundMessage } from '../bus/events/inbound-message.js';
import { logger } from '../logger.js';

export interface ContentPipeHandlerDeps {
  bus: MessageBus;
  pipe: ContentPipe;
  rawContentStore: RawContentRepository;
  untrustedChannels: Set<string>;
  /** Cancel event on critical injection severity? Default: false (flag only) */
  blockOnCritical: boolean;
}

/**
 * Extract metadata from inbound message content.
 * Currently handles email format (Subject/From/Date headers).
 * For non-email untrusted channels, returns sender info only.
 */
function extractMetadata(
  event: InstanceType<typeof InboundMessage>,
): Record<string, string> {
  const metadata: Record<string, string> = {};

  // Email channel: parse structured header fields
  if (event.channel === 'email') {
    const content = event.message.content;
    const lines = content.split('\n');
    for (const line of lines) {
      const match = line.match(/^(Subject|From|Date|To|CC):\s*(.+)$/i);
      if (match) {
        metadata[match[1]] = match[2].trim();
      }
      // Stop at first blank line (body separator)
      if (line.trim() === '' && Object.keys(metadata).length > 0) break;
    }
  }

  // Always include sender info regardless of channel
  if (!metadata['From']) {
    metadata['From'] = event.message.sender_name || event.message.sender;
  }

  return metadata;
}

export function registerContentPipeHandler(deps: ContentPipeHandlerDeps): () => void {
  const { bus, pipe, rawContentStore, untrustedChannels, blockOnCritical } = deps;

  return bus.on(InboundMessage, async (event) => {
    // Only pipe untrusted channels; skip if channel is unknown
    const channel = event.channel;
    if (!channel || !untrustedChannels.has(channel)) return;

    const metadata = extractMetadata(event);

    const raw: RawContent = {
      id: event.message.id,
      channel,
      source: event.message.sender,
      body: event.message.content,
      metadata,
      receivedAt: event.message.timestamp,
    };

    try {
      const envelope = await pipe.process(raw);

      // Store raw content for lazy retrieval
      rawContentStore.store(raw, envelope.safetyFlags);

      // Replace message content with sanitized envelope
      event.message.content = formatEnvelope(envelope);

      // Optionally block critical injections
      if (blockOnCritical && envelope.safetyFlags.some((f) => f.severity === 'critical')) {
        logger.warn(
          { source: raw.source, flags: envelope.safetyFlags },
          'Content pipe: blocking message with critical injection',
        );
        event.cancelled = true;
      }
    } catch (err) {
      // Fail open — if the pipe errors, let the raw message through
      // but log the failure for investigation
      logger.error({ err, messageId: event.message.id }, 'Content pipe processing failed, passing raw');
    }
  }, { id: 'content-pipe', priority: 20, sequential: true, source: 'content-pipe' });
}
