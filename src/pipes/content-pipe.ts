/**
 * Content Pipe — types for the untrusted input sanitization pipeline.
 *
 * Channels marked as untrusted have their inbound messages piped through
 * injection detection + LLM summarization before the agent sees them.
 */

export interface SafetyFlag {
  severity: 'critical' | 'high' | 'medium' | 'low';
  category: string;
  description: string;
}

export interface ContentEnvelope {
  /** Unique content ID (for raw retrieval via read_raw_content) */
  id: string;
  /** Source identifier, e.g. "email:john@example.com" */
  source: string;
  /** Channel name, e.g. "email", "rss", "webhook" */
  channel: string;
  /** ISO timestamp when content was received */
  receivedAt: string;
  /** Structured metadata extracted from the content (from, subject, date, etc.) */
  metadata: Record<string, string>;
  /** LLM-generated summary (1-3 sentences) */
  summary: string;
  /** Classified intent */
  intent: string;
  /** Injection detection results */
  safetyFlags: SafetyFlag[];
  /** Whether raw content was stored for lazy retrieval */
  rawAvailable: boolean;
}

export interface RawContent {
  id: string;
  channel: string;
  source: string;
  body: string;
  metadata: Record<string, string>;
  receivedAt: string;
}

export interface ContentPipe {
  process(raw: RawContent): Promise<ContentEnvelope>;
}
