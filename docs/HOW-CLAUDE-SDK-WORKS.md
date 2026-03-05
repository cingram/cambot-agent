# How CamBot Uses the Claude Agent SDK

A step-by-step walkthrough of how CamBot integrates with Claude, from message arrival to response delivery.

---

## The Big Picture: Two Worlds

CamBot has a split architecture:

- **The Host Process** (Node.js at `src/orchestrator/app.ts`) is the front of house — it talks to customers (WhatsApp, email, web), takes orders, and delivers responses. It has **zero** Claude SDK code.
- **The Docker Container** (code at `agent-runner/src/index.ts`) is the kitchen — it's where Claude actually thinks and works. The Claude Agent SDK lives here and only here.

They communicate through two channels: **stdin/stdout** (for the initial prompt and results) and **filesystem IPC** (for ongoing back-and-forth while the container is alive).

---

## The One Function That Matters: `query()`

The entire Claude integration is a single import in `agent-runner/src/index.ts`:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
```

`query()` is an **async generator**. You give it a prompt and options, and it yields structured messages back as Claude thinks, uses tools, and generates responses:

```typescript
for await (const message of query({
  prompt: stream,              // what the user said (AsyncIterable)
  options: {
    cwd: '/workspace/group',   // Claude's working directory (sandboxed)
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',   // use Claude Code's built-in persona
      append: cambotContext     // + CamBot's custom identity/memory
    },
    allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', ...],
    permissionMode: 'bypassPermissions',  // no confirmation prompts
    mcpServers: { ... },       // external tool servers
    hooks: { ... },            // intercept tool calls
    resume: sessionId,         // continue previous conversation
  }
})) {
  // handle each message Claude produces
}
```

**Key insight:** `query()` doesn't just send one request and get one response. It's a full agentic loop. Claude can decide to read files, run bash commands, search the web, call MCP tools — all autonomously within that single `for await` loop.

---

## How `query()` Enables Tools (Bash, Browser, etc.)

### CamBot does NOT implement tools

CamBot's code doesn't write a single line that runs shell commands or opens browsers. All of that is built into **Claude Code** — the CLI tool that the SDK wraps.

```
@anthropic-ai/claude-code       ← The engine (contains Bash, Read, Write, WebSearch, etc.)
@anthropic-ai/claude-agent-sdk  ← The steering wheel (the query() function)
Your code (index.ts)             ← The driver
```

When you call `query()`, you're starting an entire Claude Code session programmatically. The SDK spins up the full Claude Code engine inside the container, complete with all its built-in tools.

### `allowedTools` is a filter, not a registration

```typescript
allowedTools: [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'Task', 'TaskOutput', 'TaskStop',
  'TeamCreate', 'TeamDelete', 'SendMessage',
  'mcp__cambot-agent__*',
  'mcp__workflow-builder__*',
],
```

These tools already exist inside Claude Code. This list says: "Out of all the tools Claude Code has, let the agent use these ones." Remove `'Bash'` and Claude would be blocked from running commands.

### What happens when Claude runs a Bash command

```
1. Claude receives the prompt ("install numpy")

2. Claude's brain (the LLM) decides: "I should run a Bash command"
   -> Generates tool_use: { tool: "Bash", input: { command: "pip install numpy" } }

3. Claude Code's engine (NOT your code) intercepts this
   -> Checks: Is "Bash" in allowedTools? Yes.
   -> Checks: permissionMode is "bypassPermissions"? Yes, skip confirmation.
   -> Executes: spawns a child process, runs the command, captures output

4. The engine feeds the result back to Claude:
   "Tool result: Successfully installed numpy-1.26.4"

5. Claude decides what to do next (more tools, or respond)

6. Eventually produces a text response: "Done! numpy is installed."

