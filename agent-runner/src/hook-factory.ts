/**
 * Creates SDK hook callbacks for the agent query.
 * Hooks are thin adapters that delegate to TelemetryCollector and TranscriptArchiver.
 */
import type {
  HookCallback,
  HookEvent,
  HookCallbackMatcher,
  HookInput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PreCompactHookInput,
  SyncHookJSONOutput,
} from '@anthropic-ai/claude-agent-sdk';
import type { TelemetryCollector } from './telemetry-collector.js';
import type { TranscriptArchiver } from './transcript-archiver.js';
import type { Logger } from './logger.js';
import type { GuardrailReviewer } from './guardrail-reviewer.js';
import type { HeartbeatHandle } from './types.js';

/** Env vars to strip from Bash subprocess environments. */
const SECRET_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

export class HookFactory {
  constructor(
    private readonly telemetry: TelemetryCollector,
    private readonly archiver: TranscriptArchiver,
    private readonly logger: Logger,
    private readonly heartbeat?: HeartbeatHandle,
    private readonly guardrail?: GuardrailReviewer,
  ) {}

  /**
   * Build the complete hooks config for the SDK query options.
   */
  buildHooks(): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const preToolUseHooks: HookCallbackMatcher[] = [
      { matcher: 'Bash', hooks: [this.createSanitizeBashHook()] },
      { hooks: [this.createPreToolUseTimingHook()] },
    ];

    // Inline Haiku guardrail — reviews high-risk tool calls before execution
    if (this.guardrail) {
      preToolUseHooks.unshift({ hooks: [this.createGuardrailHook()] });
    }

    return {
      PreCompact: [{ hooks: [this.createPreCompactHook()] }],
      PreToolUse: preToolUseHooks,
      PostToolUse: [{ hooks: [this.createPostToolUseHook()] }],
      PostToolUseFailure: [{ hooks: [this.createPostToolUseFailureHook()] }],
    };
  }

  private createGuardrailHook(): HookCallback {
    const guardrail = this.guardrail!;
    return async (input: HookInput, _toolUseId, _options): Promise<SyncHookJSONOutput> => {
      if (!isHookEvent<PreToolUseHookInput>(input, 'PreToolUse')) return {};

      const toolName = input.tool_name;
      if (!guardrail.shouldReview(toolName)) return {};

      const result = await guardrail.review(toolName, input.tool_input);

      if (!result.allowed) {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `Guardrail: ${result.reason}`,
          },
        };
      }

      return {};
    };
  }

  private createPreCompactHook(): HookCallback {
    return async (input: HookInput, _toolUseId, _options): Promise<SyncHookJSONOutput> => {
      if (!isHookEvent<PreCompactHookInput>(input, 'PreCompact')) return {};

      if (!input.transcript_path) {
        this.logger.log('No transcript path for archiving');
        return {};
      }

      this.archiver.archive(input.transcript_path, input.session_id);
      return {};
    };
  }

  private createSanitizeBashHook(): HookCallback {
    return async (input: HookInput, _toolUseId, _options): Promise<SyncHookJSONOutput> => {
      if (!isHookEvent<PreToolUseHookInput>(input, 'PreToolUse')) return {};

      const toolInput = input.tool_input;
      if (!toolInput || typeof toolInput !== 'object') return {};

      const inputRecord = toolInput as Record<string, unknown>;
      const command = inputRecord.command;
      if (typeof command !== 'string') return {};

      const unsetPrefix = `unset ${SECRET_ENV_VARS.join(' ')} 2>/dev/null; `;
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          updatedInput: {
            ...inputRecord,
            command: unsetPrefix + command,
          },
        },
      };
    };
  }

  private createPreToolUseTimingHook(): HookCallback {
    return async (_input: HookInput, toolUseId, _options): Promise<SyncHookJSONOutput> => {
      this.heartbeat?.setPhase('tool-call');
      if (toolUseId) {
        this.telemetry.recordToolStart(toolUseId);
      }
      return {};
    };
  }

  private createPostToolUseHook(): HookCallback {
    return async (input: HookInput, toolUseId, _options): Promise<SyncHookJSONOutput> => {
      if (!isHookEvent<PostToolUseHookInput>(input, 'PostToolUse')) return {};

      this.heartbeat?.setPhase('querying');
      this.telemetry.recordToolSuccess(
        input.tool_name,
        toolUseId ?? undefined,
        truncate(stringify(input.tool_input), 200),
        truncate(stringify(input.tool_response), 500),
      );

      return {};
    };
  }

  private createPostToolUseFailureHook(): HookCallback {
    return async (input: HookInput, _toolUseId, _options): Promise<SyncHookJSONOutput> => {
      if (!isHookEvent<PostToolUseFailureHookInput>(input, 'PostToolUseFailure')) return {};

      this.heartbeat?.setPhase('querying');
      this.telemetry.recordToolFailure(
        input.tool_name,
        truncate(stringify(input.tool_input), 200),
        truncate(input.error, 500),
      );

      return {};
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Type guard: narrows HookInput to a specific hook event type via
 * the discriminated `hook_event_name` field.
 */
function isHookEvent<T extends HookInput>(
  input: HookInput,
  eventName: T['hook_event_name'],
): input is T {
  return input.hook_event_name === eventName;
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function truncate(str: string | undefined, maxLen: number): string | undefined {
  if (!str) return undefined;
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}
