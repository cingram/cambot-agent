/**
 * Native iMessage Bridge Service — runs the AppleScript bridge in-process.
 *
 * The native iMessage provider reads chat.db directly but needs an HTTP bridge
 * to send messages via AppleScript. This service starts the bridge as an
 * in-process Hono server so it's managed alongside the main app lifecycle.
 *
 * Only needed when IMESSAGE_PROVIDER=native.
 */

import type { Server } from 'node:http';

import { logger } from '../logger.js';

export interface NativeBridgeConfig {
  port: number;
}

export interface NativeBridgeService {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  getUrl(): string;
}

export function createNativeBridgeService(
  config: NativeBridgeConfig,
): NativeBridgeService {
  let server: Server | null = null;

  return {
    async start(): Promise<void> {
      if (server) return;

      const { createNativeBridgeApp } = await import('cambot-channels');
      const { serve } = await import('@hono/node-server');

      const app = createNativeBridgeApp();

      server = serve(
        {
          fetch: app.fetch,
          port: config.port,
          hostname: '127.0.0.1',
        },
        () => {
          logger.info({ port: config.port }, 'Native iMessage bridge listening');
        },
      ) as Server;
    },

    async stop(): Promise<void> {
      if (!server) return;

      const s = server;
      server = null;

      await new Promise<void>((resolve) => {
        s.close(() => {
          logger.info('Native iMessage bridge stopped');
          resolve();
        });
      });
    },

    isRunning(): boolean {
      return server !== null;
    },

    getUrl(): string {
      return `http://127.0.0.1:${config.port}`;
    },
  };
}
