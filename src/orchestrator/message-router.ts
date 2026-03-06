import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
} from '../config/config.js';
import { getMessagesSince } from '../db/index.js';
import type { GroupQueue } from '../groups/group-queue.js';
import { formatMessages } from '../utils/router.js';
import { logger } from '../logger.js';
import type { Channel, MessageBus } from '../types.js';
import type { LifecycleInterceptor } from '../utils/lifecycle-interceptor.js';
import { InboundMessage, TypingUpdate } from '../bus/index.js';
import type { RouterState } from './router-state.js';

export interface MessageRouterDeps {
  bus: MessageBus;
  state: RouterState;
  queue: GroupQueue;
  getChannels: () => Channel[];
  getInterceptor: () => LifecycleInterceptor | null;
}

/**
 * Registers a reactive bus handler that routes inbound messages to containers.
 * Replaces the polling MessageLoop with instant, event-driven routing.
 *
 * Priority 110 ensures the message is already in SQLite (db-store at 100)
 * before routing logic runs.
 */
export function registerMessageRouter(deps: MessageRouterDeps): () => void {
  const { bus, state, queue, getChannels, getInterceptor } = deps;

  return bus.on(InboundMessage, (event) => {
    if (event.cancelled) return;

    const chatJid = event.jid;

    // Guard: registered group?
    const group = state.getRegisteredGroup(chatJid);
    if (!group) return;

    // Guard: channel owns JID?
    const channels = getChannels();
    if (!channels.some(ch => ch.ownsJid(chatJid))) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping message');
      return;
    }

    // Guard: trigger required?
    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
    const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
    if (needsTrigger && !TRIGGER_PATTERN.test(event.message.content.trim())) {
      return; // Stored in DB, awaiting trigger
    }

    // Try to pipe to active container
    const pipeSince = queue.getLastPipedTimestamp(chatJid)
      || state.getAgentTimestamp(chatJid);
    const allPending = getMessagesSince(chatJid, pipeSince, ASSISTANT_NAME);
    const messagesToSend = allPending.length > 0 ? allPending : [event.message];
    const formatted = formatMessages(messagesToSend);
    const interceptor = getInterceptor();
    const safeFormatted = interceptor
      ? interceptor.redactPrompt(formatted).redacted
      : formatted;

    const latestTs = messagesToSend[messagesToSend.length - 1]?.timestamp;
    if (queue.sendMessage(chatJid, safeFormatted, latestTs)) {
      logger.info(
        { chatJid, count: messagesToSend.length },
        'Piped messages to active container via IPC',
      );
      state.setAgentTimestamp(chatJid, messagesToSend[messagesToSend.length - 1].timestamp);
      state.save();
      bus.emit(new TypingUpdate('agent', chatJid, true)).catch(() => {});
    } else {
      logger.info(
        { chatJid, count: messagesToSend.length },
        'No active container, enqueueing for new container',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }, { id: 'message-router', priority: 110, sequential: true, source: 'cambot-agent' });
}
