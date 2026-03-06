import readline from 'readline';

import { ASSISTANT_NAME, MAIN_GROUP_FOLDER } from '../config/config.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts } from '../types.js';
import { InboundMessage, ChatMetadata } from '../bus/index.js';

const CLI_JID = 'cli:console';

export class CliChannel implements Channel {
  name = 'cli';

  private rl: readline.Interface | null = null;
  private connected = false;
  private opts: ChannelOpts;

  constructor(opts: ChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Auto-register as main group with no trigger requirement
    this.opts.registerGroup(CLI_JID, {
      name: 'CLI',
      folder: MAIN_GROUP_FOLDER,
      trigger: `@${ASSISTANT_NAME}`,
      added_at: new Date().toISOString(),
      requiresTrigger: false,
    });

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `${ASSISTANT_NAME}> `,
    });

    this.rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;

      const timestamp = new Date().toISOString();
      const msgId = `cli-${Date.now()}`;

      this.opts.onAuditEvent?.({
        type: 'audit.message_inbound',
        channel: 'cli',
        data: {
          chatJid: CLI_JID,
          sender: 'cli:user',
          senderName: 'User',
          messageId: msgId,
          isGroup: false,
          contentLength: text.length,
        },
      });

      this.opts.messageBus.emit(new ChatMetadata('cli', CLI_JID, { name: 'CLI', channel: 'cli', isGroup: false })).catch(() => {});
      this.opts.messageBus.emit(new InboundMessage('cli', CLI_JID, {
        id: msgId,
        chat_jid: CLI_JID,
        sender: 'cli:user',
        sender_name: 'User',
        content: text,
        timestamp,
        is_from_me: false,
        is_bot_message: false,
      }, { channel: 'cli' })).catch(() => {});
    });

    this.rl.on('close', () => {
      this.connected = false;
      logger.info('CLI channel closed');
    });

    this.connected = true;
    logger.info('CLI channel connected');
    this.rl.prompt();
  }

  async sendMessage(_jid: string, text: string): Promise<void> {
    console.log(`${ASSISTANT_NAME}: ${text}`);
    this.rl?.prompt();
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('cli:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.rl?.close();
    this.rl = null;
  }
}
