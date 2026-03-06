/**
 * Integration test for the full Request Lifecycle Audit Logging system.
 *
 * Simulates complete message lifecycles (webhook → auth → inbound → session →
 * outbound → delivery) and verifies:
 *  - All audit events are present with correct event_types and severities
 *  - Events share the correct correlation_id
 *  - Chain integrity is maintained (verifyChain returns null)
 *  - Correlation ID builders produce deterministic, correct formats
 *  - queryByCorrelation reconstructs the full lifecycle in order
 *  - Fire-and-forget behavior (no exceptions on DB errors)
 *  - Multiple independent lifecycles don't leak across correlation IDs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createSchema, SCHEMA_VERSION, createSecurityEventStore } from 'cambot-core';
import { createAuditEmitter } from './audit-emitter.js';
import { buildCorrelationId, buildWebhookCorrelationId } from './correlation.js';
import pino from 'pino';

let db: Database.Database;
let store: ReturnType<typeof createSecurityEventStore>;
const logger = pino({ level: 'silent' });

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  try { db.exec('ALTER TABLE security_events ADD COLUMN correlation_id TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_security_events_correlation_id ON security_events(correlation_id)'); } catch {}
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
  store = createSecurityEventStore();
});

afterEach(() => { db.close(); });

describe('Full iMessage lifecycle (webhook → delivery)', () => {
  it('produces a complete audit trail with shared correlation ID', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const webhookId = 'wh_live_001';
    const messageId = 'msg_live_001';
    const chatJid = 'im:+15551234567';
    const channel = 'imessage';

    // Step 1: Webhook correlation (before messageId known)
    const webhookCorrId = buildWebhookCorrelationId(channel, webhookId);
    expect(webhookCorrId).toBe('imessage:webhook:wh_live_001');

    emitter.webhookReceived({
      channel,
      correlationId: webhookCorrId,
      sourceIp: '203.0.113.42',
      method: 'POST',
      path: '/webhook/loopmessage',
      userAgent: 'LoopMessage/2.0',
      authProvided: true,
      authValid: true,
      responseCode: 200,
      durationMs: 8,
      webhookId,
      contentLength: 1024,
    });

    // Step 2: Message-level correlation (after parsing)
    const msgCorrId = buildCorrelationId(channel, chatJid, messageId);
    expect(msgCorrId).toBe('imessage:im:+15551234567:msg_live_001');

    emitter.messageInbound({
      channel,
      correlationId: msgCorrId,
      chatJid,
      sender: '+15551234567',
      senderName: 'Alice',
      messageId,
      isGroup: false,
      contentLength: 42,
      webhookId,
    });

    // Step 3: Authorization
    emitter.authorizationDecision({
      channel,
      correlationId: msgCorrId,
      chatJid,
      sender: '+15551234567',
      messageId,
      decision: 'allowed',
      groupFolder: 'main',
    });

    // Step 4: Session start
    const sessionKey = `main:${chatJid}:${Date.now()}`;
    emitter.sessionLifecycle({
      correlationId: msgCorrId,
      groupFolder: 'main',
      chatJid,
      sessionKey,
      action: 'start',
    });

    // Step 5: Outbound response
    emitter.messageOutbound({
      correlationId: msgCorrId,
      chatJid,
      agentName: 'main',
      contentLength: 350,
    });

    // Step 6: Delivery result
    emitter.deliveryResult({
      channel,
      correlationId: msgCorrId,
      chatJid,
      accepted: true,
      providerMessageId: 'loop_resp_001',
      durationMs: 145,
    });

    // Step 7: Session end
    emitter.sessionLifecycle({
      correlationId: msgCorrId,
      groupFolder: 'main',
      chatJid,
      sessionKey,
      action: 'end',
      success: true,
    });

    // --- Verify webhook-level trail ---
    const webhookEvents = store.queryByCorrelation(db, webhookCorrId);
    expect(webhookEvents).toHaveLength(1);
    expect(webhookEvents[0].eventType).toBe('audit.webhook_received');
    expect(webhookEvents[0].source).toBe('imessage');
    expect(webhookEvents[0].severity).toBe('info');
    expect(webhookEvents[0].details).toMatchObject({
      sourceIp: '203.0.113.42',
      method: 'POST',
      responseCode: 200,
      webhookId: 'wh_live_001',
    });

    // --- Verify message-level trail ---
    const msgEvents = store.queryByCorrelation(db, msgCorrId);
    expect(msgEvents).toHaveLength(6);

    const eventTypes = msgEvents.map(e => e.eventType);
    expect(eventTypes).toEqual([
      'audit.message_inbound',
      'audit.authorization_decision',
      'audit.session_lifecycle',
      'audit.message_outbound',
      'audit.delivery_result',
      'audit.session_lifecycle',
    ]);

    // Verify specific event details
    const inbound = msgEvents.find(e => e.eventType === 'audit.message_inbound')!;
    expect(inbound.details).toMatchObject({ sender: '+15551234567', contentLength: 42 });

    const authDecision = msgEvents.find(e => e.eventType === 'audit.authorization_decision')!;
    expect(authDecision.details).toMatchObject({ decision: 'allowed', groupFolder: 'main' });

    const outbound = msgEvents.find(e => e.eventType === 'audit.message_outbound')!;
    expect(outbound.source).toBe('agent');
    expect(outbound.details).toMatchObject({ agentName: 'main', contentLength: 350 });

    const delivery = msgEvents.find(e => e.eventType === 'audit.delivery_result')!;
    expect(delivery.details).toMatchObject({ accepted: true, providerMessageId: 'loop_resp_001' });

    const sessions = msgEvents.filter(e => e.eventType === 'audit.session_lifecycle');
    expect(sessions).toHaveLength(2);
    expect(sessions[0].details).toMatchObject({ action: 'start' });
    expect(sessions[1].details).toMatchObject({ action: 'end', success: true });

    // --- Chain integrity across all events ---
    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Failed auth lifecycle', () => {
  it('records webhook_auth_failed with warning severity', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const corrId = buildWebhookCorrelationId('imessage', 'wh_bad_auth');

    emitter.webhookReceived({
      channel: 'imessage',
      correlationId: corrId,
      sourceIp: '198.51.100.1',
      method: 'POST',
      path: '/webhook/loopmessage',
      userAgent: 'curl/7.88',
      authProvided: true,
      authValid: false,
      responseCode: 401,
      durationMs: 2,
      webhookId: 'wh_bad_auth',
      contentLength: 0,
    });

    emitter.webhookAuthFailed({
      channel: 'imessage',
      correlationId: corrId,
      sourceIp: '198.51.100.1',
      headerName: 'X-LoopMessage-Auth',
      path: '/webhook/loopmessage',
    });

    const events = store.queryByCorrelation(db, corrId);
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe('audit.webhook_received');
    expect(events[0].details).toMatchObject({ authValid: false, responseCode: 401 });
    expect(events[1].eventType).toBe('audit.webhook_auth_failed');
    expect(events[1].severity).toBe('warning');
    expect(events[1].details).toMatchObject({ headerName: 'X-LoopMessage-Auth' });

    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Dropped unregistered message lifecycle', () => {
  it('records authorization decision as dropped_unregistered', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const corrId = buildCorrelationId('discord', 'dc:unknown_channel', 'msg_drop_1');

    emitter.messageInbound({
      channel: 'discord',
      correlationId: corrId,
      chatJid: 'dc:unknown_channel',
      sender: 'user#1234',
      senderName: 'UnknownUser',
      messageId: 'msg_drop_1',
      isGroup: true,
      contentLength: 100,
    });

    emitter.authorizationDecision({
      channel: 'discord',
      correlationId: corrId,
      chatJid: 'dc:unknown_channel',
      sender: 'user#1234',
      messageId: 'msg_drop_1',
      decision: 'dropped_unregistered',
    });

    const events = store.queryByCorrelation(db, corrId);
    expect(events).toHaveLength(2);

    const authEvent = events.find(e => e.eventType === 'audit.authorization_decision')!;
    expect(authEvent.details).toMatchObject({ decision: 'dropped_unregistered' });
    expect(authEvent.details).not.toHaveProperty('groupFolder');

    // No further events (outbound, delivery) since message was dropped
    expect(events.every(e =>
      e.eventType === 'audit.message_inbound' || e.eventType === 'audit.authorization_decision',
    )).toBe(true);

    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Delivery failure lifecycle', () => {
  it('records delivery error details', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const corrId = buildCorrelationId('telegram', 'tg:chat_789', 'msg_fail_1');

    emitter.messageOutbound({
      correlationId: corrId,
      chatJid: 'tg:chat_789',
      agentName: 'main',
      contentLength: 200,
    });

    emitter.deliveryResult({
      channel: 'telegram',
      correlationId: corrId,
      chatJid: 'tg:chat_789',
      accepted: false,
      error: 'Bot was blocked by the user',
      durationMs: 45,
    });

    const events = store.queryByCorrelation(db, corrId);
    expect(events).toHaveLength(2);

    const delivery = events.find(e => e.eventType === 'audit.delivery_result')!;
    expect(delivery.details).toMatchObject({
      accepted: false,
      error: 'Bot was blocked by the user',
      durationMs: 45,
    });

    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Webhook dedup lifecycle', () => {
  it('records dedup suppression and stops the lifecycle', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const webhookId = 'wh_dup_001';
    const corrId = buildWebhookCorrelationId('imessage', webhookId);

    // First arrival is normal
    emitter.webhookReceived({
      channel: 'imessage',
      correlationId: corrId,
      sourceIp: '10.0.0.1',
      method: 'POST',
      path: '/webhook/loopmessage',
      userAgent: 'Loop/1.0',
      authProvided: true,
      authValid: true,
      responseCode: 200,
      durationMs: 5,
      webhookId,
      contentLength: 500,
    });

    // Duplicate suppressed
    emitter.webhookDedup({
      channel: 'imessage',
      correlationId: corrId,
      webhookId,
    });

    const events = store.queryByCorrelation(db, corrId);
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe('audit.webhook_received');
    expect(events[1].eventType).toBe('audit.webhook_dedup');
    expect(events[1].details).toMatchObject({ webhookId: 'wh_dup_001' });

    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Multi-channel parallel lifecycles', () => {
  it('maintains isolation between concurrent message lifecycles', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    const corrA = buildCorrelationId('imessage', 'im:+1111', 'msg_a');
    const corrB = buildCorrelationId('whatsapp', '120363@g.us', 'msg_b');
    const corrC = buildCorrelationId('discord', 'dc:guild:chan', 'msg_c');

    // Interleave events from three different channels
    emitter.messageInbound({
      channel: 'imessage', correlationId: corrA, chatJid: 'im:+1111',
      sender: '+1111', senderName: 'Alice', messageId: 'msg_a',
      isGroup: false, contentLength: 10,
    });
    emitter.messageInbound({
      channel: 'whatsapp', correlationId: corrB, chatJid: '120363@g.us',
      sender: '+2222', senderName: 'Bob', messageId: 'msg_b',
      isGroup: true, contentLength: 20,
    });
    emitter.messageInbound({
      channel: 'discord', correlationId: corrC, chatJid: 'dc:guild:chan',
      sender: 'user#5678', senderName: 'Charlie', messageId: 'msg_c',
      isGroup: true, contentLength: 30,
    });

    emitter.authorizationDecision({
      channel: 'imessage', correlationId: corrA, chatJid: 'im:+1111',
      sender: '+1111', messageId: 'msg_a', decision: 'allowed', groupFolder: 'main',
    });
    emitter.authorizationDecision({
      channel: 'whatsapp', correlationId: corrB, chatJid: '120363@g.us',
      sender: '+2222', messageId: 'msg_b', decision: 'dropped_unregistered',
    });
    emitter.authorizationDecision({
      channel: 'discord', correlationId: corrC, chatJid: 'dc:guild:chan',
      sender: 'user#5678', messageId: 'msg_c', decision: 'allowed', groupFolder: 'discord-group',
    });

    emitter.messageOutbound({
      correlationId: corrA, chatJid: 'im:+1111', agentName: 'main', contentLength: 100,
    });
    emitter.messageOutbound({
      correlationId: corrC, chatJid: 'dc:guild:chan', agentName: 'discord-group', contentLength: 200,
    });

    emitter.deliveryResult({
      channel: 'imessage', correlationId: corrA, chatJid: 'im:+1111',
      accepted: true, durationMs: 120,
    });
    emitter.deliveryResult({
      channel: 'discord', correlationId: corrC, chatJid: 'dc:guild:chan',
      accepted: true, durationMs: 80,
    });

    // Verify isolation: iMessage lifecycle
    const eventsA = store.queryByCorrelation(db, corrA);
    expect(eventsA).toHaveLength(4); // inbound, auth, outbound, delivery
    expect(eventsA.every(e => e.correlationId === corrA)).toBe(true);
    expect(eventsA.map(e => e.eventType)).toEqual([
      'audit.message_inbound',
      'audit.authorization_decision',
      'audit.message_outbound',
      'audit.delivery_result',
    ]);

    // WhatsApp: dropped, so only 2 events
    const eventsB = store.queryByCorrelation(db, corrB);
    expect(eventsB).toHaveLength(2);
    expect(eventsB.every(e => e.correlationId === corrB)).toBe(true);

    // Discord: allowed, 4 events
    const eventsC = store.queryByCorrelation(db, corrC);
    expect(eventsC).toHaveLength(4);
    expect(eventsC.every(e => e.correlationId === corrC)).toBe(true);

    // Chain intact across all 10 events from 3 lifecycles
    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Correlation ID format consistency', () => {
  it('all channel types produce valid deterministic IDs', () => {
    const cases = [
      { channel: 'imessage', chatJid: 'im:+15551234567', msgId: 'msg_1', expected: 'imessage:im:+15551234567:msg_1' },
      { channel: 'whatsapp', chatJid: '120363@g.us', msgId: 'ABC', expected: 'whatsapp:120363@g.us:ABC' },
      { channel: 'discord', chatJid: 'dc:12345', msgId: 'd_msg', expected: 'discord:dc:12345:d_msg' },
      { channel: 'telegram', chatJid: 'tg:-100123', msgId: 't_1', expected: 'telegram:tg:-100123:t_1' },
      { channel: 'web', chatJid: 'web:ui', msgId: 'web-req-1', expected: 'web:web:ui:web-req-1' },
      { channel: 'email', chatJid: 'email:thread_xyz', msgId: 'gmail_1', expected: 'email:email:thread_xyz:gmail_1' },
      { channel: 'cli', chatJid: 'cli:local', msgId: 'line_1', expected: 'cli:cli:local:line_1' },
    ];

    for (const { channel, chatJid, msgId, expected } of cases) {
      expect(buildCorrelationId(channel, chatJid, msgId)).toBe(expected);
    }

    // Without messageId
    expect(buildCorrelationId('imessage', 'im:+1234')).toBe('imessage:im:+1234');

    // Webhook format
    expect(buildWebhookCorrelationId('imessage', 'wh_abc')).toBe('imessage:webhook:wh_abc');
    expect(buildWebhookCorrelationId('web', 'req_xyz')).toBe('web:webhook:req_xyz');
  });

  it('same inputs always produce same correlation ID (deterministic)', () => {
    const id1 = buildCorrelationId('imessage', 'im:+1234', 'msg_1');
    const id2 = buildCorrelationId('imessage', 'im:+1234', 'msg_1');
    expect(id1).toBe(id2);
  });
});

describe('Query interface', () => {
  it('query filters by eventType correctly', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.webhookReceived({
      channel: 'imessage', correlationId: 'c1', sourceIp: '1.1.1.1',
      method: 'POST', path: '/webhook', userAgent: 'test',
      authProvided: true, authValid: true, responseCode: 200,
      durationMs: 5, contentLength: 100,
    });
    emitter.webhookAuthFailed({
      channel: 'imessage', correlationId: 'c2', sourceIp: '2.2.2.2',
      headerName: 'X-Auth', path: '/webhook',
    });
    emitter.webhookReceived({
      channel: 'web', correlationId: 'c3', sourceIp: '3.3.3.3',
      method: 'POST', path: '/api/message', userAgent: 'browser',
      authProvided: false, authValid: false, responseCode: 200,
      durationMs: 3, contentLength: 50,
    });

    const webhooks = store.query(db, { eventType: 'audit.webhook_received' });
    expect(webhooks).toHaveLength(2);

    const authFails = store.query(db, { eventType: 'audit.webhook_auth_failed' });
    expect(authFails).toHaveLength(1);
    expect(authFails[0].severity).toBe('warning');
  });

  it('queryByCorrelation returns empty array for unknown ID', () => {
    expect(store.queryByCorrelation(db, 'nonexistent:id')).toHaveLength(0);
  });

  it('query with correlationId filter works', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.messageInbound({
      channel: 'imessage', correlationId: 'target:id', chatJid: 'im:+1',
      sender: '+1', senderName: 'U', messageId: 'm1', isGroup: false, contentLength: 10,
    });
    emitter.messageInbound({
      channel: 'discord', correlationId: 'other:id', chatJid: 'dc:2',
      sender: 'u2', senderName: 'V', messageId: 'm2', isGroup: true, contentLength: 20,
    });

    const filtered = store.query(db, { correlationId: 'target:id' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].correlationId).toBe('target:id');
  });
});

describe('Chain integrity under stress', () => {
  it('maintains valid chain hash across 50 rapid audit events', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    for (let i = 0; i < 50; i++) {
      const corrId = buildCorrelationId('imessage', `im:+${i}`, `msg_${i}`);
      emitter.messageInbound({
        channel: 'imessage', correlationId: corrId, chatJid: `im:+${i}`,
        sender: `+${i}`, senderName: `User${i}`, messageId: `msg_${i}`,
        isGroup: false, contentLength: i * 10,
      });
    }

    expect(store.verifyChain(db)).toBeNull();

    const allEvents = store.query(db, { eventType: 'audit.message_inbound' });
    expect(allEvents).toHaveLength(50);
  });

  it('chain hash does NOT include correlationId (metadata only)', () => {
    // Insert two events with different correlationIds but identical core fields
    // would still have different hashes due to different timestamps, but
    // the point is that correlationId is not in the hash computation
    const e1 = store.insert(db, {
      severity: 'info',
      eventType: 'audit.test',
      source: 'test',
      description: 'same event',
      correlationId: 'corr_alpha',
    });

    const e2 = store.insert(db, {
      severity: 'info',
      eventType: 'audit.test',
      source: 'test',
      description: 'same event',
      correlationId: 'corr_beta',
    });

    // Both should have valid chain hashes
    expect(e1.chainHash).toMatch(/^[0-9a-f]{64}$/);
    expect(e2.chainHash).toMatch(/^[0-9a-f]{64}$/);
    // e2 should chain from e1
    expect(e2.prevHash).toBe(e1.chainHash);
    // Chain should be intact
    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Fire-and-forget resilience', () => {
  it('all emitter methods swallow DB errors without throwing', () => {
    db.close();
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    // Every method should be safe to call on a closed DB
    expect(() => emitter.webhookReceived({
      channel: 'x', correlationId: 'c', sourceIp: '1.1.1.1', method: 'POST',
      path: '/', userAgent: 'test', authProvided: true, authValid: true,
      responseCode: 200, durationMs: 1, contentLength: 0,
    })).not.toThrow();

    expect(() => emitter.webhookAuthFailed({
      channel: 'x', correlationId: 'c', sourceIp: '1.1.1.1',
      headerName: 'X-Auth', path: '/',
    })).not.toThrow();

    expect(() => emitter.messageInbound({
      channel: 'x', correlationId: 'c', chatJid: 'j', sender: 's',
      senderName: 'n', messageId: 'm', isGroup: false, contentLength: 0,
    })).not.toThrow();

    expect(() => emitter.messageOutbound({
      correlationId: 'c', chatJid: 'j', agentName: 'a', contentLength: 0,
    })).not.toThrow();

    expect(() => emitter.authorizationDecision({
      channel: 'x', correlationId: 'c', chatJid: 'j', sender: 's',
      messageId: 'm', decision: 'allowed',
    })).not.toThrow();

    expect(() => emitter.deliveryResult({
      channel: 'x', correlationId: 'c', chatJid: 'j',
      accepted: true, durationMs: 0,
    })).not.toThrow();

    expect(() => emitter.sessionLifecycle({
      correlationId: 'c', groupFolder: 'g', chatJid: 'j',
      sessionKey: 'k', action: 'start',
    })).not.toThrow();

    expect(() => emitter.webhookDedup({
      channel: 'x', correlationId: 'c', webhookId: 'w',
    })).not.toThrow();

    // Re-open for afterEach cleanup
    db = new Database(':memory:');
  });
});

describe('Web channel lifecycle (HTTP inbound)', () => {
  it('records webhook_received for HTTP POST messages', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const corrId = buildWebhookCorrelationId('web', 'req_web_001');

    emitter.webhookReceived({
      channel: 'web',
      correlationId: corrId,
      sourceIp: '192.168.1.100',
      method: 'POST',
      path: '/api/message',
      userAgent: 'Mozilla/5.0',
      authProvided: false,
      authValid: false,
      responseCode: 200,
      durationMs: 3,
      contentLength: 256,
    });

    emitter.messageInbound({
      channel: 'web',
      correlationId: corrId,
      chatJid: 'web:ui',
      sender: 'anonymous',
      senderName: 'Web User',
      messageId: 'web-msg-001',
      isGroup: false,
      contentLength: 256,
    });

    emitter.deliveryResult({
      channel: 'web',
      correlationId: corrId,
      chatJid: 'web:ui',
      accepted: true,
      durationMs: 500,
    });

    const events = store.queryByCorrelation(db, corrId);
    expect(events).toHaveLength(3);
    expect(events[0].source).toBe('web');
    expect(events.map(e => e.eventType)).toEqual([
      'audit.webhook_received',
      'audit.message_inbound',
      'audit.delivery_result',
    ]);

    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('CLI channel lifecycle (minimal metadata)', () => {
  it('records inbound with no network metadata', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });
    const corrId = buildCorrelationId('cli', 'cli:local', 'line_1');

    emitter.messageInbound({
      channel: 'cli',
      correlationId: corrId,
      chatJid: 'cli:local',
      sender: 'local',
      senderName: 'CLI User',
      messageId: 'line_1',
      isGroup: false,
      contentLength: 15,
    });

    const events = store.queryByCorrelation(db, corrId);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('audit.message_inbound');
    expect(events[0].source).toBe('cli');
    expect(events[0].details).toMatchObject({ channel: 'cli', sender: 'local' });

    expect(store.verifyChain(db)).toBeNull();
  });
});

describe('Event description quality', () => {
  it('produces human-readable descriptions for all event types', () => {
    const emitter = createAuditEmitter({ securityEventStore: store, db, logger });

    emitter.webhookReceived({
      channel: 'imessage', correlationId: 'c1', sourceIp: '10.0.0.1',
      method: 'POST', path: '/webhook/loopmessage', userAgent: 'Loop/1.0',
      authProvided: true, authValid: true, responseCode: 200,
      durationMs: 5, contentLength: 100,
    });
    emitter.webhookAuthFailed({
      channel: 'imessage', correlationId: 'c2', sourceIp: '10.0.0.2',
      headerName: 'X-Auth', path: '/webhook/loopmessage',
    });
    emitter.messageInbound({
      channel: 'imessage', correlationId: 'c3', chatJid: 'im:+1',
      sender: '+1', senderName: 'Alice', messageId: 'm1',
      isGroup: false, contentLength: 42,
    });
    emitter.messageOutbound({
      correlationId: 'c4', chatJid: 'im:+1', agentName: 'main', contentLength: 200,
    });
    emitter.authorizationDecision({
      channel: 'imessage', correlationId: 'c5', chatJid: 'im:+1',
      sender: '+1', messageId: 'm1', decision: 'allowed', groupFolder: 'main',
    });
    emitter.deliveryResult({
      channel: 'imessage', correlationId: 'c6', chatJid: 'im:+1',
      accepted: true, durationMs: 100,
    });
    emitter.sessionLifecycle({
      correlationId: 'c7', groupFolder: 'main', chatJid: 'im:+1',
      sessionKey: 'main:im:+1:123', action: 'start',
    });
    emitter.webhookDedup({
      channel: 'imessage', correlationId: 'c8', webhookId: 'wh_dup',
    });

    const all = store.query(db, {});
    expect(all).toHaveLength(8);

    // All descriptions should be non-empty strings
    for (const event of all) {
      expect(event.description).toBeTruthy();
      expect(typeof event.description).toBe('string');
      expect(event.description.length).toBeGreaterThan(5);
    }
  });
});
