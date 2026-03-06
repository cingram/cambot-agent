import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema, SCHEMA_VERSION, createSecurityEventStore } from 'cambot-core';
import { createAuditEmitter } from './audit-emitter.js';
import pino from 'pino';

// Minimal in-memory setup using cambot-core's schema
let db: Database.Database;
let store: ReturnType<typeof createSecurityEventStore>;

const logger = pino({ level: 'silent' });

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  // Add correlation_id column (migration 19)
  try { db.exec('ALTER TABLE security_events ADD COLUMN correlation_id TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_security_events_correlation_id ON security_events(correlation_id)'); } catch {}
  db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(SCHEMA_VERSION));
  store = createSecurityEventStore();
});

afterEach(() => { db.close(); });

describe('createAuditEmitter', () => {
  it('webhookReceived inserts an audit.webhook_received event', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.webhookReceived({
      channel: 'imessage',
      correlationId: 'imessage:webhook:wh_123',
      sourceIp: '1.2.3.4',
      method: 'POST',
      path: '/webhook/loopmessage',
      userAgent: 'Loop/1.0',
      authProvided: true,
      authValid: true,
      responseCode: 200,
      durationMs: 12,
      webhookId: 'wh_123',
      contentLength: 500,
    });

    const events = store.queryByCorrelation(db, 'imessage:webhook:wh_123');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('audit.webhook_received');
    expect(events[0].severity).toBe('info');
    expect(events[0].source).toBe('imessage');
    expect(events[0].details).toMatchObject({
      sourceIp: '1.2.3.4',
      method: 'POST',
      responseCode: 200,
    });
  });

  it('webhookAuthFailed inserts a warning-severity event', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.webhookAuthFailed({
      channel: 'imessage',
      correlationId: 'imessage:webhook:unknown',
      sourceIp: '10.0.0.1',
      headerName: 'X-LoopMessage-Auth',
      path: '/webhook/loopmessage',
    });

    const events = store.query(db, { eventType: 'audit.webhook_auth_failed' });
    expect(events).toHaveLength(1);
    expect(events[0].severity).toBe('warning');
  });

  it('messageInbound inserts correct event', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.messageInbound({
      channel: 'imessage',
      correlationId: 'imessage:im:+1234:msg_1',
      chatJid: 'im:+1234',
      sender: '+1234',
      senderName: 'Test User',
      messageId: 'msg_1',
      isGroup: false,
      contentLength: 42,
    });

    const events = store.queryByCorrelation(db, 'imessage:im:+1234:msg_1');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('audit.message_inbound');
    expect(events[0].details).toMatchObject({
      chatJid: 'im:+1234',
      sender: '+1234',
      contentLength: 42,
    });
  });

  it('messageOutbound inserts correct event', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.messageOutbound({
      correlationId: 'agent:im:+1234',
      chatJid: 'im:+1234',
      agentName: 'main',
      contentLength: 200,
    });

    const events = store.queryByCorrelation(db, 'agent:im:+1234');
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('audit.message_outbound');
    expect(events[0].source).toBe('agent');
  });

  it('authorizationDecision records allowed and dropped decisions', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const corrId = 'imessage:im:+1234:msg_1';

    emitter.authorizationDecision({
      channel: 'imessage',
      correlationId: corrId,
      chatJid: 'im:+1234',
      sender: '+1234',
      messageId: 'msg_1',
      decision: 'allowed',
      groupFolder: 'main',
    });

    emitter.authorizationDecision({
      channel: 'discord',
      correlationId: 'discord:dc:999:msg_2',
      chatJid: 'dc:999',
      sender: '12345',
      messageId: 'msg_2',
      decision: 'dropped_unregistered',
    });

    const allowed = store.queryByCorrelation(db, corrId);
    expect(allowed).toHaveLength(1);
    expect(allowed[0].details).toMatchObject({ decision: 'allowed', groupFolder: 'main' });

    const dropped = store.queryByCorrelation(db, 'discord:dc:999:msg_2');
    expect(dropped).toHaveLength(1);
    expect(dropped[0].details).toMatchObject({ decision: 'dropped_unregistered' });
  });

  it('deliveryResult records success and failure', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.deliveryResult({
      channel: 'imessage',
      correlationId: 'imessage:im:+1234',
      chatJid: 'im:+1234',
      accepted: true,
      providerMessageId: 'loop_msg_456',
      durationMs: 150,
    });

    emitter.deliveryResult({
      channel: 'telegram',
      correlationId: 'telegram:tg:789',
      chatJid: 'tg:789',
      accepted: false,
      error: 'Bot was blocked',
      durationMs: 50,
    });

    const success = store.queryByCorrelation(db, 'imessage:im:+1234');
    expect(success[0].details).toMatchObject({ accepted: true, providerMessageId: 'loop_msg_456' });

    const failure = store.queryByCorrelation(db, 'telegram:tg:789');
    expect(failure[0].details).toMatchObject({ accepted: false, error: 'Bot was blocked' });
  });

  it('sessionLifecycle records start and end', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const corrId = 'agent:im:+1234';

    emitter.sessionLifecycle({
      correlationId: corrId,
      groupFolder: 'main',
      chatJid: 'im:+1234',
      sessionKey: 'main:im:+1234:1234567890',
      action: 'start',
    });

    emitter.sessionLifecycle({
      correlationId: corrId,
      groupFolder: 'main',
      chatJid: 'im:+1234',
      sessionKey: 'main:im:+1234:1234567890',
      action: 'end',
      success: true,
    });

    const events = store.queryByCorrelation(db, corrId);
    expect(events).toHaveLength(2);
    expect(events[0].details).toMatchObject({ action: 'start' });
    expect(events[1].details).toMatchObject({ action: 'end', success: true });
  });

  it('webhookDedup records duplicate suppression', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.webhookDedup({
      channel: 'imessage',
      correlationId: 'imessage:webhook:wh_dup',
      webhookId: 'wh_dup',
    });

    const events = store.query(db, { eventType: 'audit.webhook_dedup' });
    expect(events).toHaveLength(1);
    expect(events[0].details).toMatchObject({ webhookId: 'wh_dup' });
  });

  it('chain integrity is maintained across all audit event types', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.webhookReceived({
      channel: 'imessage', correlationId: 'c1', sourceIp: '1.1.1.1',
      method: 'POST', path: '/webhook', userAgent: 'test',
      authProvided: true, authValid: true, responseCode: 200,
      durationMs: 5, contentLength: 100,
    });
    emitter.messageInbound({
      channel: 'imessage', correlationId: 'c1', chatJid: 'im:+1',
      sender: '+1', senderName: 'User', messageId: 'm1',
      isGroup: false, contentLength: 50,
    });
    emitter.authorizationDecision({
      channel: 'imessage', correlationId: 'c1', chatJid: 'im:+1',
      sender: '+1', messageId: 'm1', decision: 'allowed', groupFolder: 'main',
    });
    emitter.messageOutbound({
      correlationId: 'c1', chatJid: 'im:+1', agentName: 'main', contentLength: 200,
    });
    emitter.deliveryResult({
      channel: 'imessage', correlationId: 'c1', chatJid: 'im:+1',
      accepted: true, durationMs: 100,
    });

    expect(store.verifyChain(db)).toBeNull();
  });

  it('does not throw on DB error (fire-and-forget)', () => {
    // Close the DB to simulate an error
    db.close();

    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    // Should not throw
    expect(() => {
      emitter.webhookReceived({
        channel: 'imessage', correlationId: 'c1', sourceIp: '1.1.1.1',
        method: 'POST', path: '/webhook', userAgent: 'test',
        authProvided: true, authValid: true, responseCode: 200,
        durationMs: 5, contentLength: 100,
      });
    }).not.toThrow();

    // Re-open for afterEach
    db = new Database(':memory:');
  });
});
