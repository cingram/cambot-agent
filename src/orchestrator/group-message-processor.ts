import {
  ASSISTANT_NAME,
  MAIN_GROUP_FOLDER,
  TRIGGER_PATTERN,
} from '../config/config.js';
import {
  findCustomAgentByTrigger,
  getMessagesSince,
} from '../db/index.js';
import { GroupQueue } from '../groups/group-queue.js';
import { formatMessages, formatOutbound } from '../utils/router.js';
import { logger } from '../logger.js';
import type { MessageBus, Channel } from '../types.js';
import type { LifecycleInterceptor } from '../utils/lifecycle-interceptor.js';
import type { CustomAgentService } from '../agents/custom-agent-service.js';
import { OutboundMessage, TypingUpdate } from '../bus/index.js';
import type { AgentRunner } from './agent-runner.js';
import type { RouterState } from './router-state.js';

export interface GroupMessageProcessorDeps {
  state: RouterState;
  queue: GroupQueue;
  bus: MessageBus;
  getChannels: () => Channel[];
  getInterceptor: () => LifecycleInterceptor | null;
  getCustomAgentService: () => CustomAgentService | null;
  agentRunner: AgentRunner;
}

export class GroupMessageProcessor {
  private deps: GroupMessageProcessorDeps;

  constructor(deps: GroupMessageProcessorDeps) {
    this.deps = deps;
  }

  async process(chatJid: string): Promise<boolean> {
    const { state, queue, bus, agentRunner } = this.deps;
    const interceptor = this.deps.getInterceptor();
    const customAgentService = this.deps.getCustomAgentService();

    const group = state.getRegisteredGroup(chatJid);
    if (!group) return true;

    // Verify at least one channel can handle this JID
    const channels = this.deps.getChannels();
    const hasChannel = channels.some(ch => ch.ownsJid(chatJid));
    if (!hasChannel) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

    // Clean stale IPC input files from previous container runs
    agentRunner.cleanIpcInputDir(group.folder);

    const sinceTimestamp = state.getAgentTimestamp(chatJid);
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
          state.setAgentTimestamp(chatJid, missedMessages[missedMessages.length - 1].timestamp);
          state.save();
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
    const bootContext = interceptor ? await interceptor.getBootContext(rawPrompt) : '';
    const fullRawPrompt = bootContext
      ? `<system-context>\n${bootContext}\n</system-context>\n\n${rawPrompt}`
      : rawPrompt;
    const { redacted: prompt, mappings: piiMappings } = interceptor
      ? interceptor.redactPrompt(fullRawPrompt)
      : { redacted: fullRawPrompt, mappings: [] };
    interceptor?.startSession(group.folder, chatJid);

    // Advance cursor, save old for rollback on error
    const previousCursor = state.getAgentTimestamp(chatJid);
    state.setAgentTimestamp(chatJid, missedMessages[missedMessages.length - 1].timestamp);
    state.save();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );

    // Typing indicator via bus
    bus.emit(new TypingUpdate('agent', chatJid, true)).catch(() => {});

    let hadError = false;
    let outputSentToUser = false;
    let lastSentText = '';
    let lastSentTime = 0;
    let hadTelemetry = false;
    const containerStartTime = Date.now();

    const output = await agentRunner.run(group, prompt, chatJid, async (result) => {
      // Record telemetry if present
      if (result.telemetry && interceptor) {
        interceptor.recordTelemetry(result.telemetry, chatJid);
        hadTelemetry = true;
      }

      // Streaming output callback
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
            const restoredText = interceptor
              ? interceptor.restoreOutput(text, piiMappings)
              : text;

            await bus.emit(new OutboundMessage('agent', chatJid, restoredText, { groupFolder: group.folder }));
            interceptor?.ingestResponse(group.folder, chatJid, restoredText);
            outputSentToUser = true;
          }
        }

        // Advance cursor to cover IPC-piped messages
        const latest = getMessagesSince(chatJid, state.getAgentTimestamp(chatJid), ASSISTANT_NAME);
        if (latest.length > 0) {
          state.setAgentTimestamp(chatJid, latest[latest.length - 1].timestamp);
          state.save();
        }
      }

      if (result.status === 'success') {
        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    });

    // Stop typing indicator
    bus.emit(new TypingUpdate('agent', chatJid, false)).catch(() => {});
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
      agentRunner.cleanIpcInputDir(group.folder);
      if (outputSentToUser) {
        const remaining = getMessagesSince(chatJid, state.getAgentTimestamp(chatJid), ASSISTANT_NAME);
        if (remaining.length > 0) {
          logger.warn({ group: group.name, count: remaining.length }, 'Agent error after output; unprocessed messages remain, retrying');
          return false;
        }
        logger.warn({ group: group.name }, 'Agent error after output was sent, skipping cursor rollback to prevent duplicates');
        return true;
      }
      // Roll back cursor for retry
      state.setAgentTimestamp(chatJid, previousCursor);
      state.save();
      logger.warn({ group: group.name }, 'Agent error, rolled back message cursor for retry');
      return false;
    }

    // Safety net: detect unprocessed IPC-piped messages
    const remaining = getMessagesSince(chatJid, state.getAgentTimestamp(chatJid), ASSISTANT_NAME);
    if (remaining.length > 0) {
      logger.warn(
        { group: group.name, count: remaining.length },
        'Unprocessed messages found after container exit, re-queuing',
      );
      agentRunner.cleanIpcInputDir(group.folder);
      return false;
    }

    return true;
  }
}
