# Custom Agents Guide

Create agents that run on any LLM provider (OpenAI, Grok, Gemini, Anthropic) with their own tools, memory, and trigger patterns. Each custom agent runs in its own container alongside the existing Claude-based agents.

## Table of Contents

- [Quick Start](#quick-start)
- [Concepts](#concepts)
- [Creating an Agent](#creating-an-agent)
- [Invoking Agents](#invoking-agents)
- [Direct Trigger Routing](#direct-trigger-routing)
- [Setting Up API Keys](#setting-up-api-keys)
- [Provider Reference](#provider-reference)
- [Tool Reference](#tool-reference)
- [MCP Integration](#mcp-integration)
- [Agent-to-Agent Communication](#agent-to-agent-communication)
- [Memory System](#memory-system)
- [Managing Agents](#managing-agents)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

---

## Quick Start

From your main chat, tell Claude:

```
@Andy create a Grok agent called "Grok Researcher" that uses XAI's grok-3 model.
Give it access to web_fetch and the send_message MCP tool.
Set the trigger pattern to "@grok" so I can talk to it directly.
```

Claude will call the `create_custom_agent` MCP tool. Once created, you can:

```
# Direct trigger (routes directly to Grok, bypasses Claude)
@grok what are the latest developments in quantum computing?

# Delegation (Claude invokes Grok on your behalf)
@Andy ask the Grok researcher to summarize today's AI news
```

---

## Concepts

### How Custom Agents Work

Custom agents run the same container infrastructure as the main Claude agent but replace the Claude Agent SDK with a lightweight **ReAct loop** powered by any LLM provider:

```
1. System prompt (+ memory context) + user message
2. Call LLM API with registered tools
3. If LLM returns tool calls -> execute tools, append results, go to 2
4. If LLM returns text -> done, return response
5. Guard rails: max 25 iterations, token budget, wall-clock timeout
```

### Two Ways to Invoke

1. **Direct trigger** - User message matches the agent's `trigger_pattern` regex. The message routes directly to the custom agent container, skipping Claude entirely. Fast and cheap.

2. **Delegation** - Claude (inside its own container) calls the `invoke_custom_agent` MCP tool. The host spawns a separate container for the custom agent. The result is sent to the chat. Useful for orchestration where Claude decides when to delegate.

### What's Shared, What's Isolated

| Aspect | Shared | Isolated |
|--------|--------|----------|
| Chat JID | Yes - same group chat | - |
| IPC directory | Yes - same group's IPC namespace | - |
| MCP tools | Yes - same tools (send_message, schedule_task, etc.) | - |
| Container | - | Each agent gets its own container |
| LLM provider | - | Each agent talks to its own API |
| Memory | - | Each agent has its own rolling summary |
| Session | - | Custom agents don't use Claude sessions |

---

## Creating an Agent

### Via Claude (Recommended)

Tell Claude what you want in natural language:

```
@Andy create a custom agent with these settings:
- Name: "News Digest"
- Provider: google
- Model: gemini-2.0-flash
- API key env var: GOOGLE_API_KEY
- System prompt: "You are a news digest agent. Summarize news articles concisely."
- Tools: web_fetch, mcp:* (so it can send_message)
- Trigger: @news
```

### Via MCP Tool Directly

The `create_custom_agent` tool accepts these parameters:

| Parameter | Required | Description |
|-----------|----------|-------------|
| `name` | Yes | Display name (e.g., "Grok Researcher") |
| `description` | No | What this agent does |
| `provider` | Yes | `openai`, `xai`, `anthropic`, or `google` |
| `model` | Yes | Model ID (e.g., `grok-3`, `gpt-4o`, `gemini-2.0-flash`) |
| `api_key_env_var` | Yes | Environment variable name for the API key |
| `base_url` | No | Custom API base URL (required for XAI) |
| `system_prompt` | Yes | The agent's system prompt |
| `tools` | No | Array of tool names (default: all tools) |
| `trigger_pattern` | No | Regex for direct message routing |
| `max_iterations` | No | Max ReAct loop iterations (default: 25) |
| `timeout_ms` | No | Execution timeout in ms (default: 120000) |

### System Prompt Tips

The system prompt is the most important part. Write it like you'd write a `CLAUDE.md`:

```
You are a research assistant powered by Grok. Your job is to:
1. Search the web for current information
2. Synthesize findings into clear, concise summaries
3. Cite sources when possible

When the user asks you to research a topic:
- Use web_fetch to gather information from multiple sources
- Cross-reference claims across sources
- Present findings in a structured format

When done, use send_message to deliver results to the user.
Always include source URLs in your response.
```

**Inject context via tags.** The agent's rolling memory is automatically injected in `<previous_context>` tags before your system prompt is sent. You don't need to handle this manually.

---

## Invoking Agents

### Direct Trigger

If the agent has a `trigger_pattern`, matching messages go directly to it:

```
# Agent with trigger_pattern: "^@grok\\b"
@grok what happened in tech today?

# Agent with trigger_pattern: "^@news\\b"
@news summarize the top 5 stories
```

Trigger patterns are **regex** (case-insensitive). The `^@grok\b` pattern matches messages starting with "@grok" followed by a word boundary.

Custom agent triggers are checked **before** the normal `@Andy` trigger. If a message matches a custom agent trigger, it goes to that agent and Claude never sees it.

### Delegation via Claude

From any chat where Claude is active:

```
@Andy use the Grok researcher to find out about the new EU AI regulations
@Andy invoke agent-1234567890-abc123 with prompt "summarize today's news"
```

Claude uses the `invoke_custom_agent` MCP tool, which creates an IPC file. The host picks it up, spawns a container for the custom agent, and the agent's response is sent to the chat.

### Programmatic (via IPC)

Write a JSON file to the group's IPC tasks directory:

```json
{
  "type": "invoke_custom_agent",
  "agentId": "agent-1234567890-abc123",
  "prompt": "Summarize today's news",
  "chatJid": "120363336345536173@g.us",
  "groupFolder": "main",
  "isMain": true,
  "timestamp": "2026-02-27T10:00:00Z"
}
```

---

## Direct Trigger Routing

### How It Works

In the main message processing loop (`src/index.ts` `processGroupMessages()`), custom agent triggers are checked **before** the normal trigger pattern:

```
Message arrives
  |
  +-- Custom agent trigger match?
  |   YES -> Invoke custom agent, consume message
  |
  +-- Normal trigger match? (@Andy)
  |   YES -> Send to Claude container
  |
  +-- No trigger -> Message accumulates in DB
```

### Pattern Syntax

Trigger patterns use JavaScript regex syntax (case-insensitive):

| Pattern | Matches | Example |
|---------|---------|---------|
| `^@grok\b` | Messages starting with "@grok" | "@grok what's new?" |
| `^!research\b` | Messages starting with "!research" | "!research quantum computing" |
| `^hey gemini` | Messages starting with "hey gemini" | "hey gemini tell me a joke" |
| `\bgrok\b` | Messages containing "grok" anywhere | "can you ask grok about this?" |

**Tip:** Use `^` anchors to avoid false matches. `^@grok\b` is much safer than `grok`.

### Multiple Agents, Same Group

You can have multiple custom agents with different triggers in the same group:

```
@grok research quantum computing          -> Grok agent
@gemini analyze this code                  -> Gemini agent
@Andy schedule a task for tomorrow         -> Claude (default)
```

If a message matches multiple custom agent triggers, the first match (by database order) wins.

---

## Setting Up API Keys

Custom agents read API keys from the `.env` file in the project root. The key is passed securely to the container via stdin (never written to disk or mounted as a file).

### Step 1: Add the Key to `.env`

```bash
# In cambot-agent/.env
ANTHROPIC_API_KEY=sk-ant-...        # Already there for Claude
OPENAI_API_KEY=sk-proj-...          # For OpenAI agents
XAI_API_KEY=xai-...                 # For Grok agents
GOOGLE_API_KEY=AIza...              # For Gemini agents
```

### Step 2: Reference It When Creating the Agent

The `api_key_env_var` parameter tells the system which env var to look up:

```
# For a Grok agent:
api_key_env_var: "XAI_API_KEY"

# For an OpenAI agent:
api_key_env_var: "OPENAI_API_KEY"

# For a Gemini agent:
api_key_env_var: "GOOGLE_API_KEY"
```

### Security Model

- Keys are read from `.env` at container spawn time by `readSecrets()`
- Passed to the container via stdin JSON (the `secrets` field of `ContainerInput`)
- The container deletes the temp input file immediately after reading
- Keys are never in `process.env` — they're only in the SDK env object
- The Bash sanitization hook strips secret env vars from all shell commands

---

## Provider Reference

### OpenAI

```
provider: "openai"
model: "gpt-4o" | "gpt-4o-mini" | "gpt-4-turbo" | "o1" | "o3-mini"
api_key_env_var: "OPENAI_API_KEY"
```

### XAI / Grok

```
provider: "xai"
model: "grok-3" | "grok-3-mini" | "grok-2"
api_key_env_var: "XAI_API_KEY"
base_url: "https://api.x.ai/v1"     # REQUIRED for XAI
```

XAI uses the OpenAI-compatible API, so it uses the same `OpenAIProvider` adapter internally. The `base_url` is what routes requests to XAI instead of OpenAI.

### Anthropic (Direct)

```
provider: "anthropic"
model: "claude-sonnet-4-6" | "claude-haiku-4-5-20251001" | "claude-opus-4-6"
api_key_env_var: "ANTHROPIC_API_KEY"
```

This uses the Anthropic Messages API directly (not the Claude Agent SDK). Useful when you want a lightweight Anthropic agent without the full SDK overhead.

### Google Gemini

```
provider: "google"
model: "gemini-2.0-flash" | "gemini-2.0-pro" | "gemini-1.5-pro" | "gemini-1.5-flash"
api_key_env_var: "GOOGLE_API_KEY"
```

---

## Tool Reference

Tools give agents the ability to act. Specify them as an array of strings when creating an agent.

### Builtin Tools

| Tool | Description |
|------|-------------|
| `bash` | Execute shell commands (30s timeout, scoped to /workspace/group) |
| `file_read` | Read file contents (scoped to /workspace, 100KB limit) |
| `file_write` | Write files (scoped to /workspace, creates parent dirs) |
| `file_list` | List directory contents (optional recursive) |
| `web_fetch` | HTTP GET with 50KB response truncation |

### MCP Tools

MCP tools are accessed through the MCP bridge, which connects to the same `ipc-mcp-stdio.ts` server that Claude uses. This gives custom agents access to **all CamBot MCP tools**.

| Tool | Description |
|------|-------------|
| `mcp:send_message` | Send a message to the chat immediately |
| `mcp:schedule_task` | Schedule a recurring or one-time task |
| `mcp:list_tasks` | List scheduled tasks |
| `mcp:list_custom_agents` | List other custom agents |
| `mcp:invoke_custom_agent` | Invoke another custom agent |
| `mcp:register_group` | Register a new chat group (main only) |
| `mcp:run_workflow` | Start a workflow (main only) |
| ... | All other MCP tools from ipc-mcp-stdio.ts |

### Tool Selection Patterns

Use `mcp:*` to enable all MCP tools, or select specific ones:

```json
// All tools (full autonomy)
["bash", "file_read", "file_write", "file_list", "web_fetch", "mcp:*"]

// Research agent (read-only + messaging)
["web_fetch", "file_read", "mcp:send_message"]

// Code agent (full file access + bash)
["bash", "file_read", "file_write", "file_list"]

// Minimal (just messaging)
["mcp:send_message"]
```

---

## MCP Integration

### How the MCP Bridge Works

Custom agents connect to the same MCP server (`ipc-mcp-stdio.ts`) that Claude uses, but as a **client** instead of having it as a subprocess:

```
Custom Agent Container
  |
  +-- AgentExecutor (ReAct loop)
  |     |
  |     +-- McpBridge (MCP Client)
  |           |
  |           +-- StdioClientTransport
  |                 |
  |                 +-- node ipc-mcp-stdio.js (MCP Server subprocess)
  |                       |
  |                       +-- Writes IPC files to /workspace/ipc/
  |                             |
  |                             +-- Host picks up IPC files
```

The bridge:
1. Spawns `ipc-mcp-stdio.js` as a subprocess
2. Connects via stdio transport
3. Discovers available tools via `listTools()`
4. Registers them in the ToolRegistry with the `mcp:` prefix
5. Routes tool calls through `callTool()`

### Using send_message

The most common MCP tool. Custom agents use it to send messages during execution:

```
# In the agent's system prompt:
"When you find results, use send_message to deliver them immediately.
Don't wait until the end of your execution."
```

The agent's ReAct loop calls `mcp:send_message` -> McpBridge routes to `ipc-mcp-stdio.js` -> writes IPC file -> host sends message to chat.

### Using schedule_task

Custom agents can schedule follow-up tasks:

```
# Agent schedules a reminder
mcp:schedule_task({
  prompt: "Check if the news story from yesterday had any updates",
  schedule_type: "once",
  schedule_value: "+24h",
  context_mode: "isolated"
})
```

---

## Agent-to-Agent Communication

There are three patterns for agents to communicate with each other.

### Pattern 1: Delegation Chain (Sequential)

Claude invokes Agent A, which invokes Agent B. Each runs in its own container, sequentially.

```
User -> Claude: "Research X and then summarize with Gemini"
  Claude calls invoke_custom_agent(grok, "research X")
    -> Grok container runs, sends result via send_message
  Claude calls invoke_custom_agent(gemini, "summarize: {grok's output}")
    -> Gemini container runs, sends result via send_message
```

To set this up, just tell Claude what you want:
```
@Andy Research quantum computing using the Grok researcher, then pass
the results to the Gemini agent for a concise summary.
```

Claude orchestrates the delegation because it has access to `invoke_custom_agent`.

### Pattern 2: Agent Invoking Agent (Direct)

A custom agent can invoke another custom agent via the `mcp:invoke_custom_agent` MCP tool. This works because the MCP bridge gives agents access to the same tools Claude has.

```
# In Agent A's system prompt:
"After completing your research, invoke the 'summarizer' agent
(agent ID: agent-xxx) using invoke_custom_agent to create a
polished summary of your findings."
```

Agent A's container calls `mcp:invoke_custom_agent` -> IPC file -> host spawns Agent B's container -> Agent B runs and sends results via `mcp:send_message`.

**Note:** This is asynchronous. Agent A doesn't get Agent B's response back directly. Agent B sends its output to the chat via `send_message`. If you need the response fed back into Agent A, use Pattern 1 (delegation via Claude) instead.

### Pattern 3: Shared Workspace (File-Based)

Multiple agents in the same group share the `/workspace/group/` directory. They can communicate through files:

```
# Agent A writes findings to a file
file_write({ path: "group/research-output.md", content: "..." })

# Agent B reads the file (invoked later)
file_read({ path: "group/research-output.md" })
```

This works well for multi-step workflows where agents run sequentially (via scheduled tasks or delegation) and need to pass large amounts of data.

### Pattern 4: Scheduled Collaboration

Agents can schedule tasks that invoke other agents:

```
# Agent A schedules Agent B to run in 5 minutes
mcp:schedule_task({
  prompt: "Read /workspace/group/research-output.md and send a summary to the user",
  schedule_type: "once",
  schedule_value: "+5m",
  context_mode: "isolated"
})
```

### Which Pattern to Use

| Pattern | When to Use | Latency | Complexity |
|---------|-------------|---------|------------|
| Delegation chain | Claude orchestrates multi-agent work | Medium | Low (Claude handles it) |
| Agent invoking agent | Agent A needs to trigger Agent B | Low | Medium |
| Shared workspace | Large data transfer between agents | Varies | Low |
| Scheduled collaboration | Timed multi-step workflows | High | Medium |

---

## Memory System

Each custom agent has persistent memory via rolling summaries.

### How It Works

1. After each execution, the agent's own LLM provider generates a summary of the conversation
2. The summary is merged with any previous summary (rolling)
3. Stored at `/workspace/group/agents/{agentId}/memory.json`
4. On next invocation, the summary is injected into the system prompt in `<previous_context>` tags

### Memory Format

```json
{
  "agentId": "agent-1234567890-abc123",
  "summary": "The user asked about quantum computing developments...",
  "lastUpdated": "2026-02-27T15:30:00Z",
  "conversationCount": 5
}
```

### Memory is Per-Agent, Per-Group

Memory files live inside the group folder (`/workspace/group/agents/{agentId}/memory.json`), so each agent in each group has isolated memory. An agent in the "main" group has different memory than the same agent definition used in "family-chat".

### Clearing Memory

Delete the agent (with `cleanup_memory: true`) and recreate it, or manually delete the memory file:

```
@Andy delete custom agent agent-xxx and clean up its memory, then recreate it with the same settings
```

---

## Managing Agents

### List Agents

```
@Andy list all custom agents
```

Or the agent can call `list_custom_agents` directly.

### Update an Agent

```
@Andy update the Grok researcher agent:
- Change the model to grok-3-mini
- Add file_write to its tools
- Update the system prompt to include citation requirements
```

### Delete an Agent

```
@Andy delete the "News Digest" custom agent and clean up its memory
```

---

## Examples

### Grok Research Agent

```
@Andy create a custom agent:
- Name: Grok Researcher
- Provider: xai
- Model: grok-3
- API key: XAI_API_KEY
- Base URL: https://api.x.ai/v1
- Trigger: @grok
- Tools: web_fetch, file_read, file_write, mcp:send_message
- System prompt: |
    You are a research assistant powered by Grok.
    When asked to research a topic:
    1. Use web_fetch to gather information from multiple sources
    2. Synthesize findings into a clear summary
    3. Use send_message to deliver results
    Always cite your sources with URLs.
```

### Gemini Code Reviewer

```
@Andy create a custom agent:
- Name: Gemini Code Reviewer
- Provider: google
- Model: gemini-2.0-flash
- API key: GOOGLE_API_KEY
- Trigger: @review
- Tools: bash, file_read, file_list, mcp:send_message
- System prompt: |
    You are a code review assistant powered by Gemini.
    When asked to review code:
    1. Use file_list and file_read to examine the codebase
    2. Run tests with bash if available
    3. Identify bugs, security issues, and style problems
    4. Send a structured review via send_message
```

### OpenAI Summarizer

```
@Andy create a custom agent:
- Name: Quick Summarizer
- Provider: openai
- Model: gpt-4o-mini
- API key: OPENAI_API_KEY
- Tools: web_fetch, mcp:send_message
- Max iterations: 5
- System prompt: |
    You are a fast summarizer. Given a URL or text,
    produce a 3-bullet summary. Be concise.
```

### Multi-Agent Research Pipeline

Set up two agents that work together:

```
# Step 1: Create the researcher
@Andy create a Grok agent called "Deep Researcher" with trigger @research
that does thorough web research and writes findings to research-output.md

# Step 2: Create the summarizer
@Andy create a Gemini agent called "Report Writer" with trigger @report
that reads research-output.md and produces a polished report

# Step 3: Use them together
@Andy research the latest AI safety developments using Deep Researcher,
then have Report Writer create a summary report
```

---

## Troubleshooting

### Agent doesn't respond

1. Check the API key is in `.env` and the `api_key_env_var` matches
2. Check container logs in `groups/{folder}/logs/`
3. Verify the trigger pattern matches your message (test with a regex tester)
4. Try invoking via Claude delegation to see if the issue is trigger-specific

### "Missing API key" error

The `api_key_env_var` must match exactly what's in `.env`:
```
# .env
XAI_API_KEY=xai-abc123

# Agent config
api_key_env_var: "XAI_API_KEY"   # Must match exactly
```

### Agent times out

Increase `timeout_ms` (default: 120000 = 2 minutes):
```
@Andy update agent-xxx: set timeout to 300000
```

### Agent loops too many times

Decrease `max_iterations` or improve the system prompt to be more directive:
```
@Andy update agent-xxx: set max_iterations to 10
```

### MCP tools not working

Ensure `mcp:*` or specific MCP tool names are in the agent's `tools` array. The MCP bridge connects to `ipc-mcp-stdio.js` which must be present in the container.

### Rebuild container after changes

If you modify `cambot-agents/` source code, rebuild the container:

```bash
./container/build.sh
```

The build script copies `cambot-agents/` into the Docker build context automatically.
