/**
 * Shadow Admin Agent
 *
 * Intercepts messages matching a three-gate auth check (JID + trigger + key)
 * via a bus handler at priority 10 (before all other handlers). Spawns an
 * elevated container and routes responses directly to the admin via DM —
 * invisible to normal flow.
 */
import fs from 'fs';
import path from 'path';

import { ADMIN_KEY, ADMIN_TRIGGER, GROUPS_DIR } from '../config/config.js';
import { runContainerAgent } from '../container/runner.js';
import { resolveActiveConversation, setConversationSession } from '../db/conversation-repository.js';
import { formatOutbound } from '../utils/router.js';
import { logger } from '../logger.js';
import { Channel, ExecutionContext, MessageBus } from '../types.js';
import { InboundMessage } from '../bus/index.js';
import type { AgentOptions } from './agents.js';
import type { CambotSocketServer } from '../cambot-socket/server.js';

const SHADOW_FOLDER = 'shadow-admin';

interface ShadowAgentDeps {
  adminJid: string;
  adminTrigger: string;
  channels: Channel[];
  messageBus: MessageBus;
  getAgentOptions: () => AgentOptions;
  getTemplate: (key: string) => string | undefined;
  setTemplate: (key: string, value: string) => void;
  getSocketServer?: () => CambotSocketServer | undefined;
}

/**
 * Extract the phone number portion from a JID for comparison.
 * Strips device suffix (`:0`, `:5`, etc.) and domain (`@s.whatsapp.net`).
 */
function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

const SHADOW_TEMPLATE_KEY = 'shadow-admin-identity';

const DEFAULT_SHADOW_IDENTITY = [
  '# Shadow Admin Agent',
  '',
  'You are a privileged admin agent with elevated access.',
  '',
  '## Capabilities',
  '- Full read access to the project at /workspace/project',
  '- Read/write access to your working directory at /workspace/group',
  '- Access to all group data under /workspace/project/groups/',
  '- Access to the message database at /workspace/project/store/',
  '',
  '## Response Format',
  '- Responses are sent directly to the admin via DM',
  '- Use WhatsApp formatting: *bold*, _italic_, ```code```',
  '- Be concise and direct',
  '',
  '## Context',
  '- The `<admin_context>` tag in your prompt tells you which chat the command originated from',
  '- You can inspect any group folder, logs, or the SQLite database',
].join('\n');

function ensureShadowGroup(getTemplate: (key: string) => string | undefined, setTemplate: (key: string, value: string) => void): void {
  const groupDir = path.join(GROUPS_DIR, SHADOW_FOLDER);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Seed DB template on first run if not present
  if (!getTemplate(SHADOW_TEMPLATE_KEY)) {
    setTemplate(SHADOW_TEMPLATE_KEY, DEFAULT_SHADOW_IDENTITY);
  }

  // Always overwrite CLAUDE.md from the DB template — the DB is the single
  // source of truth for the shadow identity. Manual edits to the file will
  // be overwritten on the next restart; update the DB template instead.
  const identity = getTemplate(SHADOW_TEMPLATE_KEY) ?? DEFAULT_SHADOW_IDENTITY;
  fs.writeFileSync(path.join(groupDir, 'CLAUDE.md'), identity + '\n');
}

function sendReply(channels: Channel[], replyJid: string, text: string): void {
  const formatted = formatOutbound(text);
  if (!formatted) return;

  for (const ch of channels) {
    if (ch.ownsJid(replyJid) && ch.isConnected()) {
      ch.sendMessage(replyJid, formatted).catch((err) => {
        logger.error({ err, replyJid }, 'Failed to send shadow admin response');
      });
      return;
    }
  }
  logger.warn({ replyJid }, 'No channel available to deliver shadow admin response');
}

