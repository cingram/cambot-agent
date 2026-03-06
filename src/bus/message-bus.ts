import { BusEvent } from './bus-event.js';
import type { EnvelopeOptions } from './envelope.js';
import type { BusMiddleware } from './middleware.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Constructor type for class-based routing — `on(InboundMessage, handler)`. */
export type EventClass<T extends BusEvent = BusEvent> = abstract new (...args: never[]) => T;

type AsyncHandler<T extends BusEvent> = (event: T) => void | Promise<void>;

export interface HandlerOptions {
  id?: string;
  priority?: number;
  source?: string;
  /**
   * When true, forces ALL matching handlers for this emit to run sequentially
   * in priority order. This is an all-or-nothing flag: if any one handler sets
   * `sequential: true`, every handler for that event runs sequentially.
   * The `cancelled` flag only works in sequential mode.
   */
  sequential?: boolean;
  /** Property filter — event must match every key/value to be delivered. */
  filter?: Record<string, unknown>;
}

/** Descriptor returned by `listEventTypes()`. */
export interface EventTypeDescriptor {
  type: string;
  description: string;
}

// ---------------------------------------------------------------------------
// GenericEvent — for string-based events without a dedicated class
// ---------------------------------------------------------------------------

export class GenericEvent extends BusEvent {
  readonly data: Record<string, unknown>;

