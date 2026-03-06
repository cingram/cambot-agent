/**
 * Envelope Formatter — renders a ContentEnvelope as the text the agent sees.
 *
 * Clean content shows metadata + summary. Flagged content shows safety warnings.
 */

import type { ContentEnvelope, SafetyFlag } from './content-pipe.js';

export function formatEnvelope(envelope: ContentEnvelope): string {
  const lines: string[] = [];

  // Header
  const channelTag = envelope.channel.toUpperCase();
  lines.push(`[${channelTag} from ${envelope.source} — ${envelope.receivedAt}]`);

  // Metadata
  for (const [key, value] of Object.entries(envelope.metadata)) {
    lines.push(`${key}: ${value}`);
  }

  // Intent
  lines.push(`Intent: ${envelope.intent}`);

  // Summary
  lines.push(`Summary: ${envelope.summary}`);

  // Content ID for raw retrieval
  if (envelope.rawAvailable) {
    lines.push(`Content ID: ${envelope.id} (use read_raw_content to see original)`);
  }

  // Safety flags
  if (envelope.safetyFlags.length === 0) {
    lines.push('Safety: clean');
  } else {
    const maxSeverity = getMaxSeverity(envelope.safetyFlags);
    const categories = envelope.safetyFlags.map((f) => f.category);
    const unique = [...new Set(categories)];
    lines.push(`Safety: ${maxSeverity.toUpperCase()} — ${unique.join(', ')}`);
  }

  return lines.join('\n');
}

function getMaxSeverity(flags: SafetyFlag[]): string {
  const order = ['critical', 'high', 'medium', 'low'];
  for (const severity of order) {
    if (flags.some((f) => f.severity === severity)) return severity;
  }
  return 'low';
}
