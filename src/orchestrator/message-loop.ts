import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
} from '../config/config.js';
import {
  getMessagesSince,
  getNewMessages,
} from '../db/index.js';
import { GroupQueue } from '../groups/group-queue.js';
import { formatMessages } from '../utils/router.js';
import { logger } from '../logger.js';
import type { Channel, MessageBus } from '../types.js';
import type { LifecycleInterceptor } from '../utils/lifecycle-interceptor.js';
import { TypingUpdate } from '../bus/index.js';
import type { RouterState } from './router-state.js';

export interface MessageLoopDeps {
  state: RouterState;
  queue: GroupQueue;
  bus: MessageBus;
  getChannels: () => Channel[];
  getInterceptor: () => LifecycleInterceptor | null;
}

export class MessageLoop {
  private running = false;
  private deps: MessageLoopDeps;

  constructor(deps: MessageLoopDeps) {
    this.deps = deps;
  }

  async start(): Promise<void> {
    if (this.running) {
      logger.debug('Message loop already running, skipping duplicate start');
      return;
    }
    this.running = true;

    logger.info(`CamBot-Agent running (trigger: @${ASSISTANT_NAME})`);

    const { state, queue, bus } = this.deps;

    while (true) {
      try {
        const jids = Object.keys(state.getRegisteredGroups());
        const { messages, newTimestamp } = getNewMessages(jids, state.getLastTimestamp(), ASSISTANT_NAME);

        if (messages.length > 0) {
          logger.info({ count: messages.length }, 'New messages');

          // Advance the "seen" cursor
          state.setLastTimestamp(newTimestamp);
          state.save();

          // Deduplicate by group
          const messagesByGroup = new Map<string, typeof messages>();
          for (const msg of messages) {
            const existing = messagesByGroup.get(msg.chat_jid);
            if (existing) {
              existing.push(msg);
            } else {
              messagesByGroup.set(msg.chat_jid, [msg]);
            }
          }

          const channels = this.deps.getChannels();
          const interceptor = this.deps.getInterceptor();

          for (const [chatJid, groupMessages] of messagesByGroup) {
            const group = state.getRegisteredGroup(chatJid);
            if (!group) continue;

            const hasChannel = channels.some(ch => ch.ownsJid(chatJid));
            if (!hasChannel) {
              logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
              continue;
            }

            const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
            const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

            if (needsTrigger) {
              const hasTrigger = groupMessages.some((m) =>
                TRIGGER_PATTERN.test(m.content.trim()),
              );
              if (!hasTrigger) continue;
            }

            // Pull messages since the latest piped timestamp
            const pipeSince = queue.getLastPipedTimestamp(chatJid)
              || state.getAgentTimestamp(chatJid);
            const allPending = getMessagesSince(chatJid, pipeSince, ASSISTANT_NAME);
            const messagesToSend = allPending.length > 0 ? allPending : groupMessages;
            const formatted = formatMessages(messagesToSend);
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
          }
        }
      } catch (err) {
        logger.error({ err }, 'Error in message loop');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
    }
  }

  recoverPendingMessages(): void {
    const { state, queue } = this.deps;
    const registeredGroups = state.getRegisteredGroups();

    for (const [chatJid, group] of Object.entries(registeredGroups)) {
      const sinceTimestamp = state.getAgentTimestamp(chatJid);
      const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
      if (pending.length > 0) {
        logger.info(
          { group: group.name, pendingCount: pending.length },
          'Recovery: found unprocessed messages',
        );
        queue.enqueueMessageCheck(chatJid);
      }
    }

    // Sync global "seen" cursor
    const allAgentTimestamps = state.getAllAgentTimestamps();
    const maxAgentTs = Object.values(allAgentTimestamps).reduce(
      (max, ts) => (ts > max ? ts : max),
      state.getLastTimestamp(),
    );
    if (maxAgentTs > state.getLastTimestamp()) {
      logger.info(
        { old: state.getLastTimestamp(), new: maxAgentTs },
        'Recovery: advancing lastTimestamp to match agent cursors',
      );
      state.setLastTimestamp(maxAgentTs);
      state.save();
    }
  }
}