7. That response arrives as message.type === "result" in the for-await loop
```

Steps 2-6 happen entirely inside `query()`. Your code only sees the messages yielded by the async generator.

### How the browser works

The Dockerfile installs Chromium and `agent-browser` (a CLI wrapper around Playwright). Browser automation is just a special case of the Bash tool — Claude runs commands like `agent-browser navigate "https://example.com"`.

### Permission bypass and security

```typescript
permissionMode: 'bypassPermissions',
allowDangerouslySkipPermissions: true,
```

Normally Claude Code asks "Is it okay if I run this?" before executing. These flags disable that — the agent runs autonomously. This is safe because it's sandboxed in Docker.

The one guard is the `SanitizeBashHook`, which prepends `unset ANTHROPIC_API_KEY` to every Bash command so subprocesses can't leak the key.

---

## Message Flow: End to End

### Step 1: Message arrives

WhatsApp/Email/etc emits to the message bus:

```
channel.onMessage -> messageBus.emit('message.inbound', { jid, message })
```

### Step 2: Stored in SQLite

```typescript
// src/orchestrator/bus-handlers.ts
bus.on('message.inbound', (event) => {
  storeMessage(message);  // SQLite insert
}, { priority: 100 });
```

The database is the source of truth for all messages.

### Step 3: Poll loop checks the database

```typescript
// src/orchestrator/message-loop.ts
while (true) {
  const { messages, newTimestamp } = getNewMessages(jids, lastTimestamp, ASSISTANT_NAME);
  // ... process messages ...
  await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
}
```

This is NOT event-driven. It polls every `POLL_INTERVAL` milliseconds asking: "Any new messages since the last one I saw?"

### Step 4: Trigger check

```typescript
// Does the message match TRIGGER_PATTERN (e.g. "@Bot")?
const hasTrigger = groupMessages.some(m => TRIGGER_PATTERN.test(m.content.trim()));
```

- **Main group**: always triggers, no pattern needed
- **Other groups**: only if someone said "@Bot" (or whatever the trigger is)
- No trigger? Message stays in DB as context for when a trigger eventually arrives.

### Step 5: Format and send to container

Two paths depending on whether a container is already running:

#### Path A: No container running (first message)

```
formatMessages(missedMessages)      -> "Cameron (12:03pm): hey @Bot what's up"
interceptor.redactPrompt(prompt)    -> replaces PII
processGroupMessages()              -> calls runAgent()
runAgent()                          -> calls runContainerAgent()
                                    -> spawns Docker container
                                    -> writes prompt JSON to stdin
```

#### Path B: Container already running (follow-up message)

```
formatMessages(messagesToSend)      -> "Cameron (12:05pm): also check the weather"
queue.sendMessage(chatJid, text)    -> writes JSON to /workspace/ipc/input/
                                    -> container picks it up on 500ms poll
                                    -> feeds into active query() stream
```

Follow-up messages never spawn a new container. They get piped into the running one via filesystem IPC.

### Step 6: Context assembly inside the container

The agent is essentially a Claude Code session, just like using Claude Code from a terminal. It sees:

```
Claude Code automatically loads:
+-- Built-in system prompt (claude_code preset)
+-- /workspace/group/CLAUDE.md             (group-specific instructions)
+-- Appended cambot-context block:
    +-- Global CLAUDE.md (identity/persona)
    +-- Memory instructions (DB schema or markdown)
    +-- Dynamic context files:
        +-- TOOLS.md (available MCP tools)
        +-- AGENTS.md (available sub-agents)
        +-- HEARTBEAT.md (current time, tasks)
```

Built by `context-assembler.ts` and passed as `systemPrompt.append` to `query()`.

### Step 7: Response flows back

```
Container: Claude produces result
  -> writeOutput() wraps in sentinel markers on stdout
  -> Host parses stdout, extracts JSON
  -> formatOutbound(result)
  -> interceptor.restoreOutput() (un-redact PII)
  -> messageBus.emit('message.outbound', { jid, text })
  -> WhatsApp/Email channel sends it
