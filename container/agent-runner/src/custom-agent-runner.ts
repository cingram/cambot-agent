/**
 * Custom Agent Runner
 * Executes custom agents with configurable LLM providers inside the container.
 * Uses cambot-agents package for providers, tools, executor, and memory.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  ProviderRegistry,
  AgentExecutor,
  ToolRegistry,
  McpBridge,
  MemoryStore,
  generateRollingSummary,
  calculateCost,
  bashToolDef,
  createBashExecutor,
  fileReadDef, fileWriteDef, fileListDef,
  createFileReadExecutor, createFileWriteExecutor, createFileListExecutor,
  webFetchDef, createWebFetchExecutor,
  xSearchDef, xaiWebSearchDef, createNoOpExecutor,
} from 'cambot-agents';
import type { ProviderConfig, ProviderName } from 'cambot-agents';

interface CustomAgentContainerInput {
  prompt: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  secrets?: Record<string, string>;
  customAgent: {
    agentId: string;
    provider: ProviderName;
    model: string;
    baseUrl?: string;
    apiKeyEnvVar: string;
    systemPrompt: string;
    tools: string[];
    maxTokens?: number;
    temperature?: number;
    maxIterations?: number;
    timeoutMs?: number;
  };
}

interface ContainerTelemetry {
  totalCostUsd: number;
  durationMs: number;
  durationApiMs: number;
  numTurns: number;
  usage: { inputTokens: number; outputTokens: number };
  modelUsage: Record<string, { inputTokens: number; outputTokens: number; costUSD: number }>;
  toolInvocations: Array<{
    toolName: string;
    durationMs?: number;
    status: 'success' | 'error';
    inputSummary?: string;
    outputSummary?: string;
    error?: string;
  }>;
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  telemetry?: ContainerTelemetry;
}

type WriteOutputFn = (output: ContainerOutput) => void;
type LogFn = (message: string) => void;

export async function runCustomAgent(
  input: CustomAgentContainerInput,
  writeOutput: WriteOutputFn,
  log: LogFn,
): Promise<void> {
  const agentConfig = input.customAgent;
  log(`Starting custom agent: ${agentConfig.agentId} (${agentConfig.provider}/${agentConfig.model})`);

  // 1. Resolve API key from secrets
  const apiKey = input.secrets?.[agentConfig.apiKeyEnvVar];
  if (!apiKey) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Missing API key: ${agentConfig.apiKeyEnvVar} not found in secrets`,
    });
    return;
  }

  // 2. Create provider
  const providerRegistry = ProviderRegistry.createDefault();
  const provider = providerRegistry.create(agentConfig.provider);

  const providerConfig: ProviderConfig = {
    provider: agentConfig.provider,
    model: agentConfig.model,
    apiKey,
    baseUrl: agentConfig.baseUrl,
    maxTokens: agentConfig.maxTokens,
    temperature: agentConfig.temperature,
  };

  // 3. Register tools
  const toolRegistry = new ToolRegistry();
  const workDir = '/workspace/group';
  const baseDir = '/workspace';
  const requestedTools = new Set(agentConfig.tools);

  if (requestedTools.has('bash')) {
    toolRegistry.register('bash', bashToolDef, createBashExecutor(workDir));
  }
  if (requestedTools.has('file_read')) {
    toolRegistry.register('file_read', fileReadDef, createFileReadExecutor(baseDir));
  }
  if (requestedTools.has('file_write')) {
    toolRegistry.register('file_write', fileWriteDef, createFileWriteExecutor(baseDir));
  }
  if (requestedTools.has('file_list')) {
    toolRegistry.register('file_list', fileListDef, createFileListExecutor(baseDir));
  }
  if (requestedTools.has('web_fetch')) {
    toolRegistry.register('web_fetch', webFetchDef, createWebFetchExecutor());
  }
  if (requestedTools.has('x_search')) {
    toolRegistry.register('x_search', xSearchDef, createNoOpExecutor());
  }
  if (requestedTools.has('web_search')) {
    toolRegistry.register('web_search', xaiWebSearchDef, createNoOpExecutor());
  }

  // 4. Connect MCP bridge if MCP tools requested
  let mcpBridge: McpBridge | null = null;
  const hasMcpTools = agentConfig.tools.some((t) => t.startsWith('mcp:'));

  if (hasMcpTools) {
    try {
      const __dirname = path.dirname(fileURLToPath(import.meta.url));
      const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');
      mcpBridge = new McpBridge();
      await mcpBridge.connect('node', [mcpServerPath], {
        CAMBOT_AGENT_CHAT_JID: input.chatJid,
        CAMBOT_AGENT_GROUP_FOLDER: input.groupFolder,
        CAMBOT_AGENT_IS_MAIN: input.isMain ? '1' : '0',
      });

      const mcpTools = await mcpBridge.discoverTools();
      log(`Discovered ${mcpTools.length} MCP tools`);

      // Register MCP tools based on filter
      const wantAllMcp = requestedTools.has('mcp:*');
      for (const tool of mcpTools) {
        if (wantAllMcp || requestedTools.has(tool.name)) {
          const bridge = mcpBridge;
          toolRegistry.register(tool.name, tool, (args) => bridge.callTool(tool.name, args));
        }
      }
    } catch (err) {
      log(`MCP bridge connection failed: ${err instanceof Error ? err.message : String(err)}`);
      // Continue without MCP tools
    }
  }

  // 5. Load memory
  const memoryStore = new MemoryStore(path.join(workDir, 'agents'));
  const memory = memoryStore.load(agentConfig.agentId);
  let systemPrompt = agentConfig.systemPrompt;
  if (memory?.summary) {
    systemPrompt += `\n\n<previous_context>\n${memory.summary}\n</previous_context>`;
  }

  // 6. Execute agent
  log(`Executing with ${toolRegistry.names().length} tools, max ${agentConfig.maxIterations ?? 25} iterations`);

  const executor = new AgentExecutor({
    provider,
    config: providerConfig,
    tools: toolRegistry,
    systemPrompt,
    maxIterations: agentConfig.maxIterations,
    timeoutMs: agentConfig.timeoutMs,
    onText: (text) => {
      log(`Agent text: ${text.slice(0, 200)}`);
    },
    onToolCall: (name, args) => {
      log(`Tool call: ${name}(${args.slice(0, 100)})`);
    },
    onToolResult: (name, result) => {
      log(`Tool result: ${name} → ${result.slice(0, 200)}`);
    },
  });

  const startTime = Date.now();

  try {
    const result = await executor.execute(input.prompt);
    const durationMs = Date.now() - startTime;

    const inputTokens = result.totalTokens.prompt;
    const outputTokens = result.totalTokens.completion;
    const costUsd = calculateCost(agentConfig.model, inputTokens, outputTokens);

    log(`Agent completed: ${result.iterations} iterations, ${inputTokens + outputTokens} tokens, $${costUsd.toFixed(6)}`);

    const telemetry: ContainerTelemetry = {
      totalCostUsd: costUsd,
      durationMs,
      durationApiMs: 0,
      numTurns: result.iterations,
      usage: { inputTokens, outputTokens },
      modelUsage: {
        [agentConfig.model]: { inputTokens, outputTokens, costUSD: costUsd },
      },
      toolInvocations: [],
    };

    // 7. Update memory
    try {
      const newSummary = await generateRollingSummary(
        provider,
        providerConfig,
        memory?.summary ?? null,
        result.conversationHistory,
      );
      memoryStore.save({
        agentId: agentConfig.agentId,
        summary: newSummary,
        lastUpdated: new Date().toISOString(),
        conversationCount: (memory?.conversationCount ?? 0) + 1,
      });
      log('Memory updated');
    } catch (err) {
      log(`Memory update failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    writeOutput({
      status: 'success',
      result: result.finalResponse || null,
      telemetry,
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent execution error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      error: errorMessage,
      telemetry: {
        totalCostUsd: 0,
        durationMs,
        durationApiMs: 0,
        numTurns: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        modelUsage: {},
        toolInvocations: [],
      },
    });
  } finally {
    // 8. Disconnect MCP bridge
    if (mcpBridge) {
      try {
        await mcpBridge.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
  }
}
