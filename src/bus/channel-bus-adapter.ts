/**
 * Adapts the class-based MessageBus to the string-based interface
 * expected by cambot-channels.
 *
 * cambot-channels emits plain-object events with { type, source, data }
 * and subscribes by string type. The agent's MessageBus routes by instanceof.
 * This adapter bridges the two by converting in both directions.
 */

import { logger } from '../logger.js';
import type { NewMessage } from '../types.js';
import type { MessageBus } from './message-bus.js';
import { InboundMessage } from './events/inbound-message.js';
import { ChatMetadata } from './events/chat-metadata.js';
import { OutboundMessage } from './events/outbound-message.js';
import { TypingUpdate } from './events/typing-update.js';

/** Plain-object event shape that cambot-channels emits/consumes. */
interface ChannelBusEvent {
  type: string;
  source: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/** String-based bus interface matching cambot-channels MessageBus. */
export interface ChannelMessageBus {
  emitAsync(event: ChannelBusEvent): Promise<void>;
  on(
    eventType: string,
    handler: (event: ChannelBusEvent) => void | Promise<void>,
    options?: { id?: string; priority?: number; source?: string },
  ): () => void;
}

/** Convert a plain-object event to the corresponding BusEvent class instance. */
async function emitAsClass(bus: MessageBus, event: ChannelBusEvent): Promise<void> {
  switch (event.type) {
    case 'message.inbound': {
      const { jid, message, channel } = event.data as {
        jid: string;
        message: NewMessage;
        channel?: string;
      };
      await bus.emit(new InboundMessage(event.source, jid, message, { channel }));
      break;
    }
    case 'chat.metadata': {
      const { jid, name, channel, isGroup } = event.data as {
        jid: string;
        name?: string;
        channel?: string;
        isGroup?: boolean;
      };
      await bus.emit(new ChatMetadata(event.source, jid, { name, channel, isGroup }));
      break;
    }
    case 'message.outbound': {
      const { jid, text, broadcast } = event.data as {
        jid: string;
        text: string;
        broadcast?: boolean;
      };
      await bus.emit(new OutboundMessage(event.source, jid, text, { broadcast }));
      break;
    }
    case 'typing.update': {
      const { jid, isTyping } = event.data as { jid: string; isTyping: boolean };
      await bus.emit(new TypingUpdate(event.source, jid, isTyping));
      break;
    }
    default:
      logger.debug({ type: event.type }, 'ChannelBusAdapter: unhandled event type');
      break;
  }
}

/**
 * Wraps the class-based MessageBus with the string-based interface
 * that cambot-channels expects.
 */
export function createChannelBusAdapter(bus: MessageBus): ChannelMessageBus {
  return {
    emitAsync: (event) => emitAsClass(bus, event),

    on(eventType, handler, options) {
      switch (eventType) {
        case 'message.outbound':
          return bus.on(OutboundMessage, async (event) => {
            await handler({
              type: 'message.outbound',
              source: event.source,
              timestamp: event.timestamp,
              data: { jid: event.jid, text: event.text, broadcast: event.broadcast },
            });
          }, options);
        case 'typing.update':
          return bus.on(TypingUpdate, async (event) => {
            await handler({
              type: 'typing.update',
              source: event.source,
              timestamp: event.timestamp,
              data: { jid: event.jid, isTyping: event.isTyping },
            });
          }, options);
        default:
          logger.debug({ eventType }, 'ChannelBusAdapter: unhandled on() event type');
          return () => {};
      }
    },
  };
}
