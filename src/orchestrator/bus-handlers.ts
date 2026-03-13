import { ASSISTANT_NAME } from '../config/config.js';
import {
  storeChatMetadata,
  storeMessage,
} from '../db/index.js';
import { logger } from '../logger.js';
import type { Channel, MessageBus } from '../types.js';
import type { IntegrationManager } from '../integrations/index.js';
import { InboundMessage, OutboundMessage, ChatMetadata } from '../bus/index.js';
import type { AuditEmitter } from '../audit/index.js';
import { buildCorrelationId } from '../audit/index.js';
import type { LifecycleInterceptor } from '../utils/lifecycle-interceptor.js';
import { createInputSanitizer } from 'cambot-core';

function storeBotMessage(chatJid: string, text: string): void {
  storeMessage({
    id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: chatJid,
    sender: `bot:${ASSISTANT_NAME.toLowerCase()}`,
    sender_name: ASSISTANT_NAME,
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
  });
}

export interface BusHandlerDeps {
  bus: MessageBus;
  getChannels: () => Channel[];
  getIntegrationManager: () => IntegrationManager | null;
  getInterceptor?: () => LifecycleInterceptor | null;
  auditEmitter?: AuditEmitter;
}

export class BusHandlerRegistry {
  private unsubscribers: (() => void)[] = [];
  private deps: BusHandlerDeps;

  constructor(deps: BusHandlerDeps) {
    this.deps = deps;
  }

  register(): void {
    const { bus } = this.deps;

    // Input sanitizer: null bytes, encoding, byte limits (priority 15, ALL channels)
    const sanitizer = createInputSanitizer();
    this.unsubscribers.push(
      bus.on(InboundMessage, (event) => {
        const result = sanitizer.sanitizeString(event.message.content);
        event.message.content = result.value;
        if (result.violations.length > 0) {
          logger.debug(
            { violations: result.violations, jid: event.jid },
            'Input sanitizer flagged violations',
          );
        }
      }, { id: 'input-sanitizer', priority: 15, sequential: true, source: 'cambot-agent' }),
    );

    // DB storage: inbound messages (priority 16 — before lifecycle-ingest at 17
    // and persistent-agent-handler at 20, which cancels events for claimed channels.
    // Storage must complete before ingestion, and both must run before cancellation
    // so every inbound message is persisted regardless of routing.)
    this.unsubscribers.push(
      bus.on(InboundMessage, (event) => {
        storeMessage(event.message);
      }, { id: 'db-store-inbound', priority: 16, sequential: true, source: 'cambot-agent' }),
    );

    // Lifecycle interceptor: ingest inbound messages for memory (priority 17 —
    // after DB storage at 16, before persistent-agent-handler cancellation at 20.)
    if (this.deps.getInterceptor) {
      const getInterceptor = this.deps.getInterceptor;
      this.unsubscribers.push(
        bus.on(InboundMessage, (event) => {
          getInterceptor()?.ingestMessage(event.message);
        }, { id: 'lifecycle-ingest', priority: 17, sequential: true, source: 'cambot-agent' }),
      );
    }

    // DB storage: outbound messages (priority 100)
    this.unsubscribers.push(
      bus.on(OutboundMessage, (event) => {
        if (event.jid.startsWith('file:')) return; // file writes aren't chat messages
        storeChatMetadata(event.jid, new Date().toISOString(), event.jid, event.source);
        storeBotMessage(event.jid, event.text);
      }, { id: 'db-store-outbound', priority: 100, source: 'cambot-agent' }),
    );

    // DB storage: chat metadata (priority 100)
    this.unsubscribers.push(
      bus.on(ChatMetadata, (event) => {
        storeChatMetadata(event.jid, event.timestamp, event.name, event.channel, event.isGroup);
      }, { id: 'db-store-metadata', priority: 100, source: 'cambot-agent' }),
    );

    // Audit: inbound message (priority 200 — after storage at 100)
    if (this.deps.auditEmitter) {
      const auditEmitter = this.deps.auditEmitter;
      this.unsubscribers.push(
        bus.on(InboundMessage, (event) => {
          const channel = event.channel ?? event.source;
          auditEmitter.messageInbound({
            channel,
            correlationId: buildCorrelationId(channel, event.jid, event.message.id),
            chatJid: event.jid,
            sender: event.message.sender,
            senderName: event.message.sender_name,
            messageId: event.message.id,
            isGroup: event.jid.endsWith('@g.us') || event.jid.includes('group:'),
            contentLength: event.message.content.length,
          });
        }, { id: 'audit-inbound', priority: 200, source: 'cambot-agent' }),
      );

      this.unsubscribers.push(
        bus.on(OutboundMessage, (event) => {
          const channel = event.source;
          auditEmitter.messageOutbound({
            correlationId: buildCorrelationId(channel, event.jid),
            chatJid: event.jid,
            agentName: event.groupFolder ?? ASSISTANT_NAME,
            contentLength: event.text.length,
          });
        }, { id: 'audit-outbound', priority: 200, source: 'cambot-agent' }),
      );
    }

    // Channel delivery: forward outbound messages to the owning channel (priority 50)
    this.unsubscribers.push(
      bus.on(OutboundMessage, async (event) => {
        const integrationMgr = this.deps.getIntegrationManager();
        const activeChannels = integrationMgr?.getActiveChannels() ?? this.deps.getChannels();
        if (logger.isLevelEnabled('debug')) {
          logger.debug(
            { jid: event.jid, source: event.source, channelCount: activeChannels.length, channels: activeChannels.map(ch => ({ name: ch.name, owns: ch.ownsJid(event.jid), connected: ch.isConnected() })) },
            'Channel delivery: evaluating targets',
          );
        }
        const targets = event.broadcast
          ? activeChannels.filter(ch => ch.isConnected())
          : activeChannels.filter(ch => ch.ownsJid(event.jid) && ch.isConnected());
        if (targets.length === 0) {
          logger.warn({ jid: event.jid, source: event.source }, 'Channel delivery: no targets found for outbound message');
        }
        for (const ch of targets) {
          try {
            await ch.sendMessage(event.jid, event.text);
          } catch (err) {
            logger.error({ channel: ch.name, jid: event.jid, err }, 'Channel delivery failed');
          }
        }
      }, { id: 'channel-delivery', priority: 50, source: 'cambot-agent' }),
    );
  }

  unregister(): void {
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers = [];
  }
}
