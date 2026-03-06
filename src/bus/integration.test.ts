/**
 * Integration test — proves the full bus pipeline works end-to-end:
 *   Channel emits → middleware fires → handlers fire in priority order → delivery
 *
 * Uses in-memory SQLite so no filesystem side effects.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createAppBus, type AppBus } from './create-app-bus.js';
import { InboundMessage } from './events/inbound-message.js';
import { OutboundMessage } from './events/outbound-message.js';
import { ChatMetadata } from './events/chat-metadata.js';
import type { NewMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides?: Partial<NewMessage>): NewMessage {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    chat_jid: 'web:ui',
    sender: 'web:user',
    sender_name: 'User',
    content: 'Hello from the web channel',
    timestamp: new Date().toISOString(),
    is_from_me: false,
    is_bot_message: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bus Integration (full pipeline)', () => {
  let db: Database.Database;
  let appBus: AppBus;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('journal_mode = WAL');
    appBus = createAppBus({ db });
  });

  afterEach(async () => {
    await appBus.shutdown();
    db.close();
  });

  // -----------------------------------------------------------------------
  // 1. Event types are registered
  // -----------------------------------------------------------------------

  it('registers all known event types on startup', () => {
    const types = appBus.bus.listEventTypes();
    expect(types.length).toBeGreaterThan(0);

    const typeNames = types.map((t) => t.type);
    expect(typeNames).toContain('message.inbound');
    expect(typeNames).toContain('message.outbound');
    expect(typeNames).toContain('agent.telemetry');
    expect(typeNames).toContain('security.anomaly');
  });

  // -----------------------------------------------------------------------
  // 2. InboundMessage flows through handlers in priority order
  // -----------------------------------------------------------------------

  it('InboundMessage handlers fire in priority order', async () => {
    const order: string[] = [];

    appBus.bus.on(InboundMessage, () => { order.push('early'); }, { priority: 10 });
    appBus.bus.on(InboundMessage, () => { order.push('mid'); }, { priority: 100 });
    appBus.bus.on(InboundMessage, () => { order.push('late'); }, { priority: 200 });

    const msg = makeMessage();
    await appBus.bus.emit(new InboundMessage('web', 'web:ui', msg, { channel: 'web' }));

    expect(order).toEqual(['early', 'mid', 'late']);
  });

  // -----------------------------------------------------------------------
  // 3. OutboundMessage triggers delivery handler
  // -----------------------------------------------------------------------

  it('OutboundMessage reaches channel-delivery handler', async () => {
    const delivered: string[] = [];

    appBus.bus.on(OutboundMessage, (event) => {
      delivered.push(event.text);
    }, { id: 'channel-delivery', priority: 50 });

    await appBus.bus.emit(
      new OutboundMessage('agent', 'web:ui', 'Hello from the agent'),
    );

    expect(delivered).toEqual(['Hello from the agent']);
  });

  // -----------------------------------------------------------------------
  // 4. Dedup filter blocks duplicate events
  // -----------------------------------------------------------------------

  it('dedup filter blocks duplicate InboundMessage by event ID', async () => {
    const received: string[] = [];
    appBus.bus.on(InboundMessage, (event) => {
      received.push(event.id);
    });

    const msg = makeMessage();
    const event = new InboundMessage('web', 'web:ui', msg, { channel: 'web' });

    await appBus.bus.emit(event);

    // Emit the exact same event again (same ID)
    await appBus.bus.emit(event);

    expect(received).toHaveLength(1);
  });

  // -----------------------------------------------------------------------
  // 5. Event journal records all events
  // -----------------------------------------------------------------------

  it('event journal persists events to SQLite', async () => {
    const msg = makeMessage();
    await appBus.bus.emit(new InboundMessage('web', 'web:ui', msg, { channel: 'web' }));
    await appBus.bus.emit(
      new OutboundMessage('agent', 'web:ui', 'Response text'),
    );

    // Flush the journal write queue
    await appBus.journal.flush();

    const events = appBus.journal.queryEvents();
    expect(events.length).toBe(2);

    const types = events.map((e) => e.type);
    expect(types).toContain('message.inbound');
    expect(types).toContain('message.outbound');
  });

  it('event journal marks events as processed after handlers complete', async () => {
    appBus.bus.on(InboundMessage, () => { /* handler exists */ });

    const msg = makeMessage();
    await appBus.bus.emit(new InboundMessage('web', 'web:ui', msg, { channel: 'web' }));
    await appBus.journal.flush();

    const events = appBus.journal.queryEvents({ type: 'message.inbound' });
    expect(events.length).toBe(1);
    expect(events[0].processed).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 6. Full round-trip: inbound → handler → outbound → delivery
  // -----------------------------------------------------------------------

  it('full round-trip: InboundMessage triggers handler that emits OutboundMessage', async () => {
    const deliveries: Array<{ jid: string; text: string }> = [];

    // Simulate a handler that receives inbound and emits outbound (like GroupMessageProcessor)
    appBus.bus.on(InboundMessage, async (event) => {
      await appBus.bus.emit(
        new OutboundMessage('agent', event.jid, `Echo: ${event.message.content}`, {
          correlationId: event.id,
        }),
      );
    }, { priority: 100 });

    // Simulate channel delivery
    appBus.bus.on(OutboundMessage, (event) => {
      deliveries.push({ jid: event.jid, text: event.text });
    }, { id: 'channel-delivery', priority: 50 });

    // Channel emits inbound
    const msg = makeMessage({ content: 'Hello' });
    await appBus.bus.emit(new InboundMessage('web', 'web:ui', msg, { channel: 'web' }));

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toEqual({
      jid: 'web:ui',
      text: 'Echo: Hello',
    });

    // Journal should have both events
    await appBus.journal.flush();
    const events = appBus.journal.queryEvents();
    expect(events.length).toBe(2);
  });

  // -----------------------------------------------------------------------
  // 7. ChatMetadata events flow through
  // -----------------------------------------------------------------------

  it('ChatMetadata events are persisted by journal', async () => {
    await appBus.bus.emit(
      new ChatMetadata('web', 'web:ui', { name: 'Web UI', channel: 'web', isGroup: false }),
    );

    await appBus.journal.flush();

    const events = appBus.journal.queryEvents({ type: 'chat.metadata' });
    expect(events.length).toBe(1);
    expect(events[0].source).toBe('web');
  });

  // -----------------------------------------------------------------------
  // 8. Event cancellation stops propagation
  // -----------------------------------------------------------------------

  it('cancelled events do not reach lower-priority handlers', async () => {
    const reached: string[] = [];

    appBus.bus.on(InboundMessage, (event) => {
      reached.push('gate');
      event.cancelled = true; // e.g., shadow-admin intercepts
    }, { priority: 10, sequential: true });

    appBus.bus.on(InboundMessage, () => {
      reached.push('storage');
    }, { priority: 100 });

    const msg = makeMessage();
    await appBus.bus.emit(new InboundMessage('web', 'web:ui', msg, { channel: 'web' }));

    expect(reached).toEqual(['gate']);
  });

  // -----------------------------------------------------------------------
  // 9. Subscription filters work with middleware
  // -----------------------------------------------------------------------

  it('subscription filter only receives matching channel events', async () => {
    const webMessages: string[] = [];
    const allMessages: string[] = [];

    appBus.bus.on(InboundMessage, (event) => {
      webMessages.push(event.message.content);
    }, { filter: { channel: 'web' } });

    appBus.bus.on(InboundMessage, (event) => {
      allMessages.push(event.message.content);
    });

    await appBus.bus.emit(
      new InboundMessage('web', 'web:ui', makeMessage({ content: 'from web' }), { channel: 'web' }),
    );
    await appBus.bus.emit(
      new InboundMessage('whatsapp', 'wa:123', makeMessage({ content: 'from wa' }), { channel: 'whatsapp' }),
    );

    expect(webMessages).toEqual(['from web']);
    expect(allMessages).toEqual(['from web', 'from wa']);
  });

  // -----------------------------------------------------------------------
  // 10. String-based subscriptions work alongside class-based
  // -----------------------------------------------------------------------

  it('string-based and class-based subscriptions both fire', async () => {
    const classBased: string[] = [];
    const stringBased: string[] = [];

    appBus.bus.on(InboundMessage, (event) => {
      classBased.push(event.message.content);
    });

    appBus.bus.on('message.inbound', (event) => {
      stringBased.push((event as InboundMessage).message.content);
    });

    const msg = makeMessage({ content: 'dual routing' });
    await appBus.bus.emit(new InboundMessage('web', 'web:ui', msg, { channel: 'web' }));

    expect(classBased).toEqual(['dual routing']);
    expect(stringBased).toEqual(['dual routing']);
  });

  // -----------------------------------------------------------------------
  // 11. Correlation chain — causationId links events
  // -----------------------------------------------------------------------

  it('outbound event carries correlationId from inbound event', async () => {
    let outboundCorrelation: string | undefined;

    appBus.bus.on(InboundMessage, async (event) => {
      await appBus.bus.emit(
        new OutboundMessage('agent', event.jid, 'reply', {
          correlationId: event.id,
          causationId: event.id,
        }),
      );
    }, { priority: 100 });

    appBus.bus.on(OutboundMessage, (event) => {
      outboundCorrelation = event.correlationId;
    }, { priority: 50 });

    const msg = makeMessage();
    const inbound = new InboundMessage('web', 'web:ui', msg, { channel: 'web' });
    await appBus.bus.emit(inbound);

    expect(outboundCorrelation).toBe(inbound.id);
  });
});
