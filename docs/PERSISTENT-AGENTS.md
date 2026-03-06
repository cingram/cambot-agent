# Persistent Agents Architecture

> **Status**: Design
> **Replaces**: Database-driven polling loop for message routing

## Summary

Persistent agents are purpose-built, always-registered agents that the bus routes messages to based on channel ownership. Each agent declares what channels it handles, what MCP servers (tools) it can access, and runs in its own isolated workspace. Agent configuration lives in the database, making it runtime-configurable.

This replaces the current architecture where the database acts as both storage AND routing mechanism (poll loop checks DB for new messages, processor picks them up). After this refactor, the bus handles routing and the database goes back to just being a database.

---

## Before vs After

### Before (database-driven routing)

```
Channel → Store in DB → Poll loop checks DB → One monolithic processor → Spawns container
                                                    (all agents get all MCP servers)
```

- One `MessageLoop` polls for new messages across all groups
- One `GroupMessageProcessor` handles everything
- Every container gets every MCP server
- No way to scope tools per agent purpose
- Agent selection happens deep inside processing logic

### After (bus-driven routing)

```
Channel → Bus → Looks up agent for channel → Spawns scoped container → Store in DB
                                                  (only configured MCP servers)
```

- Bus maintains a routing table: channel name -> agent ID
- Each agent gets ONLY the MCP servers it's configured for
- Agent selection happens at route time, declaratively
- Database stores history, sessions, audit — not routing state

---

## Components

```
┌──────────────┐
│   Channels   │  WhatsApp, Email, Web, CLI, iMessage, ...
│  (inbound)   │
└──────┬───────┘
       │ InboundMessage event
       ▼
┌──────────────┐     ┌─────────────────────┐
│  Message Bus │────▶│  Persistent Agent    │  Priority 20 handler
│  (pub/sub)   │     │  Router              │  Looks up channel → agent mapping
└──────────────┘     └──────────┬───────────┘
       │                        │
       │                        ▼
       │              ┌─────────────────────┐
       │              │     Agent Bus       │  Circuit breaker, bulkhead,
       │              │   (resilience)      │  retry, DLQ, correlation
       │              └──────────┬──────────┘
       │                         │
       │                         ▼
       │              ┌─────────────────────┐
       │              │  Agent Spawner      │  Reads agent config from DB
       │              │                     │  Scopes MCP servers
       │              │                     │  Manages sessions
       │              └──────────┬──────────┘
       │                         │
       │                         ▼
       │              ┌─────────────────────┐
       │              │    Container        │  Runs with only the tools
       │              │  (isolated)         │  this agent is allowed
       │              └──────────┬──────────┘
       │                         │
       ▼                         ▼
┌──────────────┐     ┌─────────────────────┐
│   Database   │◄────│  Result / History   │  Messages stored for context
│  (storage)   │     │                     │  Sessions persisted
└──────────────┘     └─────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| **Channels** | Receive messages from external sources, emit `InboundMessage` events |
| **Message Bus** | Pub/sub event system. Handlers run by priority. |
| **Persistent Agent Router** | Message bus handler at priority 20. Maps channel → agent ID, delegates to Agent Bus |
| **Agent Bus** | Resilience layer. Circuit breakers, bulkheads, retry, DLQ. Calls the spawner. |
| **Agent Spawner** | Reads agent config from DB. Builds scoped `ContainerInput` (filtered MCP servers). Calls `runContainerAgent()`. |
| **Container** | Isolated execution environment. Only sees the MCP servers the spawner gave it. |
| **Database** | Stores messages (history), sessions, agent configs, audit logs. No longer drives routing. |

### Priority Ordering on Message Bus

| Priority | Handler | Purpose |
|----------|---------|---------|
| 10 | Shadow Admin | Intercepts admin commands, cancels event |
| 15 | Input Sanitizer | Cleans null bytes, encoding issues |
| 20 | **Persistent Agent Router** | Routes to correct agent via Agent Bus |
| 50 | Channel Delivery | Forwards outbound messages to channels |
| 100 | DB Store | Persists messages |
| 200 | Audit | Logs events |

The Persistent Agent Router at priority 20 runs AFTER shadow admin (so admin commands are still intercepted) and AFTER sanitization (so input is clean), but BEFORE DB storage. When the router handles a message, it cancels the event — the old poll-based flow never sees it. Messages that don't match any persistent agent fall through to the existing flow unchanged.

---

## Agent Configuration (Database)

### `registered_agents` Table

```sql
CREATE TABLE registered_agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  folder        TEXT NOT NULL UNIQUE,
  channels      TEXT NOT NULL DEFAULT '[]',    -- JSON array of channel names
  mcp_servers   TEXT NOT NULL DEFAULT '[]',    -- JSON array of MCP server names
  capabilities  TEXT NOT NULL DEFAULT '[]',    -- JSON array of capability tags
  concurrency   INTEGER NOT NULL DEFAULT 1,
  timeout_ms    INTEGER NOT NULL DEFAULT 300000,
  is_main       INTEGER NOT NULL DEFAULT 0,
  agent_def_id  TEXT,                          -- references agent_definitions.id
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
```

### Example Rows

| id | name | channels | mcp_servers | is_main |
|----|------|----------|-------------|---------|
| `email-agent` | Email Agent | `["email"]` | `["google-workspace"]` | 0 |
| `chat-agent` | Chat Agent | `["whatsapp","web","cli"]` | `[]` (all) | 1 |
| `imessage-agent` | iMessage Agent | `["imessage"]` | `["google-workspace"]` | 0 |

### Field Semantics

- **`channels`**: Which channel names this agent handles. The router builds a `Map<channelName, agentId>` from this. Each channel can only be claimed by one agent.
- **`mcp_servers`**: Which MCP server names to expose to this agent's container. Empty array = all available servers (backward compatible default). This is how you scope tools per agent.
- **`capabilities`**: Descriptive tags for the agent bus registry. Used by interceptors and observability, not routing.
- **`agent_def_id`**: References `agent_definitions` table (provider, model, secrets). If null, uses the lead agent.
- **`is_main`**: Elevated container permissions (project-level read access, etc).
- **`concurrency`**: Max simultaneous container executions for this agent. The agent bus enforces this via bulkheads.
- **`timeout_ms`**: Max time per execution before the agent bus times it out.

### Runtime Modification

Since config lives in the database, agents can be added/modified at runtime:

```sql
-- Add a new Telegram agent
INSERT INTO registered_agents (id, name, folder, channels, mcp_servers, concurrency, timeout_ms, created_at, updated_at)
VALUES ('telegram-agent', 'Telegram Agent', 'telegram', '["telegram"]', '["google-workspace"]', 1, 300000, datetime(), datetime());