```

---

## Sessions: The Container Stays Alive

The container doesn't die after one message. After `query()` finishes:

```typescript
while (true) {
  const nextMessage = await waitForIpcMessage();  // polls /workspace/ipc/input/
  if (nextMessage === null) break;                // _close sentinel = shut down
  prompt = nextMessage;
  await runQuery(prompt, sessionId, ...);         // resume same Claude session
}
```

The host has an idle timer. If no messages come for `IDLE_TIMEOUT`, it writes a `_close` file, and the container shuts down. Next message spawns a fresh container.

Session continuity is maintained by the `resume: sessionId` option — Claude Code persists its conversation to disk, and the next `query()` call picks up where it left off.

---

## Agent Teams

CamBot supports Claude Code's Agent Teams feature:

**Feature flag** (in `src/container/runner.ts`):
```typescript
CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
```

**Tools allowed** (in `agent-runner/src/index.ts`):
```typescript
'TeamCreate', 'TeamDelete', 'SendMessage',
```

- **TeamCreate** — spawn a sub-agent (separate Claude Code session)
- **SendMessage** — agents communicate with each other
- **TeamDelete** — shut down a sub-agent

The `MessageStream` class (async iterable prompt) exists specifically for this — it keeps the session alive while sub-agents work in the background, preventing the SDK from treating it as a single-turn interaction.

---

## Tools and MCP

Claude gets two categories of tools:

### Built-in Claude Code tools (via `allowedTools`)

| Tool | Purpose |
|------|---------|
| Bash | Run shell commands |
| Read, Write, Edit | File operations |
| Glob, Grep | File/content search |
| WebSearch, WebFetch | Internet access |
| Task, TaskOutput, TaskStop | Background tasks |
| TeamCreate, TeamDelete, SendMessage | Agent Teams |

### MCP servers (external tool servers)

| Server | Purpose |
|--------|---------|
| `cambot-agent` | `send_message`, `schedule_task`, `register_group` (how Claude talks back to users) |
| `workflow-builder` | Create/edit automated workflows |
| `workspace-mcp` | Google Workspace (Gmail, Calendar, Drive) — HTTP on host |
| User integrations | Any configured HTTP/SSE MCP servers |

When Claude calls `send_message` via MCP:
1. SDK routes it to the MCP server running in-container (`ipc-mcp-stdio.ts`)
2. MCP server writes a JSON file to `/workspace/ipc/messages/`
3. Host's IPC watcher picks it up
4. Host emits `message.outbound` on the message bus
5. Channel sends it to the user

---

## Hooks: Intercepting Tool Calls

```typescript
hooks: {
  PreCompact:        [createPreCompactHook()],        // archive transcript before compression
  PreToolUse:        [createSanitizeBashHook()],      // strip API keys from Bash env
                     [createPreToolUseTimingHook()],   // record start time
  PostToolUse:       [createPostToolUseHook()],        // record telemetry
  PostToolUseFailure:[createPostToolUseFailureHook()], // record errors
}
```

---

## How the Code Gets Into the Container

The agent runner lives on your PC at `agent-runner/src/index.ts` and enters the container two ways:

### 1. Baked into the Docker image at build time

```dockerfile
COPY cambot-agent-runner/src/ ./src/
RUN npm run build    # compiles to /app/dist/
```

### 2. Hot-mounted at runtime (overrides baked version)

Every container spawn, `container-runner.ts` copies your local source to a per-group directory and mounts it:

```typescript
fs.cpSync(agentRunnerSrc, groupAgentRunnerDir, { recursive: true });
mounts.push({ hostPath: groupAgentRunnerDir, containerPath: '/app/src', readonly: false });
```

Then `entrypoint.sh` checks if source changed — if yes, recompiles on the fly. This means you can edit `index.ts` and the next container spawn picks up your changes without rebuilding the image.

---

## Custom Agents: The Non-Claude Path

When a `customAgent` field is present in the container input:

```typescript
if (containerInput.customAgent) {
  const { runCustomAgent } = await import('./custom-agent-runner.js');
  await runCustomAgent(containerInput, writeOutput, log);
  return;
}
```

Custom agents use `cambot-llm` (a multi-provider LLM runtime) with `ProviderRegistry` supporting OpenAI, xAI, Google, and Anthropic APIs directly. They share the same container, IPC, and output format — the host doesn't know or care which path ran.

---

## Architecture Diagram

```
+------------------ HOST (Node.js) -------------------+
|                                                      |
|  WhatsApp ----> MessageBus ----> container-runner.ts |
|  Email   ---->      |                   |            |
|  Web UI  ---->      |             spawn Docker       |
|                     |                   |            |
|              IPC Watcher <--- filesystem IPC --+     |
|                     |                          |     |
|              MessageBus ----> Channel.send()   |     |
|                                                |     |
+------------------------------------------------|-----+
                                                 |
+------------ CONTAINER (Docker) ----------------+-----+
|                                                |     |
|  stdin JSON -> agent-runner/index.ts           |     |
|                     |                          |     |
|              +------+------+                   |     |
|              |             |                   |     |
|         query()     custom-agent-runner        |     |
|     (Claude SDK)    (OpenAI/xAI/etc)           |     |
|              |             |                   |     |
|              +------+------+                   |     |
|                     |                          |     |
|              MCP Servers --> ipc/messages/ -----+     |
|              stdout JSON -> sentinel markers         |
|                                                      |
+------------------------------------------------------+
```
