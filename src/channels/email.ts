/**
 * Email Channel — receives emails via Gmail polling and sends replies via workspace-mcp.
 *
 * JID scheme: email:{sender-address} (e.g. email:john@example.com)
 * All emails route to the "email-inbox" group folder.
 *
 * Polls workspace-mcp's Gmail search tool via HTTP (MCP JSON-RPC protocol)
 * to discover unread messages. Tracks last-seen timestamp in SQLite.
 */
import { ASSISTANT_NAME } from '../config/config.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts } from '../types.js';
import { InboundMessage, ChatMetadata } from '../bus/index.js';

export interface EmailChannelConfig {
  /** Full URL to the workspace-mcp streamable-http endpoint */
  workspaceMcpUrl: string;
  /** Poll interval in ms (default: 30000) */
  pollIntervalMs?: number;
  /** Group folder for email conversations */
  groupFolder?: string;
  /** Get last poll timestamp from DB */
  getLastPollTimestamp: () => string | null;
  /** Save last poll timestamp to DB */
  setLastPollTimestamp: (ts: string) => void;
}

const EMAIL_GROUP_FOLDER = 'email-inbox';
const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** JSON-RPC request ID counter */
let rpcId = 1;

/**
 * Call a tool on the workspace-mcp server via MCP JSON-RPC over HTTP.
 */
async function callMcpTool(
  url: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const body = {
    jsonrpc: '2.0',
    id: rpcId++,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`MCP HTTP error: ${res.status} ${res.statusText}`);
  }

  const json = await res.json() as {
    result?: { content?: Array<{ text?: string }> };
    error?: { message: string };
  };

  if (json.error) {
    throw new Error(`MCP tool error: ${json.error.message}`);
  }

  // MCP tool results come as content array with text parts
  const textParts = json.result?.content
    ?.filter((c) => c.text)
    .map((c) => c.text)
    .join('');

  if (textParts) {
    try {
      return JSON.parse(textParts);
    } catch {
      return textParts;
    }
  }

  return json.result;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  date?: string;
  snippet?: string;
  body?: string;
}

export class EmailChannel implements Channel {
  name = 'email';

  private opts: ChannelOpts;
  private config: EmailChannelConfig;
  private connected = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Map of JID → last thread ID for reply threading */
  private threadMap = new Map<string, { threadId: string; subject: string }>();

  constructor(opts: ChannelOpts, config: EmailChannelConfig) {
    this.opts = opts;
    this.config = config;
  }

  async connect(): Promise<void> {
    const groupFolder = this.config.groupFolder || EMAIL_GROUP_FOLDER;

    // Register the email-inbox group
    this.opts.registerGroup(`email:inbox`, {
      name: 'Email Inbox',
      folder: groupFolder,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });

    this.connected = true;

    // Start polling loop
    const interval = this.config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS;
    await this.pollEmails();
    this.pollTimer = setInterval(() => {
      this.pollEmails().catch((err) => {
        logger.error({ err }, 'Email poll error');
      });
    }, interval);

    logger.info({ interval }, 'Email channel connected, polling started');
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    const recipient = jid.replace(/^email:/, '');
    if (!recipient || recipient === 'inbox') {
      logger.warn({ jid }, 'Cannot send email to non-address JID');
      return;
    }

    try {
      const threadInfo = this.threadMap.get(jid);
      const subject = threadInfo?.subject
        ? `Re: ${threadInfo.subject.replace(/^Re:\s*/i, '')}`
        : `Message from ${ASSISTANT_NAME}`;

      const startMs = Date.now();
      await callMcpTool(this.config.workspaceMcpUrl, 'send_gmail_message', {
        to: recipient,
        subject,
        body: text,
        ...(threadInfo?.threadId ? { thread_id: threadInfo.threadId } : {}),
      });

      this.opts.onAuditEvent?.({
        type: 'audit.delivery_result',
        channel: 'email',
        data: { chatJid: jid, accepted: true, durationMs: Date.now() - startMs },
      });
      logger.info({ to: recipient, subject }, 'Email sent');
    } catch (err) {
      this.opts.onAuditEvent?.({
        type: 'audit.delivery_result',
        channel: 'email',
        data: { chatJid: jid, accepted: false, error: err instanceof Error ? err.message : String(err), durationMs: 0 },
      });
      logger.error({ err, jid }, 'Failed to send email');
      throw err;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('email:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('Email channel disconnected');
  }

  private async pollEmails(): Promise<void> {
    try {
      const lastPoll = this.config.getLastPollTimestamp();
      // Search for unread emails since last poll
      const query = lastPoll
        ? `is:unread after:${lastPoll.split('T')[0]}`
        : 'is:unread';

      const result = await callMcpTool(
        this.config.workspaceMcpUrl,
        'search_gmail_messages',
        { query, max_results: 10 },
      ) as GmailMessage[] | { messages?: GmailMessage[] } | null;

      const messages: GmailMessage[] = Array.isArray(result)
        ? result
        : (result as { messages?: GmailMessage[] })?.messages || [];

      if (messages.length === 0) return;

      let latestTimestamp = lastPoll || '';

      for (const email of messages) {
        const from = email.from || 'unknown@unknown.com';
        const senderEmail = extractEmail(from);
        const senderName = extractName(from) || senderEmail;
        const emailDate = email.date || new Date().toISOString();

        // Skip if we've already processed this timestamp
        if (lastPoll && emailDate <= lastPoll) continue;

        const jid = `email:${senderEmail}`;
        const timestamp = new Date(emailDate).toISOString();

        // Track thread for replies
        if (email.threadId) {
          this.threadMap.set(jid, {
            threadId: email.threadId,
            subject: email.subject || '',
          });
        }

        // Format the email content for the agent
        const content = formatEmailContent(email);

        // Emit chat metadata
        this.opts.messageBus.emit(new ChatMetadata('email', jid, { name: senderName, channel: 'email', isGroup: false })).catch(() => {});

        // Emit the message
        const emailMessage = {
          id: `email-${email.id}`,
          chat_jid: jid,
          sender: `email:${senderEmail}`,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
          is_bot_message: false,
        };

        this.opts.onAuditEvent?.({
          type: 'audit.message_inbound',
          channel: 'email',
          data: {
            chatJid: jid,
            sender: senderEmail,
            senderName,
            messageId: email.id,
            isGroup: false,
            contentLength: content.length,
          },
        });

        this.opts.messageBus.emit(new InboundMessage('email', jid, emailMessage, { channel: 'email' })).catch(() => {});

        if (timestamp > latestTimestamp) {
          latestTimestamp = timestamp;
        }
      }

      if (latestTimestamp && latestTimestamp !== lastPoll) {
        this.config.setLastPollTimestamp(latestTimestamp);
      }

      if (messages.length > 0) {
        logger.info(
          { count: messages.length },
          'Processed new emails',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Failed to poll emails');
    }
  }
}

/** Extract email address from "Name <email>" format */
function extractEmail(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from.trim();
}

/** Extract display name from "Name <email>" format */
function extractName(from: string): string | null {
  const match = from.match(/^(.+?)\s*<[^>]+>/);
  return match ? match[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** Format email content for the agent */
function formatEmailContent(email: GmailMessage): string {
  const parts: string[] = [];
  if (email.subject) parts.push(`Subject: ${email.subject}`);
  if (email.from) parts.push(`From: ${email.from}`);
  if (email.date) parts.push(`Date: ${email.date}`);
  parts.push('');
  parts.push(email.body || email.snippet || '(empty)');
  return parts.join('\n');
}
