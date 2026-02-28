import fs from 'fs';
import path from 'path';

import { DATA_DIR, STORE_DIR, WORKSPACE_MCP_PORT } from '../config.js';
import { getEmailState, setEmailState } from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts } from '../types.js';

export interface ChannelDefinition {
  name: string;
  isConfigured: () => boolean;
  create: (opts: ChannelOpts) => Promise<Channel>;
}

function getConfiguredChannelNames(): Set<string> {
  const env = readEnvFile(['CHANNELS']);
  const raw = (process.env.CHANNELS || env.CHANNELS || '').toLowerCase();
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

const definitions: ChannelDefinition[] = [
  {
    name: 'whatsapp',
    isConfigured: () => {
      const explicit = getConfiguredChannelNames();
      // If CHANNELS is set, only load WhatsApp if explicitly listed
      if (explicit.size > 0) return explicit.has('whatsapp');
      // If CHANNELS is not set, auto-detect from auth creds
      return fs.existsSync(path.join(STORE_DIR, 'auth', 'creds.json'));
    },
    create: async (opts) => {
      const { WhatsAppChannel } = await import('./whatsapp.js');
      return new WhatsAppChannel(opts);
    },
  },
  {
    name: 'cli',
    isConfigured: () => getConfiguredChannelNames().has('cli'),
    create: async (opts) => {
      const { CliChannel } = await import('./cli.js');
      return new CliChannel(opts);
    },
  },
  {
    name: 'web',
    isConfigured: () => getConfiguredChannelNames().has('web'),
    create: async (opts) => {
      const { WebChannel } = await import('./web.js');
      const port = parseInt(process.env.WEB_CHANNEL_PORT || '3100', 10);
      return new WebChannel(opts, port);
    },
  },
  {
    name: 'email',
    isConfigured: () => {
      const explicit = getConfiguredChannelNames();
      if (explicit.has('email')) return true;
      // Auto-detect: if Google OAuth credentials are present and no explicit CHANNELS set
      if (explicit.size === 0) {
        const env = readEnvFile([
          'GOOGLE_OAUTH_CLIENT_ID',
          'GOOGLE_OAUTH_CLIENT_SECRET',
          'USER_GOOGLE_EMAIL',
        ]);
        return !!(
          env.GOOGLE_OAUTH_CLIENT_ID &&
          env.GOOGLE_OAUTH_CLIENT_SECRET &&
          env.USER_GOOGLE_EMAIL
        );
      }
      return false;
    },
    create: async (opts) => {
      const { EmailChannel } = await import('./email.js');
      const mcpUrl = `http://127.0.0.1:${WORKSPACE_MCP_PORT}/mcp`;
      const pollInterval = parseInt(process.env.EMAIL_POLL_INTERVAL || '30000', 10);
      return new EmailChannel(opts, {
        workspaceMcpUrl: mcpUrl,
        pollIntervalMs: pollInterval,
        getLastPollTimestamp: () => getEmailState('last_poll_timestamp'),
        setLastPollTimestamp: (ts) => setEmailState('last_poll_timestamp', ts),
      });
    },
  },
  {
    name: 'file',
    isConfigured: () => true, // always available — zero runtime cost, needed for workflow delivery
    create: async () => {
      const { FileChannel } = await import('./file.js');
      return new FileChannel({ baseDir: path.join(DATA_DIR, 'workflows') });
    },
  },
];

export async function loadChannels(opts: ChannelOpts): Promise<Channel[]> {
  const channels: Channel[] = [];
  for (const def of definitions) {
    if (!def.isConfigured()) {
      logger.debug({ channel: def.name }, 'Channel not configured, skipping');
      continue;
    }
    logger.info({ channel: def.name }, 'Loading channel');
    const channel = await def.create(opts);
    await channel.connect();
    channels.push(channel);
  }
  if (channels.length === 0) {
    throw new Error(
      'No channels configured. Set CHANNELS=cli in .env or run WhatsApp auth.',
    );
  }
  return channels;
}
