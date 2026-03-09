/**
 * MCP tool registration: custom agent CRUD (create, list, invoke, update, delete).
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError, requestWithTimeout } from './helpers.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

export function registerAgentTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'create_custom_agent',
    `Create a new custom agent that uses a specific LLM provider. The agent gets its own container, memory, and can be invoked by name or trigger pattern.

PROVIDERS:
\u2022 "openai" \u2014 OpenAI models (gpt-4o, gpt-4o-mini, etc.)
\u2022 "xai" \u2014 XAI/Grok models (grok-3, grok-3-mini, etc.) \u2014 uses OpenAI-compatible API
\u2022 "anthropic" \u2014 Anthropic models (claude-sonnet-4-6, etc.)
\u2022 "google" \u2014 Google Gemini models (gemini-2.0-flash, gemini-1.5-pro, etc.)

TOOLS available to agents: "bash", "file_read", "file_write", "file_list", "web_fetch", "mcp:*" (all MCP tools including send_message, schedule_task)

TRIGGER PATTERN: regex pattern that routes user messages directly to this agent (e.g., "^@grok\\\\b" for messages starting with "@grok").`,
    {
      name: z.string().describe('Display name (e.g., "Grok Researcher")'),
      description: z.string().default('').describe('What this agent does'),
      provider: z.enum(['openai', 'xai', 'anthropic', 'google']).describe('LLM provider'),
      model: z.string().describe('Model ID (e.g., "grok-3", "gpt-4o", "gemini-2.0-flash")'),
      api_key_env_var: z.string().describe('Environment variable name for the API key (e.g., "XAI_API_KEY")'),
      base_url: z.string().optional().describe('Custom API base URL (required for XAI: "https://api.x.ai/v1")'),
      system_prompt: z.string().describe('System prompt for the agent'),
      tools: z.array(z.string()).default(['bash', 'file_read', 'file_write', 'file_list', 'web_fetch', 'mcp:*']).describe('Tools to enable'),
      trigger_pattern: z.string().optional().describe('Regex pattern for direct trigger routing (e.g., "^@grok\\\\b")'),
      max_iterations: z.number().default(25).describe('Max ReAct loop iterations'),
      timeout_ms: z.number().default(120000).describe('Execution timeout in ms'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can create custom agents.');

      const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      ctx.client.send({
        type: FRAME_TYPES.AGENT_CREATE,
        id: uuid(),
        payload: {
          agent: {
            id: agentId,
            name: args.name,
            description: args.description,
            provider: args.provider,
            model: args.model,
            api_key_env_var: args.api_key_env_var,
            base_url: args.base_url || null,
            system_prompt: args.system_prompt,
            tools: JSON.stringify(args.tools),
            trigger_pattern: args.trigger_pattern || null,
            group_folder: ctx.groupFolder,
            max_tokens: null,
            temperature: null,
            max_iterations: args.max_iterations,
            timeout_ms: args.timeout_ms,
            created_at: now,
            updated_at: now,
          },
        },
      });

      return mcpText(
        `Custom agent "${args.name}" created (ID: ${agentId}). ` +
        `Provider: ${args.provider}, Model: ${args.model}` +
        (args.trigger_pattern ? `, Trigger: ${args.trigger_pattern}` : ''),
      );
    },
  );

  ctx.server.tool(
    'list_custom_agents',
    'List all custom agents. From main: shows all agents. From other groups: shows only that group\'s agents.',
    {},
    async () => {
      const result = await requestWithTimeout(
        ctx.client,
        { type: FRAME_TYPES.AGENT_LIST, id: uuid(), payload: { groupFolder: ctx.groupFolder, isMain: ctx.isMain } },
        10_000,
        'Agent list',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );

  ctx.server.tool(
    'invoke_custom_agent',
    'Delegate a task to a custom agent. The agent runs in a separate container with its configured LLM provider and tools. Returns the agent\'s response.',
    {
      agent_id: z.string().describe('The custom agent ID (from list_custom_agents)'),
      prompt: z.string().describe('The task/prompt to send to the agent'),
    },
    async (args) => {
      ctx.client.send({
        type: FRAME_TYPES.AGENT_INVOKE,
        id: uuid(),
        payload: {
          agentId: args.agent_id,
          prompt: args.prompt,
          chatJid: ctx.chatJid,
          groupFolder: ctx.groupFolder,
          isMain: ctx.isMain,
        },
      });

      return mcpText(
        `Custom agent ${args.agent_id} invocation requested with prompt: "${args.prompt.slice(0, 100)}..."`,
      );
    },
  );

  ctx.server.tool(
    'update_custom_agent',
    'Update an existing custom agent\'s configuration. Only the fields you provide will be updated.',
    {
      agent_id: z.string().describe('The agent ID to update'),
      name: z.string().optional().describe('New display name'),
      description: z.string().optional().describe('New description'),
      provider: z.enum(['openai', 'xai', 'anthropic', 'google']).optional().describe('New LLM provider'),
      model: z.string().optional().describe('New model ID'),
      api_key_env_var: z.string().optional().describe('New API key env var'),
      base_url: z.string().optional().describe('New API base URL'),
      system_prompt: z.string().optional().describe('New system prompt'),
      tools: z.array(z.string()).optional().describe('New tools list'),
      trigger_pattern: z.string().optional().describe('New trigger pattern (empty string to remove)'),
      max_iterations: z.number().optional().describe('New max iterations'),
      timeout_ms: z.number().optional().describe('New timeout'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can update custom agents.');

      const updates: Record<string, unknown> = {};
      if (args.name !== undefined) updates.name = args.name;
      if (args.description !== undefined) updates.description = args.description;
      if (args.provider !== undefined) updates.provider = args.provider;
      if (args.model !== undefined) updates.model = args.model;
      if (args.api_key_env_var !== undefined) updates.api_key_env_var = args.api_key_env_var;
      if (args.base_url !== undefined) updates.base_url = args.base_url || null;
      if (args.system_prompt !== undefined) updates.system_prompt = args.system_prompt;
      if (args.tools !== undefined) updates.tools = JSON.stringify(args.tools);
      if (args.trigger_pattern !== undefined) updates.trigger_pattern = args.trigger_pattern || null;
      if (args.max_iterations !== undefined) updates.max_iterations = args.max_iterations;
      if (args.timeout_ms !== undefined) updates.timeout_ms = args.timeout_ms;

      ctx.client.send({
        type: FRAME_TYPES.AGENT_UPDATE,
        id: uuid(),
        payload: { agentId: args.agent_id, updates },
      });

      return mcpText(`Custom agent ${args.agent_id} update requested.`);
    },
  );

  ctx.server.tool(
    'delete_custom_agent',
    'Delete a custom agent and optionally clean up its memory.',
    {
      agent_id: z.string().describe('The agent ID to delete'),
      cleanup_memory: z.boolean().default(true).describe('Also delete the agent\'s memory files'),
    },
    async (args) => {
      if (!ctx.isMain) return mcpError('Only the main group can delete custom agents.');

      ctx.client.send({
        type: FRAME_TYPES.AGENT_DELETE,
        id: uuid(),
        payload: { agentId: args.agent_id, cleanupMemory: args.cleanup_memory },
      });

      return mcpText(`Custom agent ${args.agent_id} deletion requested.`);
    },
  );
}
