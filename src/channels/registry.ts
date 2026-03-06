import fs from 'fs';
import path from 'path';

import { DATA_DIR, FILE_CHANNEL_BASE_DIR, STORE_DIR, WORKSPACE_MCP_PORT } from '../config/config.js';
import { getEmailState, setEmailState } from '../db/index.js';
import { readEnvFile } from '../config/env.js';
import { logger } from '../logger.js';
import { Channel, ChannelOpts } from '../types.js';
import { createChannelBusAdapter } from '../bus/channel-bus-adapter.js';
import { InboundMessage, ChatMetadata } from '../bus/index.js';

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

const IMESSAGE_ENV_KEYS = [
  'IMESSAGE_PROVIDER',
  'LOOPMESSAGE_API_KEY',
  'LOOPMESSAGE_SENDER',
  'LOOPMESSAGE_WEBHOOK_PORT',
  'LOOPMESSAGE_WEBHOOK_AUTH',
  'BLUEBUBBLES_SERVER_URL',
  'BLUEBUBBLES_PASSWORD',
  'NATIVE_CHAT_DB_PATH',
  'NATIVE_BRIDGE_URL',
  'NATIVE_POLL_INTERVAL_MS',
  'IMESSAGE_PAIRING_ENABLED',
  'IMESSAGE_BOT_ADDRESS',
  'IMESSAGE_PAIRING_PORT',
  'IMESSAGE_PAIRING_TTL_MS',
  'IMESSAGE_PAIRING_TRIGGER',
  'IMESSAGE_PAIRING_FOLDER_PREFIX',
];

/** Read iMessage env vars from .env file, falling back to process.env. */
function getImessageEnv(key: string): string | undefined {
  if (process.env[key]) return process.env[key];
  const fromFile = readEnvFile([key]);
  return fromFile[key] || undefined;
}

function buildPairingConfig(): import('cambot-channels').PairingConfig {
  if (getImessageEnv('IMESSAGE_PAIRING_ENABLED') === 'false') return undefined;
  if (!getImessageEnv('IMESSAGE_PAIRING_ENABLED') && !getImessageEnv('IMESSAGE_BOT_ADDRESS')) return undefined;
  return {
    enabled: true,
    botAddress: getImessageEnv('IMESSAGE_BOT_ADDRESS'),
    pairingPort: getImessageEnv('IMESSAGE_PAIRING_PORT')
      ? parseInt(getImessageEnv('IMESSAGE_PAIRING_PORT')!, 10)
      : 3110,
    tokenTtlMs: getImessageEnv('IMESSAGE_PAIRING_TTL_MS')
      ? parseInt(getImessageEnv('IMESSAGE_PAIRING_TTL_MS')!, 10)
      : 600_000,
    defaultTrigger: getImessageEnv('IMESSAGE_PAIRING_TRIGGER') ?? '@Bot',
    groupFolderPrefix: getImessageEnv('IMESSAGE_PAIRING_FOLDER_PREFIX') ?? 'im-contact',
  };
}

function buildIMessageConfig(providerName: string): import('cambot-channels').IMessageConfig {
  const pairing = buildPairingConfig();
  switch (providerName) {
    case 'loopmessage':
      return {
        provider: 'loopmessage',
        apiKey: getImessageEnv('LOOPMESSAGE_API_KEY') ?? '',
        senderName: getImessageEnv('LOOPMESSAGE_SENDER') ?? '',
        webhookPort: getImessageEnv('LOOPMESSAGE_WEBHOOK_PORT')
          ? parseInt(getImessageEnv('LOOPMESSAGE_WEBHOOK_PORT')!, 10)
          : 3101,
        webhookAuthHeader: getImessageEnv('LOOPMESSAGE_WEBHOOK_AUTH'),
        pairing,
      };
    case 'bluebubbles':
      return {
        provider: 'bluebubbles',
        serverUrl: getImessageEnv('BLUEBUBBLES_SERVER_URL') ?? '',
        password: getImessageEnv('BLUEBUBBLES_PASSWORD') ?? '',
        useSocketIO: true,
        pairing,
      };
    case 'native':
      return {
        provider: 'native',
        chatDbPath: getImessageEnv('NATIVE_CHAT_DB_PATH') ?? '/host/chat.db',
        bridgeUrl: getImessageEnv('NATIVE_BRIDGE_URL') ?? 'http://host.docker.internal:9876',
        pollIntervalMs: getImessageEnv('NATIVE_POLL_INTERVAL_MS')
          ? parseInt(getImessageEnv('NATIVE_POLL_INTERVAL_MS')!, 10)
          : 2000,
        attachmentsPath: '/host/attachments',
        pairing,
      };
    default:
      throw new Error(`Unknown IMESSAGE_PROVIDER: "${providerName}"`);
  }
}

export const channelDefinitions: ChannelDefinition[] = [
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
      return new FileChannel({ baseDir: FILE_CHANNEL_BASE_DIR });
    },
  },
  {
    name: 'imessage',
    isConfigured: () => {
      const explicit = getConfiguredChannelNames();
      if (explicit.size > 0) return explicit.has('imessage');
      return !!getImessageEnv('IMESSAGE_PROVIDER');
    },
    create: async (opts) => {
      const { IMessageChannel, createIMessageProvider } = await import('cambot-channels');
      const providerName = getImessageEnv('IMESSAGE_PROVIDER') ?? '';
      if (!providerName) {
        throw new Error('IMESSAGE_PROVIDER env var is required for iMessage channel');
      }
      const config = buildIMessageConfig(providerName);
      const provider = createIMessageProvider(providerName, config);
      const pairing = (config as Record<string, unknown>).pairing as import('cambot-channels').PairingConfig;
      const channelOpts: import('cambot-channels').ChannelOpts = {
        onMessage: (chatJid, msg, channel) => {
          opts.messageBus.emit(new InboundMessage(channel ?? 'imessage', chatJid, msg, { channel: channel ?? 'imessage' })).catch(() => {});
        },
        onChatMetadata: (chatJid, _timestamp, name, channel, isGroup) => {
          opts.messageBus.emit(new ChatMetadata(channel ?? 'imessage', chatJid, { name, channel: channel ?? 'imessage', isGroup })).catch(() => {});
        },
        registeredGroups: opts.registeredGroups,
        registerGroup: opts.registerGroup,
        messageBus: createChannelBusAdapter(opts.messageBus),
      };
      return new IMessageChannel(provider, channelOpts, pairing);
    },
  },
];

export async function loadChannels(opts: ChannelOpts): Promise<Channel[]> {
  const channels: Channel[] = [];
  for (const def of channelDefinitions) {
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
