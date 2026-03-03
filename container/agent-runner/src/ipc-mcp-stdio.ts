/**
 * Stdio MCP Server for CamBot-Agent
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.CAMBOT_AGENT_CHAT_JID!;
const groupFolder = process.env.CAMBOT_AGENT_GROUP_FOLDER!;
const isMain = process.env.CAMBOT_AGENT_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'cambot-agent',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
    target_jid: z.string().optional().describe(
      'Target chat JID for cross-channel messaging (main group only). '
      + 'Defaults to current chat. Examples: "im:+1234567890", "web:ui", "tg:12345"',
    ),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid: args.target_jid || chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT:
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am local time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour). Use for recurring tasks.
\u2022 once: Run once. Accepts either:
  - A relative offset: "+2m", "+30s", "+1h", "+90m" (minutes, seconds, hours). PREFERRED for "in X minutes" requests.
  - An absolute local timestamp: "2026-02-01T15:30:00" (interpreted as local timezone, auto-converted to UTC).
  Timestamps with "Z" or timezone offsets are also accepted.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time or after a delay'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: relative like "+2m", "+1h", "+30s" OR absolute like "2026-02-01T15:30:00"'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      // Support relative offsets: "+2m", "+30s", "+1h"
      const relMatch = args.schedule_value.match(/^\+(\d+)(s|m|h)$/);
      if (relMatch) {
        const amount = parseInt(relMatch[1], 10);
        const unit = relMatch[2];
        const multiplier = unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
        const targetMs = Date.now() + amount * multiplier;
        // Normalize to UTC ISO — host stores and compares in UTC
        args.schedule_value = new Date(targetMs).toISOString();
      } else {
        // Absolute timestamp — treat bare timestamps (no Z or offset) as UTC,
        // since Claude typically calculates times in UTC
        let value = args.schedule_value;
        if (!/[Zz]$/.test(value) && !/[+-]\d{2}:\d{2}$/.test(value)) {
          value += 'Z';
        }
        const date = new Date(value);
        if (isNaN(date.getTime())) {
          return {
            content: [{ type: 'text' as const, text: `Invalid schedule value: "${args.schedule_value}". Use relative like "+2m", "+1h" or absolute like "2026-02-01T15:30:00Z".` }],
            isError: true,
          };
        }
        args.schedule_value = date.toISOString();
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    // Show resolved local time for once tasks so the user can verify
    const displayValue = args.schedule_type === 'once'
      ? new Date(args.schedule_value).toLocaleString()
      : args.schedule_value;

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${displayValue}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ── Custom Agent Tools ────────────────────────────────────────────────

server.tool(
  'create_custom_agent',
  `Create a new custom agent that uses a specific LLM provider. The agent gets its own container, memory, and can be invoked by name or trigger pattern.

PROVIDERS:
• "openai" — OpenAI models (gpt-4o, gpt-4o-mini, etc.)
• "xai" — XAI/Grok models (grok-3, grok-3-mini, etc.) — uses OpenAI-compatible API
• "anthropic" — Anthropic models (claude-sonnet-4-6, etc.)
• "google" — Google Gemini models (gemini-2.0-flash, gemini-1.5-pro, etc.)

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
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can create custom agents.' }],
        isError: true,
      };
    }

    const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const data = {
      type: 'create_custom_agent',
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
        group_folder: groupFolder,
        max_tokens: null,
        temperature: null,
        max_iterations: args.max_iterations,
        timeout_ms: args.timeout_ms,
        created_at: now,
        updated_at: now,
      },
      timestamp: now,
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Custom agent "${args.name}" created (ID: ${agentId}). Provider: ${args.provider}, Model: ${args.model}${args.trigger_pattern ? `, Trigger: ${args.trigger_pattern}` : ''}` }],
    };
  },
);

server.tool(
  'list_custom_agents',
  'List all custom agents. From main: shows all agents. From other groups: shows only that group\'s agents.',
  {},
  async () => {
    const agentsFile = path.join(IPC_DIR, 'custom_agents.json');

    try {
      if (!fs.existsSync(agentsFile)) {
        return { content: [{ type: 'text' as const, text: 'No custom agents found.' }] };
      }

      const allAgents = JSON.parse(fs.readFileSync(agentsFile, 'utf-8'));
      const agents = isMain
        ? allAgents
        : allAgents.filter((a: { group_folder: string }) => a.group_folder === groupFolder);

      if (agents.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No custom agents found.' }] };
      }

      const formatted = agents
        .map(
          (a: { id: string; name: string; provider: string; model: string; trigger_pattern: string | null; description: string }) =>
            `- [${a.id}] ${a.name} (${a.provider}/${a.model})${a.trigger_pattern ? ` trigger: ${a.trigger_pattern}` : ''}\n  ${a.description || 'No description'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Custom agents:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading agents: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'invoke_custom_agent',
  'Delegate a task to a custom agent. The agent runs in a separate container with its configured LLM provider and tools. Returns the agent\'s response.',
  {
    agent_id: z.string().describe('The custom agent ID (from list_custom_agents)'),
    prompt: z.string().describe('The task/prompt to send to the agent'),
  },
  async (args) => {
    const data = {
      type: 'invoke_custom_agent',
      agentId: args.agent_id,
      prompt: args.prompt,
      chatJid,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Custom agent ${args.agent_id} invocation requested with prompt: "${args.prompt.slice(0, 100)}..."` }],
    };
  },
);

server.tool(
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
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can update custom agents.' }],
        isError: true,
      };
    }

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

    const data = {
      type: 'update_custom_agent',
      agentId: args.agent_id,
      updates,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Custom agent ${args.agent_id} update requested.` }],
    };
  },
);

server.tool(
  'delete_custom_agent',
  'Delete a custom agent and optionally clean up its memory.',
  {
    agent_id: z.string().describe('The agent ID to delete'),
    cleanup_memory: z.boolean().default(true).describe('Also delete the agent\'s memory files'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can delete custom agents.' }],
        isError: true,
      };
    }

    const data = {
      type: 'delete_custom_agent',
      agentId: args.agent_id,
      cleanupMemory: args.cleanup_memory,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Custom agent ${args.agent_id} deletion requested.` }],
    };
  },
);

// ── Workflow Tools ────────────────────────────────────────────────────

server.tool(
  'list_workflows',
  'List all available workflow definitions. Shows workflow ID, name, description, step count, and schedule.',
  {},
  async () => {
    const workflowsFile = path.join(IPC_DIR, 'current_workflows.json');

    try {
      if (!fs.existsSync(workflowsFile)) {
        return { content: [{ type: 'text' as const, text: 'No workflows found.' }] };
      }

      const workflows = JSON.parse(fs.readFileSync(workflowsFile, 'utf-8'));

      if (workflows.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No workflows found.' }] };
      }

      const formatted = workflows
        .map(
          (w: { id: string; name: string; description: string; version: string; stepCount: number; schedule?: { cron: string } }) =>
            `- [${w.id}] ${w.name} (v${w.version}) — ${w.description}\n  Steps: ${w.stepCount}${w.schedule ? `, Schedule: ${w.schedule.cron}` : ''}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Available workflows:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading workflows: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'workflow_status',
  'Get the status of recent workflow runs. Optionally filter by workflow ID or specific run ID.',
  {
    workflow_id: z.string().optional().describe('Filter runs by workflow ID'),
    run_id: z.string().optional().describe('Get status of a specific run'),
  },
  async (args) => {
    const runsFile = path.join(IPC_DIR, 'workflow_runs.json');

    try {
      if (!fs.existsSync(runsFile)) {
        return { content: [{ type: 'text' as const, text: 'No workflow run data available.' }] };
      }

      let runs = JSON.parse(fs.readFileSync(runsFile, 'utf-8')) as Array<{
        runId: string; workflowId: string; status: string;
        startedAt: string; completedAt: string | null;
        error: string | null; totalCostUsd: number;
      }>;

      if (args.run_id) {
        runs = runs.filter(r => r.runId === args.run_id);
      } else if (args.workflow_id) {
        runs = runs.filter(r => r.workflowId === args.workflow_id);
      }

      if (runs.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No matching workflow runs found.' }] };
      }

      const formatted = runs
        .map(r => {
          let line = `- [${r.runId.slice(0, 8)}...] ${r.workflowId} — ${r.status}`;
          line += `\n  Started: ${r.startedAt}`;
          if (r.completedAt) line += `, Completed: ${r.completedAt}`;
          if (r.totalCostUsd > 0) line += `, Cost: $${r.totalCostUsd.toFixed(4)}`;
          if (r.error) line += `\n  Error: ${r.error.slice(0, 200)}`;
          return line;
        })
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Workflow runs:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading workflow runs: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'run_workflow',
  'Start a workflow execution. The workflow runs on the host and results are reported back. Main group only.',
  {
    workflow_id: z.string().describe('The workflow ID to run (from list_workflows)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can run workflows.' }],
        isError: true,
      };
    }

    const data = {
      type: 'run_workflow',
      workflowId: args.workflow_id,
      chatJid,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Workflow "${args.workflow_id}" run requested. You'll be notified when it completes.` }],
    };
  },
);

server.tool(
  'pause_workflow',
  'Pause a running workflow. It can be resumed later. Main group only.',
  {
    run_id: z.string().describe('The run ID to pause (from workflow_status)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can pause workflows.' }],
        isError: true,
      };
    }

    const data = {
      type: 'pause_workflow',
      runId: args.run_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Workflow run ${args.run_id} pause requested.` }] };
  },
);

server.tool(
  'cancel_workflow',
  'Cancel a running or paused workflow. Main group only.',
  {
    run_id: z.string().describe('The run ID to cancel (from workflow_status)'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can cancel workflows.' }],
        isError: true,
      };
    }

    const data = {
      type: 'cancel_workflow',
      runId: args.run_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Workflow run ${args.run_id} cancellation requested.` }] };
  },
);

server.tool(
  'delegate_to_worker',
  'Delegate a sub-task to a specialized worker agent. The worker runs independently and returns a result. Check available_workers.json for available worker IDs.',
  {
    worker_id: z.string().describe('Worker agent ID from available_workers.json'),
    prompt: z.string().describe('Task description for the worker'),
    context: z.string().optional().describe('Additional context from the conversation'),
  },
  async (args) => {
    const delegationId = `del-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Write delegation request to IPC tasks directory
    writeIpcFile(TASKS_DIR, {
      type: 'delegate_worker',
      delegationId,
      workerId: args.worker_id,
      prompt: args.prompt,
      context: args.context,
      groupFolder,
      timestamp: new Date().toISOString(),
    });

    // Poll for result (synchronous — blocks until worker completes)
    const resultDir = path.join(IPC_DIR, 'worker-results');
    const resultFile = path.join(resultDir, `${delegationId}.json`);
    const TIMEOUT_MS = 300_000; // 5 minutes
    const POLL_MS = 500;
    const start = Date.now();

    while (Date.now() - start < TIMEOUT_MS) {
      if (fs.existsSync(resultFile)) {
        const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
        try { fs.unlinkSync(resultFile); } catch { /* best-effort cleanup */ }
        if (result.status === 'error') {
          return { content: [{ type: 'text' as const, text: `Worker error: ${result.error}` }], isError: true };
        }
        return { content: [{ type: 'text' as const, text: result.result }] };
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }

    return { content: [{ type: 'text' as const, text: 'Worker delegation timed out after 5 minutes' }], isError: true };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
