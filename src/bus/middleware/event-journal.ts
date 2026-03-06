/**
 * Event Journal middleware -- persists every bus event to SQLite for auditability and replay.
 */

import type Database from 'better-sqlite3';
import type { BusEvent } from '../bus-event.js';
import { extractDomainData } from '../event-serialization.js';
import type { BusMiddleware } from '../middleware.js';
import { createWriteQueue, type WriteQueue } from '../write-queue/write-queue.js';
import { logger } from '../../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EventJournalOptions {
  /** Use batched writes via write queue. Default: true */
  batched?: boolean;
}

export interface EventRecord {
  id: string;
  type: string;
  source: string;
  channel: string | null;
  correlationId: string | null;
  causationId: string | null;
  target: string | null;
  data: string; // JSON
  timestamp: string;
  processed: boolean;
}

export interface EventJournal extends BusMiddleware {
  /** Ensure the bus_events table exists. Call on startup. */
  ensureTable(): void;
  /** Flush any pending writes. */
  flush(): Promise<void>;
  /** Stop the write queue (for shutdown). */
  stop(): void;
  /** Query recent events. */
  queryEvents(opts?: {
    type?: string;
    limit?: number;
    since?: string;
  }): EventRecord[];
  /** Mark an event as processed. */
  markProcessed(eventId: string): void;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bus_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    channel TEXT,
    correlation_id TEXT,
    causation_id TEXT,
    target TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    timestamp TEXT NOT NULL,
    processed INTEGER NOT NULL DEFAULT 0 CHECK(processed IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bus_events_type ON bus_events(type);
  CREATE INDEX IF NOT EXISTS idx_bus_events_correlation ON bus_events(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_bus_events_timestamp ON bus_events(timestamp);
`;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeEventData(event: BusEvent): string {
  return JSON.stringify(extractDomainData(event));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEventJournal(
  db: Database.Database,
  opts?: EventJournalOptions,
): EventJournal {
  const batched = opts?.batched ?? true;
  let writeQueue: WriteQueue | null = null;

  // Prepared statements (created lazily after ensureTable)
  let insertStmt: Database.Statement | null = null;
  let markProcessedStmt: Database.Statement | null = null;

  function getInsertStmt(): Database.Statement {
    if (!insertStmt) {
      insertStmt = db.prepare(
        `INSERT OR IGNORE INTO bus_events (id, type, source, channel, correlation_id, causation_id, target, data, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
    }
    return insertStmt;
  }

  function getMarkProcessedStmt(): Database.Statement {
    if (!markProcessedStmt) {
      markProcessedStmt = db.prepare(
        'UPDATE bus_events SET processed = 1 WHERE id = ?',
      );
    }
    return markProcessedStmt;
  }

  function insertDirect(event: BusEvent): void {
    getInsertStmt().run(
      event.id,
      event.type,
      event.source,
      event.channel ?? null,
      event.correlationId ?? null,
      event.causationId ?? null,
      event.target ?? null,
      serializeEventData(event),
      event.timestamp,
    );
  }

  function insertBatched(event: BusEvent): void {
    if (!writeQueue) {
      writeQueue = createWriteQueue(db, {
        drainIntervalMs: 50,
        batchSize: 200,
      });
    }
    writeQueue.enqueue({
      tableName: 'bus_events',
      opType: 'insert',
      sql: `INSERT OR IGNORE INTO bus_events (id, type, source, channel, correlation_id, causation_id, target, data, timestamp)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        event.id,
        event.type,
        event.source,
        event.channel ?? null,
        event.correlationId ?? null,
        event.causationId ?? null,
        event.target ?? null,
        serializeEventData(event),
        event.timestamp,
      ],
    });
  }

  const journal: EventJournal = {
    name: 'event-journal',

    ensureTable(): void {
      db.exec(SCHEMA);
    },

    before(event: BusEvent): void {
      try {
        if (batched) {
          insertBatched(event);
        } else {
          insertDirect(event);
        }
      } catch (err) {
        logger.error({ err, eventId: event.id }, 'EventJournal: failed to persist event');
      }
    },

    after(event: BusEvent): void {
      try {
        if (batched) {
          // In batched mode, the INSERT may not have flushed yet.
          // Enqueue the UPDATE through the same write queue so it is ordered after the INSERT.
          if (writeQueue) {
            writeQueue.enqueue({
              tableName: 'bus_events',
              opType: 'update',
              sql: 'UPDATE bus_events SET processed = 1 WHERE id = ?',
              params: [event.id],
            });
          }
        } else {
          getMarkProcessedStmt().run(event.id);
        }
      } catch (err) {
        logger.error({ err, eventId: event.id }, 'EventJournal: failed to mark processed');
      }
    },

    async flush(): Promise<void> {
      if (writeQueue) {
        await writeQueue.flush();
      }
    },

    stop(): void {
      if (writeQueue) {
        writeQueue.stop();
        writeQueue = null;
      }
    },

    queryEvents(queryOpts?: {
      type?: string;
      limit?: number;
      since?: string;
    }): EventRecord[] {
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (queryOpts?.type) {
        conditions.push('type = ?');
        params.push(queryOpts.type);
      }
      if (queryOpts?.since) {
        conditions.push('timestamp >= ?');
        params.push(queryOpts.since);
      }

      const where =
        conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = queryOpts?.limit ?? 100;

      const sql = `SELECT id, type, source, channel, correlation_id, causation_id, target, data, timestamp, processed
                   FROM bus_events ${where}
                   ORDER BY timestamp DESC
                   LIMIT ?`;
      params.push(limit);

      const rows = db.prepare(sql).all(...params) as Array<{
        id: string;
        type: string;
        source: string;
        channel: string | null;
        correlation_id: string | null;
        causation_id: string | null;
        target: string | null;
        data: string;
        timestamp: string;
        processed: number;
      }>;

      return rows.map((r) => ({
        id: r.id,
        type: r.type,
        source: r.source,
        channel: r.channel,
        correlationId: r.correlation_id,
        causationId: r.causation_id,
        target: r.target,
        data: r.data,
        timestamp: r.timestamp,
        processed: r.processed === 1,
      }));
    },

    markProcessed(eventId: string): void {
      getMarkProcessedStmt().run(eventId);
    },
  };

  return journal;
}
