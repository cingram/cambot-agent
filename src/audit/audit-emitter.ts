/**
 * Audit Emitter — fire-and-forget audit event writer.
 *
 * Each method constructs a SecurityEventInput with the proper event_type,
 * severity, description, details, and correlationId, then inserts via
 * the security event store. All methods swallow errors to never block
 * the message pipeline.
 */

import type Database from 'better-sqlite3';
import type { SecurityEventStore } from 'cambot-core';
import type { Logger } from 'pino';

export interface AuditEmitterDeps {
  securityEventStore: SecurityEventStore;
  db: Database.Database;
  logger: Logger;
}

export interface AuditEmitter {
  webhookReceived(data: {
    channel: string;
    correlationId: string;
    sourceIp: string;
    method: string;
    path: string;
    userAgent: string;
    authProvided: boolean;
    authValid: boolean;
    responseCode: number;
    durationMs: number;
    webhookId?: string;
    contentLength: number;
  }): void;

  webhookAuthFailed(data: {
    channel: string;
    correlationId: string;
    sourceIp: string;
    headerName: string;
    path: string;
  }): void;

  messageInbound(data: {
    channel: string;
    correlationId: string;
    chatJid: string;
    sender: string;
    senderName: string;
    messageId: string;
    isGroup: boolean;
    contentLength: number;
    webhookId?: string;
  }): void;

  messageOutbound(data: {
    correlationId: string;
    chatJid: string;
    agentName: string;
    contentLength: number;
  }): void;

  authorizationDecision(data: {
    channel: string;
    correlationId: string;
    chatJid: string;
    sender: string;
    messageId: string;
    decision: 'allowed' | 'dropped_unregistered';
    groupFolder?: string;
  }): void;

  deliveryResult(data: {
    channel: string;
    correlationId: string;
    chatJid: string;
    accepted: boolean;
    providerMessageId?: string;
    error?: string;
    durationMs: number;
  }): void;

  sessionLifecycle(data: {
    correlationId: string;
    groupFolder: string;
    chatJid: string;
    sessionKey: string;
    action: 'start' | 'end';
    success?: boolean;
  }): void;

  webhookDedup(data: {
    channel: string;
    correlationId: string;
    webhookId: string;
  }): void;
}

export function createAuditEmitter(deps: AuditEmitterDeps): AuditEmitter {
  const { securityEventStore, db, logger } = deps;

  function emit(
    eventType: string,
    severity: 'info' | 'warning',
    source: string,
    description: string,
    details: Record<string, unknown>,
    correlationId: string,
  ): void {
    try {
      securityEventStore.insert(db, {
        severity,
        eventType,
        source,
        description,
        details,
        correlationId,
      });
    } catch (err) {
      logger.warn({ err, eventType, correlationId }, 'Audit event write failed');
    }
  }

  return {
    webhookReceived(data) {
      emit(
        'audit.webhook_received',
        'info',
        data.channel,
        `Webhook ${data.method} ${data.path} from ${data.sourceIp} -> ${data.responseCode}`,
        {
          sourceIp: data.sourceIp,
          method: data.method,
          path: data.path,
          userAgent: data.userAgent,
          authProvided: data.authProvided,
          authValid: data.authValid,
          responseCode: data.responseCode,
          durationMs: data.durationMs,
          webhookId: data.webhookId,
          contentLength: data.contentLength,
        },
        data.correlationId,
      );
    },

    webhookAuthFailed(data) {
      emit(
        'audit.webhook_auth_failed',
        'warning',
        data.channel,
        `Webhook auth failed from ${data.sourceIp} on ${data.path}`,
        {
          sourceIp: data.sourceIp,
          headerName: data.headerName,
          path: data.path,
        },
        data.correlationId,
      );
    },

    messageInbound(data) {
      emit(
        'audit.message_inbound',
        'info',
        data.channel,
        `Inbound from ${data.senderName} in ${data.chatJid}`,
        {
          chatJid: data.chatJid,
          sender: data.sender,
          senderName: data.senderName,
          messageId: data.messageId,
          channel: data.channel,
          isGroup: data.isGroup,
          contentLength: data.contentLength,
          webhookId: data.webhookId,
        },
        data.correlationId,
      );
    },

    messageOutbound(data) {
      emit(
        'audit.message_outbound',
        'info',
        'agent',
        `Outbound to ${data.chatJid} by ${data.agentName}`,
        {
          chatJid: data.chatJid,
          agentName: data.agentName,
          contentLength: data.contentLength,
        },
        data.correlationId,
      );
    },

    authorizationDecision(data) {
      emit(
        'audit.authorization_decision',
        'info',
        data.channel,
        `${data.decision === 'allowed' ? 'Allowed' : 'Dropped'} message from ${data.sender} in ${data.chatJid}`,
        {
          chatJid: data.chatJid,
          sender: data.sender,
          messageId: data.messageId,
          decision: data.decision,
          groupFolder: data.groupFolder,
        },
        data.correlationId,
      );
    },

    deliveryResult(data) {
      emit(
        'audit.delivery_result',
        'info',
        data.channel,
        `Delivery to ${data.chatJid}: ${data.accepted ? 'accepted' : 'failed'}`,
        {
          chatJid: data.chatJid,
          accepted: data.accepted,
          providerMessageId: data.providerMessageId,
          error: data.error,
          durationMs: data.durationMs,
        },
        data.correlationId,
      );
    },

    sessionLifecycle(data) {
      emit(
        'audit.session_lifecycle',
        'info',
        'agent',
        `Session ${data.action} for ${data.groupFolder} (${data.chatJid})`,
        {
          groupFolder: data.groupFolder,
          chatJid: data.chatJid,
          sessionKey: data.sessionKey,
          action: data.action,
          success: data.success,
        },
        data.correlationId,
      );
    },

    webhookDedup(data) {
      emit(
        'audit.webhook_dedup',
        'info',
        data.channel,
        `Duplicate webhook ${data.webhookId} suppressed`,
        { webhookId: data.webhookId },
        data.correlationId,
      );
    },
  };
}
