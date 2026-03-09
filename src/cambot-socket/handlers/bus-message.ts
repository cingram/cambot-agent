/**
 * bus.message handler — processes messages from the bus-send CLI.
 *
 * Emits an InboundMessage on the bus, which flows through the normal
 * message routing pipeline. Waits for the agent response and replies
 * to the CLI with the result.
 */

import { z } from 'zod';

import { FRAME_TYPES } from '../protocol/types.js';
import { InboundMessage, OutboundMessage } from '../../bus/index.js';
import { logger } from '../../logger.js';
import type { CommandRegistry } from './registry.js';

const BusMessageSchema = z.object({
  message: z.string().min(1),
  agent: z.string().optional(),
  group: z.string().optional(),
  senderName: z.string().default('Bus CLI'),
});

type BusMessagePayload = z.infer<typeof BusMessageSchema>;

export function registerBusMessage(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.BUS_MESSAGE,
    BusMessageSchema,
    'any',
    async (payload: BusMessagePayload, frame, connection, deps) => {
      const { bus, registeredGroups } = deps;

      // Determine the target JID
      let targetJid = 'bus:main';

      if (payload.agent) {
        // Target a specific persistent agent
        const agentRepo = deps.agentRepo;
        if (!agentRepo) {
          connection.replyError(frame, 'NO_AGENT_REPO', 'Agent repository not available');
          return;
        }
        const agent = agentRepo.getById(payload.agent);
        if (!agent) {
          connection.replyError(frame, 'AGENT_NOT_FOUND', `Agent "${payload.agent}" not found`);
          return;
        }
        // Use agent spawner for direct invocation
        if (deps.agentSpawner) {
          const startTime = Date.now();
          try {
            const result = await deps.agentSpawner.spawn(
              agent,
              payload.message,
              `bus:${payload.agent}`,
              300_000,
            );
            connection.reply(frame, FRAME_TYPES.BUS_MESSAGE, {
              status: result.status,
              text: result.content,
              durationMs: result.durationMs,
            });
          } catch (err) {
            connection.reply(frame, FRAME_TYPES.BUS_MESSAGE, {
              status: 'error',
              text: `Agent spawn failed: ${err instanceof Error ? err.message : String(err)}`,
              durationMs: Date.now() - startTime,
            });
          }
          return;
        }
        connection.replyError(frame, 'NO_SPAWNER', 'Agent spawner not available');
        return;
      }

      if (payload.group) {
        // Find the JID for the group folder
        const groups = registeredGroups();
        const entry = Object.entries(groups).find(([, g]) => g.folder === payload.group);
        if (entry) {
          targetJid = entry[0];
        } else {
          connection.replyError(frame, 'GROUP_NOT_FOUND', `Group folder "${payload.group}" not found`);
          return;
        }
      }

      // Emit the inbound message
      const startTime = Date.now();
      const msgId = `bus-${Date.now()}`;
      const msg = {
        id: msgId,
        chat_jid: targetJid,
        sender: 'bus-cli',
        sender_name: payload.senderName,
        content: payload.message,
        timestamp: new Date().toISOString(),
      };

      // Register outbound listener BEFORE emitting inbound to avoid race condition
      const responsePromise = new Promise<{ text: string; durationMs: number }>((resolve) => {
        const timeout = setTimeout(() => {
          cleanup();
          resolve({
            text: 'Response timeout (300s) — the agent may still be processing',
            durationMs: Date.now() - startTime,
          });
        }, 300_000);

        const cleanup = bus.on(OutboundMessage, (event) => {
          if (event.jid === targetJid) {
            clearTimeout(timeout);
            cleanup();
            resolve({
              text: event.text,
              durationMs: Date.now() - startTime,
            });
          }
        }, { id: `bus-response-${frame.id}`, priority: 200, source: 'bus-message-handler' });
      });

      await bus.emit(
        new InboundMessage('bus', targetJid, msg, { channel: 'bus' }),
      );

      const response = await responsePromise;
      connection.reply(frame, FRAME_TYPES.BUS_MESSAGE, {
        status: 'success',
        text: response.text,
        durationMs: response.durationMs,
      });

      logger.info(
        { targetJid, durationMs: response.durationMs },
        'Bus message processed',
      );
    },
  );
}
