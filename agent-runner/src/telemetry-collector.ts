/**
 * Collects tool invocation timing and extracts telemetry from SDK result messages.
 * Uses SDK's typed ModelUsage directly — no unsafe casts.
 */
import type { SDKResultMessage, ModelUsage } from '@anthropic-ai/claude-agent-sdk';
import type { ContainerTelemetry, ToolInvocationEntry, ToolInvocationRecord } from './types.js';

export class TelemetryCollector {
  private readonly invocations: ToolInvocationEntry[] = [];
  private readonly startTimes = new Map<string, number>();

  recordToolStart(toolUseId: string): void {
    this.startTimes.set(toolUseId, Date.now());
  }

  recordToolSuccess(
    toolName: string,
    toolUseId: string | undefined,
    inputSummary?: string,
    outputSummary?: string,
  ): void {
    const endTime = Date.now();
    const startTime = toolUseId ? this.startTimes.get(toolUseId) : undefined;
    this.invocations.push({
      toolName,
      startTime: startTime ?? endTime,
      durationMs: startTime ? endTime - startTime : undefined,
      status: 'success',
      inputSummary,
      outputSummary,
    });
  }

  recordToolFailure(
    toolName: string,
    inputSummary?: string,
    error?: string,
  ): void {
    this.invocations.push({
      toolName,
      startTime: Date.now(),
      status: 'error',
      inputSummary,
      error,
    });
  }

  /**
   * Extract telemetry from an SDK result message.
   * Both SDKResultSuccess and SDKResultError share the telemetry fields.
   */
  extractFromResult(result: SDKResultMessage): ContainerTelemetry {
    return {
      totalCostUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      durationApiMs: result.duration_api_ms,
      numTurns: result.num_turns,
      usage: {
        inputTokens: result.usage.input_tokens ?? 0,
        outputTokens: result.usage.output_tokens ?? 0,
      },
      modelUsage: convertModelUsage(result.modelUsage),
      toolInvocations: this.getInvocationRecords(),
    };
  }

  private getInvocationRecords(): ToolInvocationRecord[] {
    return this.invocations.map(t => ({
      toolName: t.toolName,
      durationMs: t.durationMs,
      status: t.status,
      inputSummary: t.inputSummary,
      outputSummary: t.outputSummary,
      error: t.error,
    }));
  }

  reset(): void {
    this.invocations.length = 0;
    this.startTimes.clear();
  }
}

function convertModelUsage(
  raw: Record<string, ModelUsage>,
): Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> {
  const result: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }> = {};
  for (const [model, usage] of Object.entries(raw)) {
    result[model] = {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUSD: usage.costUSD,
    };
  }
  return result;
}
