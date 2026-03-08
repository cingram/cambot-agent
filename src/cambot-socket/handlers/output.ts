/**
 * output + heartbeat handlers — container lifecycle frames.
 *
 * output: routes container output frames to runner callbacks.
 * heartbeat: acknowledges container heartbeat frames (no-op, prevents UNKNOWN_COMMAND).
 *
 * The runner registers a callback per group BEFORE spawning the container.
 * When an output frame arrives, the registry dispatches it here, which
 * routes it to the correct callback. This eliminates the race condition
 * where output arrives before the runner's polling loop finds the connection.
 */

import { z } from 'zod';

import type { ContainerOutput } from '../../container/runner.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const OutputSchema = z.object({}).passthrough();
const HeartbeatSchema = z.object({}).passthrough();

type OutputCallback = (output: ContainerOutput) => void;

/** Per-group callback map. Keyed by group folder. */
const outputCallbacks = new Map<string, OutputCallback>();

/** Register a callback to receive output frames for a group. Call before spawning. */
export function registerOutputCallback(group: string, callback: OutputCallback): void {
  outputCallbacks.set(group, callback);
}

/** Remove the output callback for a group. Call on container exit. */
export function removeOutputCallback(group: string): void {
  outputCallbacks.delete(group);
}

/** Register output and heartbeat handlers with the command registry. */
export function registerOutputHandler(registry: CommandRegistry): void {
  registry.register(
    'output',
    OutputSchema,
    'any',
    async (_payload, frame, connection) => {
      const { group } = connection.identity;
      const callback = outputCallbacks.get(group);

      if (callback) {
        callback(frame.payload as unknown as ContainerOutput);
      } else {
        logger.debug(
          { group, type: frame.type },
          'Output frame received but no callback registered',
        );
      }
    },
  );

  // Heartbeat frames are informational — just log and acknowledge.
  registry.register(
    'heartbeat',
    HeartbeatSchema,
    'any',
    async (_payload, _frame, connection) => {
      logger.debug(
        { group: connection.identity.group },
        'Heartbeat received',
      );
    },
  );
}
