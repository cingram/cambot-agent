/**
 * The query-wait-query loop that manages the agent's lifecycle.
 * Handles session continuity, socket message delivery, and clean shutdown.
 */
import type { ClaudeContainerInput, HeartbeatHandle } from './types.js';
import type { Logger } from './logger.js';
import type { OutputWriter } from './output-writer.js';
import type { CambotSocketClient } from './cambot-socket-client.js';
import type { SdkQueryRunner, QueryResult } from './sdk-query-runner.js';

/** Optional hooks for observing or transforming lifecycle events. */
export interface LifecycleHooks {
  /** Called before each SDK query. Return a transformed prompt or void to keep original. */
  onQueryStart?(prompt: string, sessionId?: string): string | void;
  /** Called after each SDK query completes. */
  onQueryComplete?(result: QueryResult, sessionId?: string): void;
  /** Called when a new message arrives (between queries). Return transformed text or void. */
  onMessageReceived?(message: string): string | void;
  /** Called when the runner is about to exit the loop. */
  onClose?(reason: 'closedDuringQuery' | 'sessionClose' | 'timeout'): void;
}

export class AgentRunner {
  constructor(
    private readonly logger: Logger,
    private readonly outputWriter: OutputWriter,
    private readonly client: CambotSocketClient,
    private readonly queryRunner: SdkQueryRunner,
    private readonly hooks: LifecycleHooks = {},
    private readonly heartbeat?: HeartbeatHandle,
  ) {}

  async run(
    input: ClaudeContainerInput,
    sdkEnv: Record<string, string | undefined>,
  ): Promise<void> {
    let sessionId = input.sessionId;
    let resumeAt: string | undefined;

    // Build initial prompt
    let prompt = input.prompt;
    if (input.isScheduledTask) {
      prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
    }

    // Query loop: run query -> wait for socket message -> run new query -> repeat
    while (true) {
      this.logger.info(`Starting query (session: ${sessionId || 'new'}, resumeAt: ${resumeAt || 'latest'})...`);
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

      // If connection closed during the query, exit immediately.
      if (queryResult.closedDuringQuery) {
        this.heartbeat?.setPhase('shutting-down');
        this.hooks.onClose?.('closedDuringQuery');
        this.logger.info('Socket closed during query, exiting');
        break;
      }

      // Emit session update so host can track it
      this.outputWriter.write({ status: 'success', result: null, newSessionId: sessionId });

      // Recover messages from race windows
      const recovered = queryResult.unconsumedMessages;
      if (recovered.length > 0) {
        this.logger.info(`Immediate follow-up: ${recovered.length} pending message(s)`);
        prompt = recovered.join('\n');
        continue;
      }

      // Check if client is still connected
      if (!this.client.isConnected()) {
        this.heartbeat?.setPhase('shutting-down');
        this.hooks.onClose?.('sessionClose');
        this.logger.info('Socket connection closed, exiting');
        break;
      }

      this.logger.info('Query ended, waiting for next message...');
      this.heartbeat?.setPhase('idle');

      // Wait for the next message over the socket
      const nextMessage = await this.client.waitForMessage();
      if (nextMessage === null) {
        this.heartbeat?.setPhase('shutting-down');
        this.hooks.onClose?.('timeout');
        this.logger.info('Socket closed (or session ended), exiting');
        break;
      }

      this.logger.info(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = this.hooks.onMessageReceived?.(nextMessage) ?? nextMessage;
    }
  }
}
