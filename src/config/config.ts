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
  'WEB_AUTH_TOKEN',
  'WEB_ALLOWED_ORIGINS',
  'WORKSPACE_MCP_PORT',
  'MEMORY_MODE',
  'CONTEXT_TOKEN_BUDGET',
  'EMAIL_GUARDRAIL_ENABLED',
  'EMAIL_RATE_PER_MINUTE',
  'EMAIL_RATE_PER_HOUR',
  'EMAIL_RATE_PER_DAY',
  'EMAIL_LOOP_THRESHOLD',
  'CONVERSATION_ROTATION_ENABLED',
  'CONVERSATION_IDLE_TIMEOUT_MS',
  'CONVERSATION_MAX_SIZE_KB',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const WEB_CHANNEL_PORT = parseInt(
  process.env.WEB_CHANNEL_PORT || envConfig.WEB_CHANNEL_PORT || '3100',
  10,
);
// Web channel auth token (auto-generated if not set — see src/channels/web-auth.ts)
export const WEB_AUTH_TOKEN =
  process.env.WEB_AUTH_TOKEN || envConfig.WEB_AUTH_TOKEN || '';

// Allowed origins for web channel CORS and WebSocket upgrade (comma-separated).
// Defaults to the cambot-core-ui dev server origin.
export const WEB_ALLOWED_ORIGINS: string[] = (
  process.env.WEB_ALLOWED_ORIGINS || envConfig.WEB_ALLOWED_ORIGINS || 'http://localhost:3000'
).split(',').map((s) => s.trim()).filter(Boolean);

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
export const SKILLS_DIR = path.resolve(PROJECT_ROOT, 'container', 'skills');
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
export const CAMBOT_SOCKET_PORT = parseInt(
  process.env.CAMBOT_SOCKET_PORT || '9500',
  10,
);
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

// Content Pipe — untrusted input sanitization
export const CONTENT_PIPE_ENABLED =
  (process.env.CONTENT_PIPE_ENABLED ?? 'true') !== 'false';
export const CONTENT_PIPE_MODEL =
  process.env.CONTENT_PIPE_MODEL || 'claude-haiku-4-5-20251001';
export const CONTENT_PIPE_RAW_TTL_DAYS = parseInt(
  process.env.CONTENT_PIPE_RAW_TTL_DAYS || '7',
  10,
);
export const CONTENT_PIPE_BLOCK_CRITICAL =
  process.env.CONTENT_PIPE_BLOCK_CRITICAL === 'true';
export const CONTENT_PIPE_UNTRUSTED_CHANNELS = new Set(
  (process.env.CONTENT_PIPE_UNTRUSTED_CHANNELS || 'email')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

// Outbound guard — deterministic rate limits for email sends
export const EMAIL_RATE_PER_MINUTE = parseInt(
  process.env.EMAIL_RATE_PER_MINUTE || envConfig.EMAIL_RATE_PER_MINUTE || '5', 10);
export const EMAIL_RATE_PER_HOUR = parseInt(
  process.env.EMAIL_RATE_PER_HOUR || envConfig.EMAIL_RATE_PER_HOUR || '30', 10);
export const EMAIL_RATE_PER_DAY = parseInt(
  process.env.EMAIL_RATE_PER_DAY || envConfig.EMAIL_RATE_PER_DAY || '100', 10);
export const EMAIL_LOOP_THRESHOLD = parseInt(
  process.env.EMAIL_LOOP_THRESHOLD || envConfig.EMAIL_LOOP_THRESHOLD || '5', 10);

// Inline Haiku guardrail — reviews agent tool calls before execution
// Disabled by default. The content pipe (regex detector + Haiku summarizer +
// envelope isolation) handles inbound injection. Enable for extra outbound review.
export const EMAIL_GUARDRAIL_ENABLED =
  (process.env.EMAIL_GUARDRAIL_ENABLED ?? envConfig.EMAIL_GUARDRAIL_ENABLED ?? 'false') === 'true';

// Conversation rotation — auto-start new conversations based on idle time or transcript size.
// Set CONVERSATION_ROTATION_ENABLED=false to keep conversations indefinitely.
export const CONVERSATION_ROTATION_ENABLED =
  (process.env.CONVERSATION_ROTATION_ENABLED ?? envConfig.CONVERSATION_ROTATION_ENABLED ?? 'true') !== 'false';
// Idle timeout before auto-rotating to a new conversation (default 4 hours).
export const CONVERSATION_IDLE_TIMEOUT_MS = parseInt(
  process.env.CONVERSATION_IDLE_TIMEOUT_MS || envConfig.CONVERSATION_IDLE_TIMEOUT_MS || String(4 * 60 * 60 * 1000),
  10,
);
// Max transcript size in KB before rotating (default 500KB).
export const CONVERSATION_MAX_SIZE_KB = parseInt(
  process.env.CONVERSATION_MAX_SIZE_KB || envConfig.CONVERSATION_MAX_SIZE_KB || '500',
  10,
);

// Long-lived agents: very high rotation threshold (50MB) to prevent unbounded growth
export const LONG_LIVED_DEFAULT_MAX_SIZE_KB = 51200;

// Heartbeat monitoring interval (host polls container heartbeat file at this rate)
export const HEARTBEAT_INTERVAL_MS = 5000;

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
