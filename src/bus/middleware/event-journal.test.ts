import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { BusEvent } from '../bus-event.js';
import type { EnvelopeOptions } from '../envelope.js';
import { GenericEvent } from '../message-bus.js';
import { createEventJournal, type EventJournal } from './event-journal.js';

// ---------------------------------------------------------------------------
// Mock the logger
// ---------------------------------------------------------------------------
vi.mock('../../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Test event subclass with typed properties
// ---------------------------------------------------------------------------

class OrderPlaced extends BusEvent {
  readonly orderId: string;
  readonly amount: number;

  constructor(
    source: string,
    orderId: string,
    amount: number,
    envelope?: EnvelopeOptions,
  ) {
    super('order.placed', source, envelope);
    this.orderId = orderId;
    this.amount = amount;
  }
}

describe('EventJournal', () => {
  let db: Database.Database;
  let journal: EventJournal;

  beforeEach(() => {
    db = new Database(':memory:');
  });

  afterEach(() => {
    journal?.stop();
    db.close();
  });

  // =========================================================================
  // Table creation
  // =========================================================================

  it('creates bus_events table on ensureTable()', () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='bus_events'",
      )
      .all() as { name: string }[];
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('bus_events');
  });

  // =========================================================================
  // Persists events on emit (before hook inserts row)
  // =========================================================================

  it('persists events on emit (before hook inserts row)', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    const event = new GenericEvent('test.event', 'test-source', {
      key: 'value',
    });

    // Simulate the bus calling before hook
    await journal.before!(event);

    const rows = db
      .prepare('SELECT * FROM bus_events')
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('test.event');
    expect(rows[0].source).toBe('test-source');
    expect(rows[0].id).toBe(event.id);
  });

  // =========================================================================
  // Marks events as processed (after hook updates processed=1)
  // =========================================================================

  it('marks events as processed (after hook updates processed=1)', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    const event = new GenericEvent('test.event', 'test-source', {});
    await journal.before!(event);

    // Verify not processed yet
    const before = db
      .prepare('SELECT processed FROM bus_events WHERE id = ?')
      .get(event.id) as { processed: number };
    expect(before.processed).toBe(0);

    // After hook marks as processed
    await journal.after!(event);

    const after = db
      .prepare('SELECT processed FROM bus_events WHERE id = ?')
      .get(event.id) as { processed: number };
    expect(after.processed).toBe(1);
  });

  // =========================================================================
  // queryEvents returns persisted events
  // =========================================================================

  it('queryEvents returns persisted events', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    const e1 = new GenericEvent('type.a', 'src', { x: 1 });
    const e2 = new GenericEvent('type.b', 'src', { y: 2 });

    await journal.before!(e1);
    await journal.before!(e2);

    const results = journal.queryEvents();
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.type)).toContain('type.a');
    expect(results.map((r) => r.type)).toContain('type.b');
  });

  // =========================================================================
  // queryEvents filters by type
  // =========================================================================

  it('queryEvents filters by type', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    await journal.before!(new GenericEvent('type.a', 'src', {}));
    await journal.before!(new GenericEvent('type.b', 'src', {}));
    await journal.before!(new GenericEvent('type.a', 'src', {}));

    const results = journal.queryEvents({ type: 'type.a' });
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.type === 'type.a')).toBe(true);
  });

  // =========================================================================
  // queryEvents respects limit
  // =========================================================================

  it('queryEvents respects limit', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    for (let i = 0; i < 10; i++) {
      await journal.before!(new GenericEvent('test', 'src', { i }));
    }

    const results = journal.queryEvents({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  // =========================================================================
  // queryEvents filters by since (timestamp)
  // =========================================================================

  it('queryEvents filters by since (timestamp)', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    // Insert an event with an old timestamp
    const oldEvent = new GenericEvent('old.event', 'src', {});
    await journal.before!(oldEvent);

    // Manually set the timestamp to something old
    db.prepare("UPDATE bus_events SET timestamp = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(
      oldEvent.id,
    );

    // Insert a new event (will have current timestamp)
    const newEvent = new GenericEvent('new.event', 'src', {});
    await journal.before!(newEvent);

    const results = journal.queryEvents({ since: '2025-01-01T00:00:00.000Z' });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('new.event');
  });

  // =========================================================================
  // markProcessed updates the processed flag
  // =========================================================================

  it('markProcessed updates the processed flag', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    const event = new GenericEvent('test', 'src', {});
    await journal.before!(event);

    journal.markProcessed(event.id);

    const row = db
      .prepare('SELECT processed FROM bus_events WHERE id = ?')
      .get(event.id) as { processed: number };
    expect(row.processed).toBe(1);
  });

  // =========================================================================
  // Serializes GenericEvent data correctly
  // =========================================================================

  it('serializes GenericEvent data correctly', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    const event = new GenericEvent('test', 'src', {
      foo: 'bar',
      count: 42,
      nested: { a: true },
    });
    await journal.before!(event);

    const row = db
      .prepare('SELECT data FROM bus_events WHERE id = ?')
      .get(event.id) as { data: string };
    const parsed = JSON.parse(row.data);
    expect(parsed).toEqual({ foo: 'bar', count: 42, nested: { a: true } });
  });

  // =========================================================================
  // Serializes typed event properties correctly
  // =========================================================================

  it('serializes typed event properties correctly', async () => {
    journal = createEventJournal(db, { batched: false });
    journal.ensureTable();

    const event = new OrderPlaced('shop', 'ORD-123', 99.99, {
      channel: 'web',
      correlationId: 'corr-456',
    });
    await journal.before!(event);

    const row = db
      .prepare('SELECT data, channel, correlation_id FROM bus_events WHERE id = ?')
      .get(event.id) as { data: string; channel: string; correlation_id: string };

    const parsed = JSON.parse(row.data);
    expect(parsed.orderId).toBe('ORD-123');
    expect(parsed.amount).toBe(99.99);
    expect(row.channel).toBe('web');
    expect(row.correlation_id).toBe('corr-456');
  });

  // =========================================================================
  // flush() drains pending writes (batched mode)
  // =========================================================================

  it('flush() drains pending writes', async () => {
    journal = createEventJournal(db, { batched: true });
    journal.ensureTable();

    const event = new GenericEvent('test', 'src', { msg: 'hello' });
    await journal.before!(event);

    await journal.flush();

    const rows = db.prepare('SELECT * FROM bus_events').all();
    expect(rows).toHaveLength(1);
  });
});
