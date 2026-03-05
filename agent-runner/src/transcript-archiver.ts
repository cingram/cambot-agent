/**
 * Archives conversation transcripts to markdown files before SDK compaction.
 */
import fs from 'fs';
import path from 'path';
import type { ContainerPaths, ParsedMessage, SessionsIndex } from './types.js';
import type { Logger } from './logger.js';

export class TranscriptArchiver {
  constructor(
    private readonly paths: ContainerPaths,
    private readonly logger: Logger,
  ) {}

  /**
   * Archive the transcript at the given path to the conversations directory.
   */
  archive(transcriptPath: string, sessionId: string): void {
    if (!fs.existsSync(transcriptPath)) {
      this.logger.log('No transcript found for archiving');
      return;
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        this.logger.log('No messages to archive');
        return;
      }

      const summary = this.getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      fs.mkdirSync(this.paths.conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(this.paths.conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(messages, summary);
      fs.writeFileSync(filePath, markdown);

      this.logger.log(`Archived conversation to ${filePath}`);
    } catch (err: unknown) {
      this.logger.log(`Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getSessionSummary(sessionId: string, transcriptPath: string): string | null {
    const projectDir = path.dirname(transcriptPath);
    const indexPath = path.join(projectDir, 'sessions-index.json');

    if (!fs.existsSync(indexPath)) {
      this.logger.log(`Sessions index not found at ${indexPath}`);
      return null;
    }

    try {
      const index: SessionsIndex = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      const entry = index.entries.find(e => e.sessionId === sessionId);
      return entry?.summary ?? null;
    } catch (err: unknown) {
      this.logger.log(`Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
}

// ── Pure functions ──────────────────────────────────────────────────

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text = typeof entry.message.content === 'string'
          ? entry.message.content
          : entry.message.content.map((c: { text?: string }) => c.text || '').join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      // Malformed JSONL lines are expected in partial transcripts — skip silently
    }
  }
  return messages;
}

function formatTranscriptMarkdown(messages: ParsedMessage[], title?: string | null): string {
  const now = new Date();
  const formatDateTime = (d: Date) => d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : 'Andy';
    const content = msg.content.length > 2000
      ? msg.content.slice(0, 2000) + '...'
      : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}