-- Give the email agent access to Calendar too
UPDATE registered_agents
SET mcp_servers = '["google-workspace"]'
WHERE id = 'email-agent';
```

After modification, the bus reloads the routing table. No restart required.

---

## MCP Server Scoping

This is the key capability that makes persistent agents useful. Each agent only gets the tools it needs.

### How It Works

1. Integration manager maintains all active MCP servers (e.g., `google-workspace` exposes Gmail, Calendar, Tasks, Drive)
2. When the spawner builds a container for an agent, it reads that agent's `mcp_servers` config
3. It filters `getActiveMcpServers()` to only the configured names
4. The container only sees the filtered set

```
All MCP Servers: [google-workspace, slack, github]

Email Agent config:  mcp_servers = ["google-workspace"]
  → Container gets: [google-workspace]

Chat Agent config:   mcp_servers = []  (empty = all)
  → Container gets: [google-workspace, slack, github]
```

### Future: Per-Tool Scoping

Currently scoping is at the MCP server level. A future enhancement could scope at the individual tool level within a server (e.g., email agent gets Gmail tools but not Calendar tools from the same workspace server). This would require changes to the MCP config generation in `agent-runner/src/mcp-config.ts`.

---

## Agent Lifecycle

### Startup

1. `CamBotApp.start()` initializes database, channels, integrations (existing)
2. New: `initPersistentAgents()`:
   a. Load all rows from `registered_agents` table
   b. Bootstrap each agent's workspace folder and default CLAUDE.md
   c. Create `PersistentAgentSpawner` (implements `ContainerSpawner`)
   d. Create `PersistentAgentHandler` — registers on message bus at priority 20 with embedded circuit breaker, bulkhead, and retry
3. Message loop starts (existing, handles any channels not claimed by persistent agents)

### Message Flow

1. Channel receives message, emits `InboundMessage` on message bus
2. Shadow admin handler (p:10) checks — passes through if not admin command
3. Input sanitizer (p:15) cleans the message
4. **Persistent Agent Handler (p:20)**:
   a. Reads `event.channel` (e.g., `"email"`)
   b. Looks up routing table: `"email"` → `"email-agent"`
   c. If match found:
      - Cancel event (prevents old poll loop from also processing it)
      - Check circuit breaker and bulkhead for the target agent
      - Spawn container via `ContainerSpawner` with retry on failure
      - Result emitted as `OutboundMessage` on message bus
   d. If no match: event flows through to existing poll-based processing

### Shutdown

1. Persistent agent handler unsubscribes from message bus and clears cooldown timers
2. Existing shutdown continues (channels, integrations, interceptor)

---

## Session Management

Each persistent agent uses its `folder` as the session key, same as the shadow admin pattern:

- On spawn: read session ID from `auth_sessions` table via `getSession(folder)`
- On result: write new session ID via `setSession(folder, newSessionId)`
- Claude Code session directory mounted per-agent at `/home/node/.claude`

This gives each agent independent conversation memory.

---

## Workspace Bootstrap

Each persistent agent gets its own folder under `groups/`:

```
groups/
  email-agent/
    CLAUDE.md        ← agent-specific instructions
    logs/
  chat-agent/
    CLAUDE.md
    logs/
  shadow-admin/      ← already exists
    CLAUDE.md
    logs/
