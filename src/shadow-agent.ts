/**
 * Shadow Admin Agent
 *
 * Intercepts messages matching a three-gate auth check (JID + trigger + key)
 * before they reach the DB or event bus. Spawns an elevated container and
 * routes responses directly to the admin via DM — invisible to normal flow.
 */
import fs from 'fs';
import path from 'path';

import { ADMIN_KEY, ADMIN_TRIGGER, GROUPS_DIR } from './config.js';
import { runContainerAgent } from './container-runner.js';
import { getSession, setSession } from './db.js';
import { formatOutbound } from './router.js';
import { logger } from './logger.js';
import { Channel, NewMessage } from './types.js';

const SHADOW_FOLDER = 'shadow-admin';

interface ShadowAgentDeps {
  adminJid: string;
  adminTrigger: string;
  channels: Channel[];
}

/**
 * Extract the phone number portion from a JID for comparison.
 * Strips device suffix (`:0`, `:5`, etc.) and domain (`@s.whatsapp.net`).
 */
function phoneFromJid(jid: string): string {
  return jid.split('@')[0].split(':')[0];
}

function ensureShadowGroup(): void {
  const groupDir = path.join(GROUPS_DIR, SHADOW_FOLDER);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  const claudeMd = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(claudeMd)) {
    fs.writeFileSync(claudeMd, [
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
    ].join('\n') + '\n');
  }
}

function sendToAdmin(channels: Channel[], adminJid: string, text: string): void {
  const formatted = formatOutbound(text);
  if (!formatted) return;

  for (const ch of channels) {
    if (ch.ownsJid(adminJid) && ch.isConnected()) {
      ch.sendMessage(adminJid, formatted).catch((err) => {
        logger.error({ err, adminJid }, 'Failed to send shadow admin response');
      });
      return;
    }
  }
  logger.warn({ adminJid }, 'No channel available to deliver shadow admin response');
}

async function spawnShadowContainer(
  prompt: string,
  sourceChatJid: string,
  channels: Channel[],
  adminJid: string,
): Promise<void> {
  const sessionId = getSession(SHADOW_FOLDER);
  const wrappedPrompt = `<admin_context source_chat="${sourceChatJid}" />\n\n${prompt}`;

  const group = {
    name: 'Shadow Admin',
    folder: SHADOW_FOLDER,
    trigger: '',
    added_at: new Date().toISOString(),
  };

  try {
    const output = await runContainerAgent(
      group,
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
          setSession(SHADOW_FOLDER, result.newSessionId);
        }
        if (result.result) {
          const text = typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
          sendToAdmin(channels, adminJid, text);
        }
      },
    );

    if (output.newSessionId) {
      setSession(SHADOW_FOLDER, output.newSessionId);
    }

    if (output.status === 'error') {
      sendToAdmin(channels, adminJid, `Shadow agent error: ${output.error || 'unknown'}`);
    }
  } catch (err) {
    logger.error({ err }, 'Shadow container spawn failed');
    sendToAdmin(channels, adminJid, `Shadow agent crashed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Create the shadow agent interceptor.
 * Returns a function that checks each inbound message against the three-gate auth.
 * Returns `true` if the message was consumed (intercepted or silently dropped).
 */
export function createShadowAgent(deps: ShadowAgentDeps): (chatJid: string, msg: NewMessage) => boolean {
  const { adminJid, adminTrigger, channels } = deps;

  // Feature disabled — both JID and KEY must be set
  if (!adminJid || !ADMIN_KEY) {
    logger.info('Shadow admin disabled (ADMIN_JID or ADMIN_KEY not set)');
    return () => false;
  }

  ensureShadowGroup();
  const adminPhone = phoneFromJid(adminJid);
  const triggerPrefix = adminTrigger + ' ';

  logger.info({ adminPhone: adminPhone.slice(0, 4) + '***' }, 'Shadow admin enabled');

  return (chatJid: string, msg: NewMessage): boolean => {
    // Gate 1: sender must be the admin
    const senderPhone = phoneFromJid(msg.sender);
    if (senderPhone !== adminPhone) return false;

    // Gate 2: content must start with the trigger
    const content = msg.content.trim();
    if (!content.startsWith(triggerPrefix)) return false;

    // Strip trigger prefix, extract first token as key candidate
    const afterTrigger = content.slice(triggerPrefix.length);
    const spaceIdx = afterTrigger.indexOf(' ');
    const keyCandidate = spaceIdx === -1 ? afterTrigger : afterTrigger.slice(0, spaceIdx);
    const prompt = spaceIdx === -1 ? '' : afterTrigger.slice(spaceIdx + 1).trim();

    // Gate 3: key must match — wrong key = silent drop
    if (keyCandidate !== ADMIN_KEY) {
      logger.debug('Shadow admin: bad key, silently dropping');
      return true;
    }

    if (!prompt) {
      logger.debug('Shadow admin: empty prompt after key, dropping');
      return true;
    }

    // All gates passed — spawn container (fire-and-forget)
    logger.info({ sourceChatJid: chatJid }, 'Shadow admin command accepted');
    spawnShadowContainer(prompt, chatJid, channels, adminJid).catch((err) => {
      logger.error({ err }, 'Shadow container error');
    });

    return true;
  };
}