  constructor(
    type: string,
    source: string,
    data: Record<string, unknown>,
    envelope?: EnvelopeOptions,
  ) {
    super(type, source, envelope);
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Internal handler registration
// ---------------------------------------------------------------------------

interface HandlerRegistration<T extends BusEvent = BusEvent> {
  id: string;
  /** Set when registered with an EventClass; undefined for string/wildcard. */
  eventClass?: EventClass<T>;
  /** Set when registered with a string type or '*'. */
  eventType?: string;
  handler: AsyncHandler<T>;
  priority: number;
  source: string;
  sequential: boolean;
  filter?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MessageBus
// ---------------------------------------------------------------------------

export class MessageBus {
  private handlers: HandlerRegistration[] = [];
  private middlewares: BusMiddleware[] = [];
  private eventTypes: EventTypeDescriptor[] = [];
  private idCounter = 0;

  // -----------------------------------------------------------------------
  // Middleware
  // -----------------------------------------------------------------------

  /** Add a middleware to the pipeline. Middlewares run in registration order. Returns unsubscribe. */
  use(middleware: BusMiddleware): () => void {
    this.middlewares.push(middleware);
    return () => {
      this.middlewares = this.middlewares.filter((m) => m !== middleware);
    };
  }

  // -----------------------------------------------------------------------
  // Event type registry
  // -----------------------------------------------------------------------

  /** Register a known event type for discoverability. */
  registerEventType(type: string, description: string): void {
    const existing = this.eventTypes.find((e) => e.type === type);
    if (existing) {
      existing.description = description;
    } else {
      this.eventTypes.push({ type, description });
    }
  }

  /** List all registered event types. */
  listEventTypes(): readonly EventTypeDescriptor[] {
    return this.eventTypes;
  }

  // -----------------------------------------------------------------------
  // Subscribe
  // -----------------------------------------------------------------------

  /**
   * Subscribe to events.
   *
   * Accepts either:
   * - An EventClass for instanceof matching (existing pattern)
   * - A string type for exact-match or '*' wildcard (new pattern)
   *
   * Returns an unsubscribe function.
   */
  on<T extends BusEvent>(
    selector: EventClass<T> | string,
    handler: AsyncHandler<T>,
    options?: HandlerOptions,
  ): () => void {
    const id = options?.id ?? `handler_${++this.idCounter}`;

    const registration: HandlerRegistration = {
      id,
      handler: handler as AsyncHandler<BusEvent>,
      priority: options?.priority ?? 100,
      source: options?.source ?? 'cambot-agent',
      sequential: options?.sequential ?? false,
      filter: options?.filter,
      eventClass: typeof selector === 'string' ? undefined : selector as EventClass,
      eventType: typeof selector === 'string' ? selector : undefined,
    };

    const reg = registration;
    this.handlers.push(reg);

    return () => {
      this.handlers = this.handlers.filter((h) => h !== reg);
    };
  }

  // -----------------------------------------------------------------------
  // Emit
  // -----------------------------------------------------------------------

  /**
   * Emit an event through the middleware pipeline and to matching handlers.
   *
   * - Middleware `before` hooks run first; any returning `false` drops the event.
   * - Handlers execute in priority order (parallel or sequential).
   * - Middleware `after` hooks run after all handlers.
   */
  async emit(event: BusEvent): Promise<void> {
    // --- before middleware ---
    for (const mw of this.middlewares) {
      if (!mw.before) continue;
      try {
        const result = await mw.before(event);
        if (result === false) return;
      } catch (err) {
        logger.error({ err, middleware: mw.name }, 'Middleware before-hook threw');
      }
    }

    // --- match handlers ---
    const matching = this.matchHandlers(event);

    if (matching.length > 0) {
      const needsSequential = matching.some((h) => h.sequential);

      if (needsSequential) {
        await this.runSequential(matching, event);
      } else {
        await this.runParallel(matching, event);
      }
    }

    // --- after middleware ---
    for (const mw of this.middlewares) {
      if (!mw.after) continue;
      try {
        await mw.after(event);
      } catch (err) {
        logger.error({ err, middleware: mw.name }, 'Middleware after-hook threw');
      }
    }
  }

  // -----------------------------------------------------------------------
  // Matching
  // -----------------------------------------------------------------------

  private matchHandlers(event: BusEvent): HandlerRegistration[] {
    return this.handlers
      .filter((h) => this.matchesSelector(h, event) && this.matchesFilter(h, event))
      .sort((a, b) => a.priority - b.priority);
  }

  private matchesSelector(reg: HandlerRegistration, event: BusEvent): boolean {
    if (reg.eventClass) {
      return event instanceof (reg.eventClass as Function);
    }
    if (reg.eventType === '*') {
      return true;
    }
    return reg.eventType === event.type;
  }

  private matchesFilter(reg: HandlerRegistration, event: BusEvent): boolean {
    if (!reg.filter) return true;
    const ev = event as unknown as Record<string, unknown>;
    return Object.entries(reg.filter).every(([key, value]) => key in ev && ev[key] === value);
  }

  // -----------------------------------------------------------------------
  // Execution
  // -----------------------------------------------------------------------

  private async runSequential(
    handlers: HandlerRegistration[],
    event: BusEvent,
  ): Promise<void> {
    for (const reg of handlers) {
      if (event.cancelled) break;
      try {
        await reg.handler(event);
      } catch (err) {
        if (!(await this.invokeOnError(err, event, reg.id))) {
          logger.error(
            { err, handlerId: reg.id, eventType: event.type },
            'MessageBus handler failed',
          );
        }
      }
    }
  }

  private async runParallel(
    handlers: HandlerRegistration[],
    event: BusEvent,
  ): Promise<void> {
    const results = await Promise.allSettled(
      handlers.map(async (reg) => {
        if (event.cancelled) return; // best-effort check before launch
        return reg.handler(event);
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const reg = handlers[i];
        if (!(await this.invokeOnError(result.reason, event, reg.id))) {
          logger.error(
            { err: result.reason, handlerId: reg.id, eventType: event.type },
            'MessageBus handler failed',
          );
        }
      }
    }
  }

  /**
   * Run all middleware `onError` hooks. Returns `true` if any suppressed.
   */
  private async invokeOnError(
    error: unknown,
    event: BusEvent,
    handlerId: string,
  ): Promise<boolean> {
    let suppressed = false;
    for (const mw of this.middlewares) {
      if (!mw.onError) continue;
      try {
        if ((await mw.onError(error, event, handlerId)) === true) {
          suppressed = true;
        }
      } catch (mwErr) {
        logger.error(
          { err: mwErr, middleware: mw.name },
          'Middleware onError hook threw',
        );
      }
    }
    return suppressed;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a new MessageBus instance. */
export function createMessageBus(): MessageBus {
  return new MessageBus();
}
