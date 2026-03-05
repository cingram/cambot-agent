/**
 * The query-wait-query loop that manages the agent's lifecycle.
 * Handles session continuity, IPC message recovery, and clean shutdown.
 */
import type { ClaudeContainerInput } from './types.js';
import type { Logger } from './logger.js';
import type { OutputWriter } from './output-writer.js';
import type { IpcChannel } from './ipc-channel.js';
import type { SdkQueryRunner, QueryResult } from './sdk-query-runner.js';
import type { HeartbeatWriter } from './heartbeat-writer.js';

/** Optional hooks for observing or transforming lifecycle events. */
export interface LifecycleHooks {
  /** Called before each SDK query. Return a transformed prompt or void to keep original. */
  onQueryStart?(prompt: string, sessionId?: string): string | void;
  /** Called after each SDK query completes. */
  onQueryComplete?(result: QueryResult, sessionId?: string): void;
  /** Called when a new IPC message arrives (between queries). Return transformed text or void. */
  onMessageReceived?(message: string): string | void;
  /** Called when the runner is about to exit the loop. */
  onClose?(reason: 'closedDuringQuery' | 'closeSentinel' | 'timeout'): void;
}

export class AgentRunner {
  constructor(
    private readonly logger: Logger,
    private readonly outputWriter: OutputWriter,
    private readonly ipc: IpcChannel,
    private readonly queryRunner: SdkQueryRunner,
    private readonly hooks: LifecycleHooks = {},
    private readonly heartbeat?: HeartbeatWriter,
  ) {}

  async run(
    input: ClaudeContainerInput,
    sdkEnv: Record<string, string | undefined>,
  ): Promise<void> {
    let sessionId = input.sessionId;
    let resumeAt: string | undefined;

    // Build initial prompt with any pending IPC messages
    let prompt = input.prompt;
    if (input.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }
    const pending = this.ipc.drain();
    if (pending.length > 0) {
      this.logger.log(`Draining ${pending.length} pending IPC messages into initial prompt`);
      prompt += '\n' + pending.join('\n');
    }

    // Query loop: run query → wait for IPC message → run new query → repeat
    while (true) {
      this.logger.log(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);
      prompt = this.hooks.onQueryStart?.(prompt, sessionId) ?? prompt;

      this.heartbeat?.setPhase('querying');
      this.heartbeat?.incrementQueryCount();
      const queryResult = await this.queryRunner.run(prompt, input, sdkEnv, sessionId, resumeAt);

      if (queryResult.newSessionId) {
        sessionId = queryResult.newSessionId;
      }
      if (queryResult.lastAssistantUuid) {
        resumeAt = queryResult.lastAssistantUuid;
      }

      this.hooks.onQueryComplete?.(queryResult, sessionId);

      // Emit telemetry for the completed query
      if (queryResult.telemetry) {
        this.outputWriter.write({
          status: 'success', result: null, newSessionId: sessionId, telemetry: queryResult.telemetry,
        });
      }

      // If close was consumed during the query, exit immediately.
      // Don't emit a session-update marker (it would reset the host's
      // idle timer and cause a 30-min delay before the next _close).
      if (queryResult.closedDuringQuery) {
        this.heartbeat?.setPhase('shutting-down');
        this.hooks.onClose?.('closedDuringQuery');
        this.logger.log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      this.outputWriter.write({ status: 'success', result: null, newSessionId: sessionId });

      // Recover messages from race windows:
      // 1. Messages consumed from IPC by bridge but never read by SDK
      // 2. Messages that arrived after bridge polling stopped
      const recovered = queryResult.unconsumedMessages;
      const freshIpc = this.ipc.drain();
      const pendingMessages = [...recovered, ...freshIpc];

      if (pendingMessages.length > 0) {
        this.logger.log(`Immediate follow-up: ${pendingMessages.length} pending message(s)`);
        prompt = pendingMessages.join('\n');
        continue;
      }

      // Check for close AFTER draining pending messages
      if (this.ipc.shouldClose()) {
        // Atomic drain+close to prevent orphaning messages
        const finalMessages = this.ipc.drainAndClose();
        if (finalMessages.length > 0) {
          this.logger.log(`Final drain recovered ${finalMessages.length} message(s) at close — processing`);
          prompt = finalMessages.join('\n');
          const finalResult = await this.queryRunner.run(prompt, input, sdkEnv, sessionId, resumeAt);
          if (finalResult.telemetry) {
            this.outputWriter.write({
              status: 'success', result: null, newSessionId: sessionId, telemetry: finalResult.telemetry,
            });
          }
        }
        this.heartbeat?.setPhase('shutting-down');
        this.hooks.onClose?.('closeSentinel');
        this.logger.log('Close sentinel received after query, exiting');
        break;
      }

      this.logger.log('Query ended, waiting for next IPC message...');
      this.heartbeat?.setPhase('idle');

      // Wait for the next message or close sentinel (with timeout)
      const nextMessage = await this.ipc.waitForMessage();
      if (nextMessage === null) {
        this.heartbeat?.setPhase('shutting-down');
        this.hooks.onClose?.('timeout');
        this.logger.log('Close sentinel received (or timeout), exiting');
        break;
      }

      this.logger.log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = this.hooks.onMessageReceived?.(nextMessage) ?? nextMessage;
    }
  }
}
