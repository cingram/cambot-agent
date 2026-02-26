/**
 * Lightweight message bus for event-driven message routing.
 *
 * Implements the MessageBus interface from types.ts.
 * Structurally compatible with cambot-core's EventBus — when cambot-core
 * is available, its EventBus can be used as a drop-in replacement.
 */

import type { MessageBus, MessageBusEvent } from './types.js';

type AsyncHandler = (event: MessageBusEvent) => void | Promise<void>;

interface HandlerRegistration {
  id: string;
  eventType: string;
  handler: AsyncHandler;
  priority: number;
  source: string;
}

export function createMessageBus(): MessageBus {
  let handlers: HandlerRegistration[] = [];
  let idCounter = 0;

  return {
    emit(event: MessageBusEvent): void {
      const matching = handlers
        .filter(h => h.eventType === '*' || h.eventType === event.type)
        .sort((a, b) => a.priority - b.priority);

      for (const registration of matching) {
        try {
          registration.handler(event);
        } catch (err) {
          console.error(`[MessageBus] Handler ${registration.id} failed:`, err);
        }
      }
    },

    async emitAsync(event: MessageBusEvent): Promise<void> {
      const matching = handlers
        .filter(h => h.eventType === '*' || h.eventType === event.type)
        .sort((a, b) => a.priority - b.priority);

      for (const registration of matching) {
        if (event.cancelled) break;
        try {
          await registration.handler(event);
        } catch (err) {
          console.error(`[MessageBus] Handler ${registration.id} failed:`, err);
        }
      }
    },

    on(
      eventType: string,
      handler: AsyncHandler,
      options?: { id?: string; priority?: number; source?: string },
    ): () => void {
      const id = options?.id ?? `handler_${++idCounter}`;
      const registration: HandlerRegistration = {
        id,
        eventType,
        handler,
        priority: options?.priority ?? 100,
        source: options?.source ?? 'cambot-agent',
      };
      handlers.push(registration);
      return () => {
        handlers = handlers.filter(h => h.id !== id);
      };
    },
  };
}
