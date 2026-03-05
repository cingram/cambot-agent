import { BusEvent } from './bus-event.js';
import { logger } from '../logger.js';

/** Constructor type for routing — `on(InboundMessage, handler)`. */
export type EventClass<T extends BusEvent = BusEvent> = abstract new (...args: never[]) => T;

type AsyncHandler<T extends BusEvent> = (event: T) => void | Promise<void>;

interface HandlerRegistration<T extends BusEvent = BusEvent> {
  id: string;
  eventClass: EventClass<T>;
  handler: AsyncHandler<T>;
  priority: number;
  source: string;
  sequential: boolean;
}

export interface HandlerOptions {
  id?: string;
  priority?: number;
  source?: string;
  /** When true, forces ALL handlers for this event type to run sequentially. */
  sequential?: boolean;
}

/** Lifecycle hooks for observing or intercepting bus events. */
export interface BusLifecycleHooks {
  onEventReceived?(event: BusEvent): boolean | void;
  onAfterEmit?(event: BusEvent): void;
  onHandlerError?(error: unknown, event: BusEvent, handlerId: string): boolean | void;
  onHandlerStart?(event: BusEvent, handlerId: string): void;
  onCancel?(event: BusEvent, cancelledByHandlerId: string): void;
}

export class MessageBus {
  private handlers: HandlerRegistration[] = [];
  private idCounter = 0;
  private hooks: BusLifecycleHooks;

  constructor(hooks: BusLifecycleHooks = {}) {
    this.hooks = hooks;
  }

  /** Subscribe to events by class. Handler receives the concrete type. */
  on<T extends BusEvent>(
    eventClass: EventClass<T>,
    handler: AsyncHandler<T>,
    options?: HandlerOptions,
  ): () => void {
    const id = options?.id ?? `handler_${++this.idCounter}`;
    const registration: HandlerRegistration<T> = {
      id,
      eventClass,
      handler,
      priority: options?.priority ?? 100,
      source: options?.source ?? 'cambot-agent',
      sequential: options?.sequential ?? false,
    };
    this.handlers.push(registration as unknown as HandlerRegistration);
    return () => {
      this.handlers = this.handlers.filter(h => h.id !== id);
    };
  }

  /**
   * Emit an event. Auto-decides parallel vs sequential:
   * - If ANY matching handler declares `sequential: true`, all run sequentially
   *   in priority order (supports cancellation).
   * - Otherwise, all run concurrently via `Promise.allSettled`.
   */
  async emit(event: BusEvent): Promise<void> {
    if (this.hooks.onEventReceived?.(event) === false) return;

    const matching = this.handlers
      .filter(h => event instanceof (h.eventClass as Function))
      .sort((a, b) => a.priority - b.priority);

    if (matching.length === 0) {
      this.hooks.onAfterEmit?.(event);
      return;
    }

    const needsSequential = matching.some(h => h.sequential);

    if (needsSequential) {
      await this.runSequential(matching, event);
    } else {
      await this.runParallel(matching, event);
    }

    this.hooks.onAfterEmit?.(event);
  }

  private async runSequential(handlers: HandlerRegistration[], event: BusEvent): Promise<void> {
    for (const reg of handlers) {
      if (event.cancelled) {
        this.hooks.onCancel?.(event, reg.id);
        break;
      }
      this.hooks.onHandlerStart?.(event, reg.id);
      try {
        await reg.handler(event);
      } catch (err) {
        if (this.hooks.onHandlerError?.(err, event, reg.id) !== true) {
          logger.error({ err, handlerId: reg.id, eventClass: reg.eventClass.name }, 'MessageBus handler failed');
        }
      }
    }
  }

  private async runParallel(handlers: HandlerRegistration[], event: BusEvent): Promise<void> {
    const results = await Promise.allSettled(
      handlers.map(async (reg) => {
        this.hooks.onHandlerStart?.(event, reg.id);
        return reg.handler(event);
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        const reg = handlers[i];
        if (this.hooks.onHandlerError?.(result.reason, event, reg.id) !== true) {
          logger.error(
            { err: result.reason, handlerId: reg.id, eventClass: reg.eventClass.name },
            'MessageBus handler failed',
          );
        }
      }
    }
  }
}

export function createMessageBus(hooks: BusLifecycleHooks = {}): MessageBus {
  return new MessageBus(hooks);
}
