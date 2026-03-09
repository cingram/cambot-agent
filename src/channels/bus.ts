/**
 * BusChannel — Minimal channel for CLI-to-agent communication via the bus.
 *
 * Inbound messages arrive over the CambotSocketServer from bus-send.ts CLI.
 * Outbound messages are sent back over the socket connection.
 *
 * Always configured (like the file channel) — zero runtime cost when idle.
 */
import { MAIN_GROUP_FOLDER } from '../config/config.js';
import { logger } from '../logger.js';
import type { Channel, ChannelOpts } from '../types.js';

const BUS_MAIN_JID = 'bus:main';

export class BusChannel implements Channel {
  readonly name = 'bus';

  private connected = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Register bus:main as the main group (no trigger required)
    this.opts.registerGroup(BUS_MAIN_JID, {
      name: 'Bus',
      folder: MAIN_GROUP_FOLDER,
      trigger: '',
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });

    this.connected = true;
    logger.info('Bus channel connected');
  }

  async sendMessage(_jid: string, _text: string): Promise<void> {
    // Bus responses are handled via socket frames, not file writes
    // The socket handler for bus.message replies directly to the requesting frame
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('bus:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}
