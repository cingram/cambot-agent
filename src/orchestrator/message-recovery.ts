import { ASSISTANT_NAME } from '../config/config.js';
import { getMessagesSince } from '../db/index.js';
import type { GroupQueue } from '../groups/group-queue.js';
import { logger } from '../logger.js';
import type { RouterState } from './router-state.js';

/**
 * Checks all registered groups for unprocessed messages on startup.
 * Enqueues any group with pending messages so the processor picks them up.
 *
 * Call once at startup, before bus handlers are active.
 */
export function recoverPendingMessages(
  state: RouterState,
  queue: GroupQueue,
): void {
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
}
