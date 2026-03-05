import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'ADMIN_JID',
  'ADMIN_TRIGGER',
  'ADMIN_KEY',
  'WEB_CHANNEL_PORT',
  'WORKSPACE_MCP_PORT',
  'MEMORY_MODE',
  'CONTEXT_TOKEN_BUDGET',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const WEB_CHANNEL_PORT = parseInt(
  process.env.WEB_CHANNEL_PORT || envConfig.WEB_CHANNEL_PORT || '3100',
  10,
);
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'cambot-agent',
  'mount-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');
export const MAIN_GROUP_FOLDER = 'main';

/** Base directory for the file channel. Defaults to filesystem root so workflow
 *  filePaths like "cambot-folder/report.md" resolve to /cambot-folder/report.md. */
export const FILE_CHANNEL_BASE_DIR = process.env.FILE_CHANNEL_BASE_DIR
  || path.parse(PROJECT_ROOT).root;

export const AGENTS_CONFIG_PATH = path.resolve(PROJECT_ROOT, 'agents.yaml');
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '1800000',
  10,
); // 30min default — how long to keep container alive after last result
export const WORKFLOW_CONTAINER_TIMEOUT = parseInt(
  process.env.WORKFLOW_CONTAINER_TIMEOUT || '3600000',
  10,
); // 60min default — workflow agent steps can run longer than regular messages
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Shadow admin — both JID and KEY must be set to enable
export const ADMIN_JID = process.env.ADMIN_JID || envConfig.ADMIN_JID || '';
export const ADMIN_TRIGGER = process.env.ADMIN_TRIGGER || envConfig.ADMIN_TRIGGER || '!admin';
export const ADMIN_KEY = process.env.ADMIN_KEY || envConfig.ADMIN_KEY || '';

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Google Workspace MCP server port (host-side HTTP service)
export const WORKSPACE_MCP_PORT = parseInt(
  process.env.WORKSPACE_MCP_PORT || envConfig.WORKSPACE_MCP_PORT || '8000',
  10,
);

// Memory mode: which memory system the agent uses
export type MemoryMode = 'markdown' | 'database' | 'both';
const rawMemoryMode = process.env.MEMORY_MODE || envConfig.MEMORY_MODE || 'both';
export const MEMORY_MODE: MemoryMode =
  rawMemoryMode === 'markdown' || rawMemoryMode === 'database' ? rawMemoryMode : 'both';

// Context token budget for unified context assembly
export const CONTEXT_TOKEN_BUDGET = parseInt(
  process.env.CONTEXT_TOKEN_BUDGET || envConfig.CONTEXT_TOKEN_BUDGET || '4000',
  10,
);

// Heartbeat monitoring interval (host polls container heartbeat file at this rate)
export const HEARTBEAT_INTERVAL_MS = 5000;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
