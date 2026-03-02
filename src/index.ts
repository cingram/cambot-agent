import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ADMIN_JID,
  ADMIN_TRIGGER,
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  STORE_DIR,
  TRIGGER_PATTERN,
  WORKFLOW_CONTAINER_TIMEOUT,
} from './config.js';
import { getLeadAgentId, loadAgentsConfig, resolveAgentImage } from './agents.js';
import { buildIntegrationDefinitions, createIntegrationManager } from './integrations/index.js';
import type { IntegrationManager } from './integrations/index.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeCustomAgentsSnapshot,
  writeGroupsSnapshot,
  writeArchivedTasksSnapshot,
  writeTasksSnapshot,
  writeWorkflowsSnapshot,
  writeWorkflowSchemaSnapshot,
  writeWorkersSnapshot,
} from './container-runner.js';
import { cleanupOrphans, cleanupStaleContainers, ensureContainerRuntimeRunning, stopContainer } from './container-runtime.js';
import {
  getAllAgentDefinitions,
  getAllChats,
  getAllCustomAgents,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getDatabase,
  getAgentDefinition,
  getArchivedTasks,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  findCustomAgentByTrigger,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath, resolveGroupIpcPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { createMessageBus } from './message-bus.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startWorkflowSchedulerLoop } from './workflow-scheduler.js';
import { Channel, MessageBus, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { createCustomAgentService, CustomAgentService } from './custom-agent-service.js';
import { buildMemoryContext } from './memory-context.js';
import { createShadowAgent } from './shadow-agent.js';
import { createWorkflowService, WorkflowService, type AgentStepInput, type AgentContainerResult } from './workflow-service.js';
import { createWorkflowBuilderService, WorkflowBuilderService } from './workflow-builder-service.js';
import { writeContextFiles } from './context-files.js';
import { createCamBotCore, createStandaloneConfig } from 'cambot-core';
import { createLifecycleInterceptor } from './lifecycle-interceptor.js';
import type { LifecycleInterceptor } from './lifecycle-interceptor.js';
import { readEnvFile } from './env.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
let messageLoopRunning = false;

let channels: Channel[] = [];
const queue = new GroupQueue();
let messageBus!: MessageBus;
let workflowService: WorkflowService | null = null;
let workflowBuilderService: WorkflowBuilderService | null = null;
let customAgentService: CustomAgentService | null = null;
let shadowInterceptor: (chatJid: string, msg: NewMessage) => boolean = () => false;
let interceptor: LifecycleInterceptor | null = null;
let integrationMgr: IntegrationManager | null = null;

/** Persist a bot-generated message so /history includes both sides. */
function storeBotMessage(chatJid: string, text: string): void {
  storeMessage({
    id: `bot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    chat_jid: chatJid,
    sender: `bot:${ASSISTANT_NAME.toLowerCase()}`,
    sender_name: ASSISTANT_NAME,
    content: text,
    timestamp: new Date().toISOString(),
    is_from_me: true,
    is_bot_message: true,
  });
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState(
    'last_agent_timestamp',
    JSON.stringify(lastAgentTimestamp),
  );
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  setRegisteredGroup(jid, group);
  // Re-read from DB so in-memory state includes preserved containerConfig
  const updated = getAllRegisteredGroups();
  registeredGroups[jid] = updated[jid] ?? group;

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(groups: Record<string, RegisteredGroup>): void {
  registeredGroups = groups;
}

/**
 * Clean stale IPC input files (messages + _close sentinel) so a retry
 * container starts with a clean input directory.
 */
function cleanIpcInputDir(groupFolder: string): void {
  const inputDir = path.join(DATA_DIR, 'ipc', groupFolder, 'input');
  try {
    for (const f of fs.readdirSync(inputDir)) {
      if (f.endsWith('.json') || f === '_close' || f === '_memory_context.md') {
        try { fs.unlinkSync(path.join(inputDir, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore — dir may not exist */ }
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  // Verify at least one channel can handle this JID
  const hasChannel = channels.some(ch => ch.ownsJid(chatJid));
  if (!hasChannel) {
    console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
    return true;
  }

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Clean stale IPC input files from previous container runs before spawning.
  // Prevents orphaned containers' leftover files from being misprocessed.
  cleanIpcInputDir(group.folder);

  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);

  if (missedMessages.length === 0) return true;

  // Check for custom agent trigger BEFORE normal trigger check
  if (customAgentService) {
    for (const msg of missedMessages) {
      const matchedAgent = findCustomAgentByTrigger(msg.content);
      if (matchedAgent && matchedAgent.group_folder === group.folder) {
        const agentPrompt = formatMessages(missedMessages);
        logger.info(
          { agentId: matchedAgent.id, agentName: matchedAgent.name, group: group.name },
          'Custom agent trigger matched',
        );
        // Advance cursor
        lastAgentTimestamp[chatJid] = missedMessages[missedMessages.length - 1].timestamp;
        saveState();
        // Invoke custom agent with session lifecycle tracking
        interceptor?.startSession(group.folder, chatJid);
        customAgentService.invokeAgent(
          matchedAgent.id,
          agentPrompt,
          chatJid,
          group.folder,
          isMainGroup,
        ).then(() => {
          interceptor?.endSession(group.folder, true);
        }).catch((err) => {
          interceptor?.endSession(group.folder, false);
          logger.error({ agentId: matchedAgent.id, err }, 'Custom agent trigger invocation failed');
        });
        return true; // consumed
      }
    }
  }

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const hasTrigger = missedMessages.some((m) =>
      TRIGGER_PATTERN.test(m.content.trim()),
    );
    if (!hasTrigger) return true;
  }

  const rawPrompt = formatMessages(missedMessages);

  // Lifecycle interceptor: boot context + PII redaction
  // Build the full prompt first (boot context + message text), then redact
  // everything in one pass so entity names in boot context headings get caught.
  const bootContext = interceptor ? interceptor.getBootContext() : '';
  const fullRawPrompt = bootContext
    ? `<system-context>\n${bootContext}\n</system-context>\n\n${rawPrompt}`
    : rawPrompt;
  const { redacted: prompt, mappings: piiMappings } = interceptor
    ? interceptor.redactPrompt(fullRawPrompt)
    : { redacted: fullRawPrompt, mappings: [] };
  interceptor?.startSession(group.folder, chatJid);

  // Build query-relevant memory context from the last user message
  const lastMessageContent = missedMessages[missedMessages.length - 1].content;
  const memoryContext = await buildMemoryContext(lastMessageContent);

  // Advance cursor so the piping path in startMessageLoop won't re-fetch
  // these messages. Save the old cursor so we can roll back on error.
  const previousCursor = lastAgentTimestamp[chatJid] || '';
  lastAgentTimestamp[chatJid] =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ group: group.name }, 'Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  // Typing indicator via bus
  messageBus.emitAsync({
    type: 'typing.update',
    source: 'agent',
    timestamp: new Date().toISOString(),
    data: { jid: chatJid, isTyping: true },
  }).catch(() => {});

  let hadError = false;
  let outputSentToUser = false;
  let lastSentText = '';
  let lastSentTime = 0;
  let hadTelemetry = false;
  const containerStartTime = Date.now();

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Record telemetry if present (separate from user-visible results)
    if (result.telemetry && interceptor) {
      interceptor.recordTelemetry(result.telemetry, chatJid);
      hadTelemetry = true;
    }

    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // Suppress duplicate outputs within a 10-second window (defense-in-depth
        // against SDK/container emitting the same result multiple times)
        const now = Date.now();
        if (text === lastSentText && (now - lastSentTime) < 10_000) {
          logger.warn({ group: group.name }, 'Duplicate agent output suppressed');
        } else {
          lastSentText = text;
          lastSentTime = now;
          const restoredText = interceptor
            ? interceptor.restoreOutput(text, piiMappings)
            : text;

          await messageBus.emitAsync({
            type: 'message.outbound',
            source: 'agent',
            timestamp: new Date().toISOString(),
            data: { jid: chatJid, text: restoredText, source: 'agent', groupFolder: group.folder },
          });
          interceptor?.ingestResponse(group.folder, chatJid, restoredText);

          outputSentToUser = true;
        }
      }

      // Advance cursor to cover any messages piped via IPC that the
      // container has now processed.  The message loop does NOT advance
      // the cursor when piping — we do it here on confirmed output.
      const latest = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
      if (latest.length > 0) {
        lastAgentTimestamp[chatJid] = latest[latest.length - 1].timestamp;
        saveState();
      }

      // Only reset idle timer on actual results, not session-update markers (result: null)
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  }, memoryContext);

  // Stop typing indicator
  messageBus.emitAsync({
    type: 'typing.update',
    source: 'agent',
    timestamp: new Date().toISOString(),
    data: { jid: chatJid, isTyping: false },
  }).catch(() => {});
  if (idleTimer) clearTimeout(idleTimer);
  interceptor?.endSession(group.folder, output !== 'error' && !hadError);

  if (output === 'error' || hadError) {
    // Record error telemetry if no telemetry was received from the container
    if (!hadTelemetry && interceptor) {
      const durationMs = Date.now() - containerStartTime;
      interceptor.recordContainerError(
        `Container failed for group ${group.name}`,
        durationMs,
        chatJid,
      );
    }
    cleanIpcInputDir(group.folder);
    // If we already sent output to the user, check for remaining messages
    // before giving up — IPC-piped messages may still need processing.
    if (outputSentToUser) {
      const remaining = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
      if (remaining.length > 0) {
        logger.warn({ group: group.name, count: remaining.length }, 'Agent error after output; unprocessed messages remain, retrying');
        return false;
      }
      logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    // Roll back cursor so retries can re-process these messages
    lastAgentTimestamp[chatJid] = previousCursor;
    saveState();
    logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
    return false;
  }

  // Safety net: detect messages piped via IPC that the container never
  // processed (e.g. container exited before reading the IPC file, SDK
  // hang, Docker bind-mount visibility delay on Windows, etc.).
  const remaining = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
  if (remaining.length > 0) {
    logger.warn(
      { group: group.name, count: remaining.length },
      'Unprocessed messages found after container exit, re-queuing',
    );
    cleanIpcInputDir(group.folder);
    return false;
  }

  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  memoryContext?: string | null,
): Promise<'success' | 'error'> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update archived tasks snapshot for container to read
  const archived = getArchivedTasks();
  writeArchivedTasksSnapshot(
    group.folder,
    isMain,
    archived.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Update custom agents snapshot for container to read
  const customAgents = getAllCustomAgents();
  writeCustomAgentsSnapshot(
    group.folder,
    isMain,
    customAgents.map((a) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      provider: a.provider,
      model: a.model,
      trigger_pattern: a.trigger_pattern,
      group_folder: a.group_folder,
    })),
  );

  // Update workflows snapshot for container to read (includes full step definitions)
  if (workflowService) {
    const workflows = workflowService.listWorkflows().map(wf => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      version: wf.version,
      stepCount: wf.steps.length,
      schedule: wf.schedule,
      steps: wf.steps.map(s => ({ id: s.id, type: s.type, name: s.name, config: s.config, after: s.after })),
      policy: wf.policy as unknown as Record<string, unknown>,
      hash: wf.hash,
    }));
    const runs = workflowService.listRuns(undefined, 20).map(r => ({
      runId: r.runId,
      workflowId: r.workflowId,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      error: r.error,
      totalCostUsd: r.totalCostUsd,
    }));
    writeWorkflowsSnapshot(group.folder, isMain, workflows, runs);

    // Write workflow schema snapshot
    if (workflowBuilderService) {
      writeWorkflowSchemaSnapshot(group.folder, workflowBuilderService.getSchema() as unknown as Record<string, unknown>);
    }
  }

  // Update available workers snapshot for delegation
  const allWorkers = getAllAgentDefinitions();
  writeWorkersSnapshot(group.folder, allWorkers);

  // Write dynamic context files (TOOLS.md, AGENTS.md, HEARTBEAT.md, USER.md)
  {
    const groupIpcDir = resolveGroupIpcPath(group.folder);
    const activeMcpServers = integrationMgr?.getActiveMcpServers() ?? [];
    const skillsDir = path.join(process.cwd(), 'container', 'skills');
    writeContextFiles(groupIpcDir, isMain, {
      mcpServers: activeMcpServers,
      skillsDir,
      globalDir: path.join(GROUPS_DIR, 'global'),
      customAgents: customAgents.map(a => ({
        id: a.id,
        name: a.name,
        description: a.description,
        provider: a.provider,
        model: a.model,
        trigger_pattern: a.trigger_pattern,
      })),
      tasks: tasks.map(t => ({
        id: t.id,
        prompt: t.prompt,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      })),
      workflows: workflowService
        ? workflowService.listWorkflows().map(wf => ({
            id: wf.id,
            name: wf.name,
            schedule: wf.schedule,
          }))
        : [],
    });
  }

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const leadId = getLeadAgentId();
    const agentOpts = resolveAgentImage(leadId);

    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        mcpServers: integrationMgr?.getActiveMcpServers(),
        memoryContext: memoryContext ?? undefined,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
      agentOpts,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return 'error';
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info(`CamBot-Agent running (trigger: @${ASSISTANT_NAME})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const hasChannel = channels.some(ch => ch.ownsJid(chatJid));
          if (!hasChannel) {
            console.log(`Warning: no channel owns JID ${chatJid}, skipping messages`);
            continue;
          }

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const hasTrigger = groupMessages.some((m) =>
              TRIGGER_PATTERN.test(m.content.trim()),
            );
            if (!hasTrigger) continue;
          }

          // Pull messages since the latest piped timestamp (to avoid
          // re-piping already-sent messages), falling back to lastAgentTimestamp
          // for the first pipe of this container session.
          const pipeSince = queue.getLastPipedTimestamp(chatJid)
            || lastAgentTimestamp[chatJid] || '';
          const allPending = getMessagesSince(
            chatJid,
            pipeSince,
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);
          const safeFormatted = interceptor
            ? interceptor.redactPrompt(formatted).redacted
            : formatted;

          const latestTs = messagesToSend[messagesToSend.length - 1]?.timestamp;
          if (queue.sendMessage(chatJid, safeFormatted, latestTs)) {
            logger.info(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container via IPC',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();

            // Write refreshed memory context for the follow-up message
            const lastContent = messagesToSend[messagesToSend.length - 1].content;
            buildMemoryContext(lastContent).then((ctx) => {
              if (ctx) {
                const ipcInputDir = path.join(DATA_DIR, 'ipc', group.folder, 'input');
                try {
                  fs.writeFileSync(path.join(ipcInputDir, '_memory_context.md'), ctx);
                } catch (err) {
                  logger.warn({ err, group: group.folder }, 'Failed to write _memory_context.md');
                }
              }
            }).catch(() => {});

            // Typing indicator via bus
            messageBus.emitAsync({
              type: 'typing.update',
              source: 'agent',
              timestamp: new Date().toISOString(),
              data: { jid: chatJid, isTyping: true },
            }).catch(() => {});
          } else {
            // No active container — enqueue for a new one
            logger.info(
              { chatJid, count: messagesToSend.length },
              'No active container, enqueueing for new container',
            );
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
    const pending = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }

  // Sync global "seen" cursor to prevent startMessageLoop from
  // rediscovering messages that recovery already claimed.
  const maxAgentTs = Object.values(lastAgentTimestamp).reduce(
    (max, ts) => (ts > max ? ts : max),
    lastTimestamp,
  );
  if (maxAgentTs > lastTimestamp) {
    logger.info(
      { old: lastTimestamp, new: maxAgentTs },
      'Recovery: advancing lastTimestamp to match agent cursors',
    );
    lastTimestamp = maxAgentTs;
    saveState();
  }
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled rejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
  });
  process.on('beforeExit', (code) => {
    console.error('[DEBUG] beforeExit code:', code);
  });
  process.on('exit', (code) => {
    console.error('[DEBUG] exit code:', code);
  });
  process.on('SIGTERM', () => console.error('[DEBUG] SIGTERM'));
  process.on('SIGINT', () => console.error('[DEBUG] SIGINT'));

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();
  loadAgentsConfig();

  // Initialize cambot-core lifecycle interceptor
  try {
    const coreEnv = readEnvFile(['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CAMBOT_DB_PATH']);
    const coreConfig = createStandaloneConfig({
      dbPath: coreEnv.CAMBOT_DB_PATH || process.env.CAMBOT_DB_PATH || path.join(STORE_DIR, 'cambot-core.sqlite'),
      geminiApiKey: coreEnv.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
      anthropicApiKey: coreEnv.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
      piiRedactionTags: [],
    });
    const core = createCamBotCore(coreConfig);
    interceptor = createLifecycleInterceptor(core, logger);
    interceptor.startPeriodicTasks();
    logger.info('Lifecycle interceptor initialized');
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize lifecycle interceptor, running without memory');
  }

  // ── Initialize Workflow Service ──────────────────────────────────────────
  // Workflow agent steps spawn a container with the existing Agent SDK + OAuth
  // token, using an extended timeout for long-running operations.
  const workflowGroup: RegisteredGroup = {
    name: 'Workflow Agent',
    folder: 'workflows',
    trigger: '',
    added_at: new Date().toISOString(),
    containerConfig: { timeout: WORKFLOW_CONTAINER_TIMEOUT },
    requiresTrigger: false,
  };

  // Create message bus early — workflow service needs it for delivery
  const bus = createMessageBus();
  messageBus = bus;

  // Serialization lock: workflow agent steps share the same container group
  // ("workflows"), so concurrent steps would kill each other. Chain them.
  let workflowContainerLock = Promise.resolve<unknown>(undefined);

  workflowService = createWorkflowService({
    db: getDatabase(),
    messageBus: bus,
    getChannels: () => channels,
    adminJid: ADMIN_JID,
    onStepCost: (cost) => {
      interceptor?.recordStepCost(cost);
    },
    runAgentContainer: (input: AgentStepInput): Promise<AgentContainerResult> => {
      const run = async (): Promise<AgentContainerResult> => {
      // Use a promise that resolves on the first streamed output marker,
      // so we don't wait for the container process to exit (the claude
      // process inside can idle for minutes after the agent-runner finishes).
      let resolveResult: (value: AgentContainerResult) => void;
      let rejectResult: (err: Error) => void;
      const resultPromise = new Promise<AgentContainerResult>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });
      let gotStreamedOutput = false;
      let spawnedContainerName: string | null = null;

      const workflowAgentOpts = resolveAgentImage(getLeadAgentId());
      // Include the custom agent's API key in the secrets passed to the container
      if (input.customAgent?.apiKeyEnvVar &&
          !workflowAgentOpts.secretKeys.includes(input.customAgent.apiKeyEnvVar)) {
        workflowAgentOpts.secretKeys = [
          ...workflowAgentOpts.secretKeys,
          input.customAgent.apiKeyEnvVar,
        ];
      }
      const containerPromise = runContainerAgent(
        workflowGroup,
        {
          prompt: input.prompt,
          groupFolder: workflowGroup.folder,
          chatJid: 'workflows',
          isMain: true,
          customAgent: input.customAgent,
          mcpServers: integrationMgr?.getActiveMcpServers(),
        },
        (_proc, containerName) => {
          spawnedContainerName = containerName;
          logger.debug({ containerName }, 'Workflow container spawned');
        },
        async (output) => {
          if (gotStreamedOutput) return; // only use the first marker
          gotStreamedOutput = true;
          // Record telemetry so workflow container costs reach the cost_ledger
          if (output.telemetry && interceptor) {
            interceptor.recordTelemetry(output.telemetry, 'workflows');
          }
          if (output.status === 'error') {
            if (!output.telemetry && interceptor) {
              interceptor.recordContainerError(
                `Workflow container failed: ${output.error || 'unknown error'}`,
                0,
                'workflows',
              );
            }
            rejectResult(new Error(`Workflow container failed: ${output.error || 'unknown error'}`));
          } else {
            // Normalize modelUsage keys: ContainerTelemetry uses costUSD, our API uses costUsd
            const modelUsage = output.telemetry?.modelUsage
              ? Object.fromEntries(
                  Object.entries(output.telemetry.modelUsage).map(([model, u]) => [
                    model,
                    { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUSD },
                  ]),
                )
              : undefined;
            resolveResult({
              text: output.result || '',
              totalCostUsd: output.telemetry?.totalCostUsd,
              tokensIn: output.telemetry?.usage.inputTokens,
              tokensOut: output.telemetry?.usage.outputTokens,
              modelUsage,
            });
          }
          // Stop the container now — we have the result and don't need it running
          if (spawnedContainerName) {
            const name = spawnedContainerName;
            exec(stopContainer(name), { timeout: 15_000 }, (err) => {
              if (err) logger.debug({ containerName: name, err }, 'Workflow container stop (may already be exiting)');
            });
          }
        },
        workflowAgentOpts,
      );

      // If container exits before any streamed output (error case), fall back
      containerPromise.then((output) => {
        if (!gotStreamedOutput) {
          // Record telemetry for the fallback path too
          if (output.telemetry && interceptor) {
            interceptor.recordTelemetry(output.telemetry, 'workflows');
          }
          if (output.status === 'error') {
            if (!output.telemetry && interceptor) {
              interceptor.recordContainerError(
                `Workflow container failed: ${output.error || 'unknown error'}`,
                0,
                'workflows',
              );
            }
            rejectResult(new Error(`Workflow container failed: ${output.error || 'unknown error'}`));
          } else {
            const fallbackModelUsage = output.telemetry?.modelUsage
              ? Object.fromEntries(
                  Object.entries(output.telemetry.modelUsage).map(([model, u]) => [
                    model,
                    { inputTokens: u.inputTokens, outputTokens: u.outputTokens, costUsd: u.costUSD },
                  ]),
                )
              : undefined;
            resolveResult({
              text: output.result || '',
              totalCostUsd: output.telemetry?.totalCostUsd,
              tokensIn: output.telemetry?.usage.inputTokens,
              tokensOut: output.telemetry?.usage.outputTokens,
              modelUsage: fallbackModelUsage,
            });
          }
        }
      }).catch((err) => {
        if (!gotStreamedOutput) {
          rejectResult(err instanceof Error ? err : new Error(String(err)));
        }
      });

      return resultPromise;
      };

      // Chain through lock so only one workflow container runs at a time
      const queued = workflowContainerLock.then(run, run);
      workflowContainerLock = queued.catch(() => {}); // swallow to keep chain alive
      return queued;
    },
  });
  workflowService.reloadDefinitions();

  // ── Initialize Workflow Builder Service ────────────────────────────────
  {
    const { createDefaultToolRegistry } = await import('cambot-workflows');
    const toolRegistry = createDefaultToolRegistry();
    workflowBuilderService = createWorkflowBuilderService({
      workflowsDir: path.join(DATA_DIR, 'workflows'),
      workflowService,
      toolRegistry,
    });
  }

  // ── Initialize Custom Agent Service ─────────────────────────────────────
  customAgentService = createCustomAgentService({
    getRegisteredGroup: (groupFolder: string) => {
      for (const group of Object.values(registeredGroups)) {
        if (group.folder === groupFolder) return group;
      }
      return undefined;
    },
    messageBus: bus,
    onProcess: (proc, containerName, groupFolder) => {
      // Custom agent containers don't register in the queue
      logger.debug({ containerName, groupFolder }, 'Custom agent container spawned');
    },
    getAgentOptions: () => resolveAgentImage(getLeadAgentId()),
    onTelemetry: (telemetry, channel) => {
      interceptor?.recordTelemetry(telemetry, channel);
    },
    onContainerError: (error, durationMs, channel) => {
      interceptor?.recordContainerError(error, durationMs, channel);
    },
  });

  // ── Register bus subscribers ────────────────────────────────────────────

  // DB storage: inbound messages (priority 100)
  bus.on('message.inbound', (event) => {
    const { message } = event.data as { jid: string; message: NewMessage };
    storeMessage(message);
  }, { id: 'db-store-inbound', priority: 100, source: 'cambot-agent' });

  // DB storage: outbound messages (priority 100)
  bus.on('message.outbound', (event) => {
    const { jid, text, source } = event.data as { jid: string; text: string; source?: string };
    if (jid.startsWith('file:')) return; // file writes aren't chat messages
    // Ensure chat row exists before inserting message (workflows may use JIDs not yet in chats table)
    storeChatMetadata(jid, new Date().toISOString(), jid, source);
    storeBotMessage(jid, text);
  }, { id: 'db-store-outbound', priority: 100, source: 'cambot-agent' });

  // DB storage: chat metadata (priority 100)
  bus.on('chat.metadata', (event) => {
    const { jid, timestamp, name, channel, isGroup } = event.data as {
      jid: string; timestamp: string; name?: string; channel?: string; isGroup?: boolean;
    };
    storeChatMetadata(jid, timestamp, name, channel, isGroup);
  }, { id: 'db-store-metadata', priority: 100, source: 'cambot-agent' });

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (interceptor) await interceptor.close();
    await queue.shutdown(10000);
    if (integrationMgr) await integrationMgr.shutdown();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  // When messageBus is present, channels emit events instead of calling these.
  // These callbacks serve as fallback when bus is not available.
  const channelOpts = {
    onMessage: (chatJid: string, msg: NewMessage) => {
      if (shadowInterceptor(chatJid, msg)) return; // consumed by shadow admin
      storeMessage(msg);
      interceptor?.ingestMessage(msg);
    },
    onChatMetadata: (chatJid: string, timestamp: string, name?: string, channel?: string, isGroup?: boolean) =>
      storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
    registerGroup,
    messageBus,
    workflowService: workflowService ?? undefined,
    channelNames: () => channels.map(ch => ch.name),
  };

  // ── Initialize Integration Manager ────────────────────────────────────
  // Replaces manual Google Workspace MCP init + loadChannels().
  // All channels and MCP servers are now managed as integrations.
  integrationMgr = createIntegrationManager(buildIntegrationDefinitions());
  await integrationMgr.initialize({ messageBus: bus, channelOpts });
  channels = integrationMgr.getActiveChannels();

  // Channel delivery: forward outbound messages to the owning channel (priority 50, after DB storage)
  bus.on('message.outbound', async (event) => {
    const { jid, text, broadcast } = event.data as {
      jid: string; text: string; broadcast?: boolean;
    };
    const activeChannels = integrationMgr?.getActiveChannels() ?? channels;
    const targets = broadcast
      ? activeChannels.filter(ch => ch.isConnected())
      : activeChannels.filter(ch => ch.ownsJid(jid) && ch.isConnected());
    for (const ch of targets) {
      try {
        await ch.sendMessage(jid, text);
      } catch (err) {
        logger.error({ channel: ch.name, jid, err }, 'Channel delivery failed');
      }
    }
  }, { id: 'channel-delivery', priority: 50, source: 'cambot-agent' });

  // Initialize shadow admin interceptor (must be after integration manager init)
  shadowInterceptor = createShadowAgent({
    adminJid: ADMIN_JID,
    adminTrigger: ADMIN_TRIGGER,
    channels: integrationMgr?.getActiveChannels() ?? channels,
    messageBus,
    getAgentOptions: () => resolveAgentImage(getLeadAgentId()),
  });

  // Start subsystems
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) => queue.registerProcess(groupJid, proc, containerName, groupFolder),
    messageBus,
  });
  startWorkflowSchedulerLoop({ workflowService });
  startIpcWatcher({
    messageBus,
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroupMetadata: async (force) => {
      const activeChannels = integrationMgr?.getActiveChannels() ?? channels;
      for (const ch of activeChannels) await ch.syncMetadata?.(force);
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) => writeGroupsSnapshot(gf, im, ag, rj),
    workflowService: workflowService ?? undefined,
    workflowBuilderService: workflowBuilderService ?? undefined,
    customAgentService: customAgentService ?? undefined,
    resolveAgentImage,
    getAgentDefinition,
    integrationManager: integrationMgr ?? undefined,
  });
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Periodic stale container cleanup: catch containers that slip through
  // normal cleanup (e.g. process restart losing timeout timers, edge cases).
  // Uses age-based filtering so active containers aren't affected.
  const STALE_CLEANUP_INTERVAL = 5 * 60_000; // check every 5 minutes
  const STALE_MAX_AGE = 90 * 60_000; // kill containers older than 90 minutes
  setInterval(() => {
    cleanupStaleContainers(STALE_MAX_AGE);
  }, STALE_CLEANUP_INTERVAL);

  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start CamBot-Agent');
    process.exit(1);
  });
}