```

On first startup, if the folder doesn't exist, the bootstrap creates it with a default CLAUDE.md tailored to the agent's name and description. Existing folders are not overwritten.

---

## Relationship to Existing Systems

### What stays the same
- **Shadow admin**: Stays at priority 10, keeps its own auth gates. Not a registered persistent agent.
- **Custom agents**: Per-group trigger-matched agents stay as-is. They run within the existing poll flow.
- **Workflows**: Workflow service stays as-is. Workflow containers are not persistent agents.
- **Scheduled tasks**: Scheduler stays as-is. Tasks dispatch through the group queue.
- **IPC watcher**: Stays. Agents can still create tasks, send messages, etc. via IPC.

### What changes
- **Message routing**: Bus-driven instead of DB-poll-driven for channels claimed by persistent agents.
- **MCP server exposure**: Scoped per agent instead of all-or-nothing.
- **Agent registration**: New `registered_agents` table. Agents are first-class entities with explicit config.
- **GroupMessageProcessor**: Channels handled by persistent agents bypass this entirely. Unclaimed channels still use it.
- **MessageLoop**: Only polls for messages on channels not claimed by persistent agents.

### Migration path
- Existing setups with no `registered_agents` rows work exactly as before (no persistent agents registered = everything flows through old path)
- Adding a persistent agent for a channel gradually migrates that channel to bus-driven routing
- No flag day — channels can be migrated one at a time

---

## New Files

| File | Purpose |
|------|---------|
| `src/db/agent-repository.ts` | CRUD for `registered_agents` table |
| `src/agents/persistent-agent-spawner.ts` | `ContainerSpawner` impl that scopes MCP servers per agent config |
| `src/agents/persistent-agent-handler.ts` | Unified message bus handler with circuit breaker, bulkhead, and retry |
| `src/agents/persistent-agent-bootstrap.ts` | Creates agent workspace folders and default CLAUDE.md |

## Modified Files

| File | Change |
|------|--------|
| `src/orchestrator/app.ts` | Add `initPersistentAgents()` method, wire persistent agent handler |
| `src/db/db.ts` | Add `registered_agents` table creation (or via schema manager) |
| `src/types.ts` | Add `RegisteredAgent` interface |

---

## Constraints and Validation

- Each channel name can only be claimed by **one** agent. If two agents both claim `"email"`, the repository rejects the second registration.
- `folder` must be unique across agents (enforced by UNIQUE constraint).
- `agent_def_id` must reference a valid `agent_definitions` row, or be null (uses lead agent).
- `concurrency` must be >= 1.
- `timeout_ms` must be >= 1000.

---

## Open Questions

1. **Default/catch-all agent**: Should there be a fallback agent for channels not claimed by any persistent agent? Or is the existing poll-based flow the implicit fallback?
   - **Current answer**: Existing poll flow is the fallback. No explicit catch-all needed.

2. **Shadow admin as persistent agent**: Should shadow admin become a row in `registered_agents` instead of being hardcoded? It has special auth gates that make it different from normal agents.
   - **Current answer**: Keep separate. Its auth model (three-gate, event cancellation, invisible to normal flow) is fundamentally different.

3. **Hot reload**: When a `registered_agents` row changes, does the routing table update immediately or on next restart?
   - **Current answer**: Provide a reload method on the router. IPC watcher can trigger it, or it can poll periodically.

4. **Per-tool scoping within MCP servers**: Should we scope at the tool level (email agent gets `gmail_read` but not `calendar_list` from the same workspace server)?
   - **Current answer**: Defer. Server-level scoping covers the current use cases. Per-tool scoping can be added later in `mcp-config.ts`.
