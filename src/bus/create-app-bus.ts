/**
 * Bus composition root — creates a fully-configured MessageBus
 * with all middleware wired and event types registered.
 *
 * This is the single place where the bus backbone is assembled.
 * All subsystems (channels, agents, persistence) plug into the
 * bus returned by this factory.
 */

import type Database from 'better-sqlite3';
import { createMessageBus, type MessageBus } from './message-bus.js';
import { registerAllEventTypes } from './event-types.js';
import { createDedupFilter } from './middleware/dedup-filter.js';
import { createBackpressureMiddleware } from './middleware/backpressure.js';
import { createEventJournal, type EventJournal } from './middleware/event-journal.js';
import { createOutboundGuard, type OutboundGuardOptions } from './middleware/outbound-guard.js';
import { createInjectionScanner } from './middleware/injection-scanner.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppBusOptions {
  db: Database.Database;
  /** Max tracked event IDs for dedup. Default: 10_000 */
  dedupMaxSize?: number;
  /** In-flight event threshold before backpressure kicks in. Default: 500 */
  backpressureHighWaterMark?: number;
  /** Outbound guard config. Omit to use defaults. */
  outboundGuard?: Partial<OutboundGuardOptions>;
}

export interface AppBus {
  /** The configured MessageBus instance. */
  bus: MessageBus;
  /** The event journal (for querying persisted events). */
  journal: EventJournal;
  /** Flush pending writes and stop background drains. */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAppBus(opts: AppBusOptions): AppBus {
  const bus = createMessageBus();

  // 1. Register all known event types
  registerAllEventTypes(bus);

  // 2. Dedup filter — drop duplicate events by ID
  bus.use(createDedupFilter({ maxSize: opts.dedupMaxSize ?? 10_000 }));

  // 3. Injection scanner — detect prompt injection in untrusted inbound messages
  bus.use(createInjectionScanner());

  // 4. Outbound guard — rate limits and loop detection for outbound messages
  bus.use(createOutboundGuard({
    ...opts.outboundGuard,
    onLimitHit: (channel, jid, window) => {
      logger.warn({ channel, jid, window }, 'Outbound guard: rate limit hit');
    },
    onLoopDetected: (channel, jid, count) => {
      logger.warn({ channel, jid, count }, 'Outbound guard: reply loop detected');
    },
  }));

  // 5. Backpressure — warn when in-flight events exceed threshold
  bus.use(createBackpressureMiddleware({
    highWaterMark: opts.backpressureHighWaterMark ?? 500,
    strategy: 'warn',
    onBackpressure: (inFlight) => {
      logger.warn({ inFlight }, 'Bus backpressure: high in-flight event count');
    },
  }));

  // 6. Event journal — persist all events to SQLite for audit/replay
  const journal = createEventJournal(opts.db);
  journal.ensureTable();
  bus.use(journal);

  logger.info('AppBus initialized with dedup, backpressure, and event journal');

  return {
    bus,
    journal,
    async shutdown() {
      await journal.flush();
      journal.stop();
      logger.info('AppBus shut down');
    },
  };
}
