/**
 * Executes a single SDK query and processes the message stream.
 * IPC polling is delegated to IpcQueryBridge.
 */
import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  SDKMessage,
  SDKTaskNotificationMessage,
  SettingSource,
} from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeContainerInput, ContainerTelemetry, ContainerPaths } from './types.js';
import type { Logger } from './logger.js';
import type { OutputWriter } from './output-writer.js';
import type { IpcChannel } from './ipc-channel.js';
import type { TelemetryCollector } from './telemetry-collector.js';
import type { HookFactory } from './hook-factory.js';
import type { ContextBuilder } from './context-builder.js';
import type { HeartbeatWriter } from './heartbeat-writer.js';
import { MessageStream } from './message-stream.js';
import { IpcQueryBridge } from './ipc-query-bridge.js';
import { loadMcpConfig } from './mcp-config.js';

export interface QueryResult {
  newSessionId?: string;
  lastAssistantUuid?: string;
  closedDuringQuery: boolean;
  unconsumedMessages: string[];
  telemetry?: ContainerTelemetry;
}

export class SdkQueryRunner {
  constructor(
    private readonly paths: ContainerPaths,
    private readonly logger: Logger,
    private readonly outputWriter: OutputWriter,
    private readonly ipc: IpcChannel,
    private readonly hookFactory: HookFactory,
    private readonly contextBuilder: ContextBuilder,
    private readonly telemetry: TelemetryCollector,
    private readonly scriptDir: string,
    private readonly heartbeat?: HeartbeatWriter,
  ) {}

  async run(
    prompt: string,
    input: ClaudeContainerInput,
    sdkEnv: Record<string, string | undefined>,
    sessionId?: string,
    resumeAt?: string,
  ): Promise<QueryResult> {
    const stream = new MessageStream();
    stream.push(prompt);

    // Reset telemetry for this query
    this.telemetry.reset();

    // Wire IPC polling to stream
    const bridge = new IpcQueryBridge(this.ipc, stream, this.logger);
    const { result: bridgeResult } = bridge.start();

    // Build context and SDK options
    const context = this.contextBuilder.build(input);
    const sdkOptions = this.buildSdkOptions(input, sdkEnv, context, sessionId, resumeAt);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let messageCount = 0;
    let resultCount = 0;
    let lastResultText: string | null = null;
    let queryTelemetry: ContainerTelemetry | undefined;

    try {
      for await (const message of query({ prompt: stream, options: sdkOptions })) {
        messageCount++;
        logMessage(this.logger, message, messageCount);

        // SDK discriminated union narrowing — no `as` casts needed
        if (message.type === 'assistant') {
          lastAssistantUuid = message.uuid;
        }

        if (message.type === 'system' && message.subtype === 'init') {
          newSessionId = message.session_id;
          this.logger.log(`Session initialized: ${newSessionId}`);
        }

        if (message.type === 'system' && message.subtype === 'task_notification') {
          // SDKTaskNotificationMessage shares type:'system' with SDKSystemMessage,
          // so TypeScript can't narrow on subtype alone — use a targeted cast here.
          const tn = message as SDKTaskNotificationMessage;
          this.logger.log(`Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`);
        }

        if (message.type === 'result') {
          const textResult = message.subtype === 'success' ? message.result : null;

          // Suppress duplicate results (same text emitted twice by SDK/agent-teams)
          if (textResult && textResult === lastResultText) {
            this.logger.log(`Result: suppressed duplicate of result #${resultCount}`);
            continue;
          }
          lastResultText = textResult || null;
          resultCount++;
          this.logger.log(
            `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
          );

          // Extract telemetry from typed SDK fields
          queryTelemetry = this.telemetry.extractFromResult(message);
          this.logger.log(
            `Telemetry: cost=$${queryTelemetry.totalCostUsd.toFixed(4)}, turns=${queryTelemetry.numTurns}, tools=${queryTelemetry.toolInvocations.length}`,
          );

          this.outputWriter.write({
            status: 'success',
            result: textResult || null,
            newSessionId,
            telemetry: queryTelemetry,
          });

          // Result emitted — agent is idle while SDK stream finishes
          this.heartbeat?.setPhase('idle');
        }
      }
    } finally {
      // Deterministic cleanup via AbortController
      bridge.stop();
    }

    // Recover unconsumed messages from the stream
    const unconsumedMessages = stream.drain();
    if (unconsumedMessages.length > 0) {
      this.logger.log(`Recovered ${unconsumedMessages.length} unconsumed message(s) from stream`);
    }

    this.logger.log(
      `Query done. Messages: ${messageCount}, results: ${resultCount}, ` +
      `lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${bridgeResult.closedDuringQuery}`,
    );

    return {
      newSessionId,
      lastAssistantUuid,
      closedDuringQuery: bridgeResult.closedDuringQuery,
      unconsumedMessages,
      telemetry: queryTelemetry,
    };
  }

  private buildSdkOptions(
    input: ClaudeContainerInput,
    sdkEnv: Record<string, string | undefined>,
    context: { systemPrompt: string | undefined; additionalDirectories: string[] },
    sessionId?: string,
    resumeAt?: string,
  ) {
    const mcpConfig = loadMcpConfig(
      this.paths.mcpConfigPath,
      {
        scriptDir: this.scriptDir,
        chatJid: input.chatJid,
        groupFolder: input.groupFolder,
        isMain: input.isMain,
        isInterAgentTarget: input.isInterAgentTarget,
      },
      input.mcpServers,
    );

    return {
      cwd: this.paths.groupDir,
      additionalDirectories: context.additionalDirectories.length > 0
        ? context.additionalDirectories
        : undefined,
      resume: sessionId,
      resumeSessionAt: resumeAt,
      systemPrompt: context.systemPrompt
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: context.systemPrompt }
        : undefined,
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        ...mcpConfig.allowedTools,
      ],
      env: sdkEnv,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      settingSources: ['project', 'user'] as SettingSource[],
      mcpServers: mcpConfig.servers,
      hooks: this.hookFactory.buildHooks(),
    };
  }
}

function logMessage(logger: Logger, message: SDKMessage, count: number): void {
  const msgType = message.type === 'system'
    ? `system/${message.subtype}`
    : message.type;
  logger.log(`[msg #${count}] type=${msgType}`);
}
