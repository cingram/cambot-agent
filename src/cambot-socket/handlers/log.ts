/**
 * log handler — forwards structured container log frames through host pino.
 *
 * The agent-runner sends log frames with a level and message.
 * This handler re-emits them through the host logger at the correct level,
 * tagged with the container/group name so they show in the server console.
 */

import { z } from 'zod';

import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const LogSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  message: z.string(),
});

/** Register the log handler with the command registry. */
export function registerLogHandler(registry: CommandRegistry): void {
  registry.register(
    'log',
    LogSchema,
    'any',
    async (payload, _frame, connection) => {
      const { group } = connection.identity;
      const { level, message } = payload;
      logger[level]({ container: group }, message);
    },
  );
}