async function spawnShadowContainer(
  prompt: string,
  sourceChatJid: string,
  replyJid: string,
  channels: Channel[],
  agentOpts: AgentOptions,
  socketServer?: CambotSocketServer,
): Promise<void> {
  const conversation = resolveActiveConversation(SHADOW_FOLDER, 'admin', sourceChatJid);
  const sessionId = conversation.sessionId ?? undefined;
  const wrappedPrompt = `<admin_context source_chat="${sourceChatJid}" />\n\n${prompt}`;

  const execution: ExecutionContext = {
    name: 'Shadow Admin',
    folder: SHADOW_FOLDER,
    isMain: true,
  };

  try {
    const output = await runContainerAgent(
      execution,
      {
        prompt: wrappedPrompt,
        sessionId,
        groupFolder: SHADOW_FOLDER,
        chatJid: sourceChatJid,
        isMain: true,
      },
      () => {}, // no process tracking needed
      async (result) => {
        if (result.newSessionId) {
          setConversationSession(conversation.id, result.newSessionId);
        }
        if (result.result) {
          const text = typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
          sendReply(channels, replyJid, text);
        }
      },
      agentOpts,
      socketServer,
    );

    if (output.newSessionId) {
      setConversationSession(conversation.id, output.newSessionId);
    }

    if (output.status === 'error') {
      sendReply(channels, replyJid, `Shadow agent error: ${output.error || 'unknown'}`);
    }
  } catch (err) {
    logger.error({ err }, 'Shadow container spawn failed');
    sendReply(channels, replyJid, `Shadow agent crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Result of the three-gate check. */
type GateResult =
  | { action: 'pass' }           // not an admin message — normal flow
  | { action: 'drop' }           // bad key — silent drop
  | { action: 'accept'; prompt: string }; // all gates passed

function checkGates(
  adminPhone: string,
  triggerPrefix: string,
  senderJid: string,
  content: string,
  requireJid: boolean = true,
): GateResult {
  // Gate 1: sender must be the admin (skipped for bus path — key is the auth)
  if (requireJid && phoneFromJid(senderJid) !== adminPhone) return { action: 'pass' };

  // Gate 2: content must start with the trigger
  const trimmed = content.trim();
  if (!trimmed.startsWith(triggerPrefix)) return { action: 'pass' };

  // Strip trigger prefix, extract first token as key candidate
  const afterTrigger = trimmed.slice(triggerPrefix.length);
  const spaceIdx = afterTrigger.indexOf(' ');
  const keyCandidate = spaceIdx === -1 ? afterTrigger : afterTrigger.slice(0, spaceIdx);
  const prompt = spaceIdx === -1 ? '' : afterTrigger.slice(spaceIdx + 1).trim();

  // Gate 3: key must match — wrong key = silent drop
  if (keyCandidate !== ADMIN_KEY) {
    logger.debug('Shadow admin: bad key, silently dropping');
    return { action: 'drop' };
  }

  if (!prompt) {
    logger.debug('Shadow admin: empty prompt after key, dropping');
    return { action: 'drop' };
  }

  return { action: 'accept', prompt };
}

/**
 * Create the shadow agent interceptor.
 *
 * Returns a function for the callback path (WhatsApp).
 * If a messageBus is provided, also subscribes at priority 10 to intercept
 * bus-routed messages (web channel) before the DB store at priority 100.
 */
export function createShadowAgent(deps: ShadowAgentDeps): void {
  const { adminJid, adminTrigger, channels, messageBus, getAgentOptions, getTemplate, setTemplate, getSocketServer } = deps;

  // Feature disabled — KEY is required; JID is only needed for WhatsApp path
  if (!ADMIN_KEY) {
    logger.info('Shadow admin disabled (ADMIN_KEY not set)');
    return;
  }

  ensureShadowGroup(getTemplate, setTemplate);
  const adminPhone = adminJid ? phoneFromJid(adminJid) : '';
  const triggerPrefix = adminTrigger + ' ';

  logger.info(
    adminPhone
      ? { adminPhone: adminPhone.slice(0, 4) + '***' }
      : { mode: 'bus-only' },
    'Shadow admin enabled',
  );

  // Bus path: intercept message.inbound before db-store (priority 10 < 100)
  messageBus.on(InboundMessage, (event) => {
    // Bus path: skip JID check — key is sufficient auth for localhost channels
    const result = checkGates(adminPhone, triggerPrefix, event.message.sender, event.message.content, false);

    if (result.action === 'pass') return;

    // Drop or accept — either way, cancel the event so DB never sees it
    event.cancelled = true;

    if (result.action === 'accept') {
      logger.info({ sourceChatJid: event.jid }, 'Shadow admin command accepted (bus)');
      spawnShadowContainer(result.prompt, event.jid, event.jid, channels, getAgentOptions(), getSocketServer?.()).catch((err) => {
        logger.error({ err }, 'Shadow container error');
      });
    }
  }, { id: 'shadow-admin-intercept', priority: 10, source: 'shadow-admin', sequential: true });

}
