/**
 * Email Pipe — email-specific ContentPipe implementation.
 *
 * Pipeline:
 * 1. Sanitize input (null bytes, encoding, byte limits)
 * 2. Run injection detection on subject + body
 * 3. Call Haiku summarizer for summary + intent
 * 4. Build ContentEnvelope from results
 */

import type { InputSanitizer, InjectionDetector } from 'cambot-core';
import type { ContentPipe, ContentEnvelope, RawContent, SafetyFlag } from './content-pipe.js';
import type { Summarizer } from './summarizer.js';

export interface EmailPipeDeps {
  summarizer: Summarizer;
  injectionDetector: InjectionDetector;
  inputSanitizer: InputSanitizer;
}

export function createEmailPipe(deps: EmailPipeDeps): ContentPipe {
  const { summarizer, injectionDetector, inputSanitizer } = deps;

  return {
    async process(raw: RawContent): Promise<ContentEnvelope> {
      // Step 1: sanitize
      const sanitized = inputSanitizer.sanitizeString(raw.body);
      const cleanBody = sanitized.value;

      // Also sanitize metadata values
      const cleanMetadata: Record<string, string> = {};
      for (const [key, value] of Object.entries(raw.metadata)) {
        cleanMetadata[key] = inputSanitizer.sanitizeString(value).value;
      }

      // Step 2: injection detection on combined content
      const scanTarget = [
        cleanMetadata['Subject'] ?? '',
        cleanBody,
      ].join('\n\n');

      const scanResult = injectionDetector.scan(scanTarget);

      const safetyFlags: SafetyFlag[] = scanResult.matches.map((match) => ({
        severity: match.severity,
        category: match.category,
        description: match.description,
      }));

      // Step 3: LLM summarization
      const { summary, intent } = await summarizer.summarize(cleanBody, cleanMetadata);

      // Override intent to suspicious if injection detector found critical/high
      const effectiveIntent = scanResult.hasInjection &&
        (scanResult.maxSeverity === 'critical' || scanResult.maxSeverity === 'high')
        ? 'suspicious'
        : intent;

      // Step 4: build envelope
      return {
        id: raw.id,
        source: raw.source,
        channel: raw.channel,
        receivedAt: raw.receivedAt,
        metadata: cleanMetadata,
        summary,
        intent: effectiveIntent,
        safetyFlags,
        rawAvailable: true,
      };
    },
  };
}
