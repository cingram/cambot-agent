import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ADMIN_JID,
  ADMIN_TRIGGER,
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TRIGGER_PATTERN,
  WORKFLOW_CONTAINER_TIMEOUT,
} from './config.js';
import { buildIntegrationDefinitions, createIntegrationManager } from './integrations/index.js';
import type { IntegrationManager } from './integrations/index.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeCustomAgentsSnapshot,
  writeGroupsSnapshot,
  writeTasksSnapshot,
  writeWorkflowsSnapshot,
} from './container-runner.js';
import { cleanupOrphans, cleanupStaleContainers, ensureContainerRuntimeRunning, stopContainer } from './container-runtime.js';
import {
  getAllChats,
  getAllCustomAgents,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getDatabase,
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
import { resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { createMessageBus } from './message-bus.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { startWorkflowSchedulerLoop } from './workflow-scheduler.js';
import { Channel, MessageBus, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { createCustomAgentService, CustomAgentService } from './custom-agent-service.js';
import { createShadowAgent } from './shadow-agent.js';
import { createWorkflowService, WorkflowService, type AgentStepInput } from './workflow-service.js';

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
let customAgentService: CustomAgentService | null = null;
let shadowInterceptor: (chatJid: string, msg: NewMessage) => boolean = () => false;
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
      if (f.endsWith('.json') || f === '_close') {
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

  // Clean stale IPC input files before spawning
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
        // Invoke custom agent asynchronously
        customAgentService.invokeAgent(
          matchedAgent.id,
          agentPrompt,
          chatJid,
          group.folder,
          isMainGroup,
        ).catch((err) => {
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

  const prompt = formatMessages(missedMessages);

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

  const output = await runAgent(group, prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      const text = formatOutbound(raw);
      logger.info({ group: group.name }, `Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        // Suppress duplicate outputs within a 10-second window
        const now = Date.now();
        if (text === lastSentText && (now - lastSentTime) < 10_000) {
          logger.warn({ group: group.name }, 'Duplicate agent output suppressed');
        } else {
          lastSentText = text;
          lastSentTime = now;

          await messageBus.emitAsync({
            type: 'message.outbound',
            source: 'agent',
            timestamp: new Date().toISOString(),
            data: { jid: chatJid, text, source: 'agent', groupFolder: group.folder },
          });

          outputSentToUser = true;
        }
      }

      // Advance cursor to cover any messages piped via IPC
      const latest = getMessagesSince(chatJid, lastAgentTimestamp[chatJid] || '', ASSISTANT_NAME);
      if (latest.length > 0) {
        lastAgentTimestamp[chatJid] = latest[latest.length - 1].timestamp;
        saveState();
      }

      // Only reset idle timer on actual results
      resetIdleTimer();
    }

    if (result.status === 'success') {
      queue.notifyIdle(chatJid);
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  // Stop typing indicator
  messageBus.emitAsync({
    type: 'typing.update',
    source: 'agent',
    timestamp: new Date().toISOString(),
    data: { jid: chatJid, isTyping: false },
  }).catch(() => {});
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    cleanIpcInputDir(group.folder);
    if (outputSentToUser) {
      // Check for remaining messages before giving up
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

  // Safety net: detect unprocessed IPC-piped messages
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

  // Update workflows snapshot for container to read
  if (workflowService) {
    const workflows = workflowService.listWorkflows().map(wf => ({
      id: wf.id,
      name: wf.name,
      description: wf.description,
      version: wf.version,
      stepCount: wf.steps.length,
      schedule: wf.schedule,
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
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        mcpServers: integrationMgr?.getActiveMcpServers(),
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
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

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || '',
            ASSISTANT_NAME,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend);

          if (queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
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
}

function ensureContainerSystemRunning(): void {
  ensureContainerRuntimeRunning();
  cleanupOrphans();
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

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

  workflowService = createWorkflowService({
    db: getDatabase(),
    messageBus: bus,
    getChannels: () => channels,
    adminJid: ADMIN_JID,
    runAgentContainer: async (input: AgentStepInput): Promise<string> => {
      // Use a promise that resolves on the first streamed output marker,
      // so we don't wait for the container process to exit (the claude
      // process inside can idle for minutes after the agent-runner finishes).
      let resolveResult: (value: string) => void;
      let rejectResult: (err: Error) => void;
      const resultPromise = new Promise<string>((res, rej) => {
        resolveResult = res;
        rejectResult = rej;
      });
      let gotStreamedOutput = false;
      let spawnedContainerName: string | null = null;

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
          if (output.status === 'error') {
            rejectResult(new Error(`Workflow container failed: ${output.error || 'unknown error'}`));
          } else {
            resolveResult(output.result || '');
          }
          // Stop the container now — we have the result and don't need it running
          if (spawnedContainerName) {
            const name = spawnedContainerName;
            exec(stopContainer(name), { timeout: 15_000 }, (err) => {
              if (err) logger.debug({ containerName: name, err }, 'Workflow container stop (may already be exiting)');
            });
          }
        },
      );

      // If container exits before any streamed output (error case), fall back
      containerPromise.then((output) => {
        if (!gotStreamedOutput) {
          if (output.status === 'error') {
            rejectResult(new Error(`Workflow container failed: ${output.error || 'unknown error'}`));
          } else {
            resolveResult(output.result || '');
          }
        }
      }).catch((err) => {
        if (!gotStreamedOutput) {
          rejectResult(err instanceof Error ? err : new Error(String(err)));
        }
      });

      return resultPromise;
    },
  });
  workflowService.reloadDefinitions();

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
    customAgentService: customAgentService ?? undefined,
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
