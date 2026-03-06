# CamBot-Agent Architecture

Single Node.js process + N Docker containers. The host orchestrates messaging, state, and scheduling. Containers run Claude Agent SDK in isolation per group.

> **Bus architecture**: See [BUS-ARCHITECTURE.md](BUS-ARCHITECTURE.md) for the definitive reference on the event bus, handler chain, middleware, and message flow.

```
┌─────────────────────────────────────────────────────────────┐
│  Host Process (Node.js)                                     │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌───────────┐  │
│  │ WhatsApp │  │  Email   │  │   Web     │  │   CLI     │  │
│  │ Channel  │  │ Channel  │  │ Channel   │  │ Channel   │  │
│  └────┬─────┘  └────┬─────┘  └─────┬─────┘  └─────┬─────┘  │
│       │              │              │              │         │
│       └──────────────┴──────┬───────┴──────────────┘         │
│                             │  emit(InboundMessage)          │
│  ┌──────────────────────────▼──────────────────────────────┐ │
│  │  MessageBus                                             │ │
│  │  Middleware: dedup → backpressure → event journal       │ │
│  │  Handlers: sequential by priority (10 → 200)           │ │
│  └──────────────────────────┬──────────────────────────────┘ │
│                             │                                │
│  ┌──────────────────────────▼──────────────────────────────┐ │
│  │  GroupQueue                                             │ │
│  │  Per-group serialization · Global pool (max 5)          │ │
│  └──────────────────────────┬──────────────────────────────┘ │
│                             │                                │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐                      │
│  │Container│  │Container│  │Container│  (up to 5)            │
│  │ Group A │  │ Group B │  │ Group C │                       │
│  └─────────┘  └─────────┘  └─────────┘                      │
│       │              │              │         SQLite          │
│       └──────────────┼──────────────┘     (cambot.sqlite)    │
│                      ▼                                       │
│               Docker Engine                                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Component Map

| Directory / File | Purpose |
|------|---------|
| `src/orchestrator/app.ts` | CamBotApp facade: startup, shutdown, wiring |
| `src/orchestrator/message-router.ts` | Reactive bus handler: routes inbound messages to containers |
| `src/orchestrator/message-recovery.ts` | Startup recovery for pending messages |
| `src/orchestrator/bus-handlers.ts` | Core handler registrations (storage, delivery, audit) |
| `src/bus/` | MessageBus, events, middleware, durable queue, transport |
| `src/bus/create-app-bus.ts` | Composition root: bus + middleware wiring |
| `src/types.ts` | All TypeScript interfaces (`Channel`, `RegisteredGroup`, `NewMessage`, etc.) |
| `src/config/config.ts` | Constants: paths, intervals, timeouts, trigger regex, env reads |
| `src/config/env.ts` | Parses `.env` into typed record without polluting `process.env` |
| `src/logger.ts` | Pino logger; hooks `uncaughtException`/`unhandledRejection` |
| `src/utils/router.ts` | Formats messages to XML, strips `<internal>` tags |
| `src/db/` | SQLite repositories: chat, message, task, group, session, agent-def, integration, mcp |
| `src/groups/group-queue.ts` | Per-group concurrency with global container cap, retry/backoff |
| `src/groups/group-folder.ts` | Validates/resolves group folder paths; prevents path traversal |
| `src/container/runner.ts` | Builds volume mounts, spawns Docker containers, streams stdout |
| `src/container/runtime.ts` | Runtime abstraction: `readonlyMountArgs`, `stopContainer`, `cleanupOrphans` |
| `src/container/snapshot-writers.ts` | Writes task/group/workflow snapshots for containers |
| `src/ipc/watcher.ts` | File-based IPC watcher: polls per-group dirs |
| `src/ipc/task-handler.ts` | Processes IPC task commands (schedule, workflows, agents, integrations) |
| `src/ipc/message-handler.ts` | Processes IPC message files |
| `src/scheduling/task-scheduler.ts` | Polls SQLite for due tasks every 60s, dispatches to GroupQueue |
| `src/container/mount-security.ts` | Validates `additionalMounts` against external allowlist |
| `src/channels/registry.ts` | Discovers and loads configured channels |
| `src/channels/whatsapp.ts` | Baileys WebSocket: LID translation, outgoing queue, metadata sync |
| `src/channels/email.ts` | Gmail polling + reply via workspace-mcp |
| `src/channels/web.ts` | HTTP + WebSocket channel |
| `src/channels/cli.ts` | Interactive stdin/stdout channel for local dev |
| `agent-runner/src/index.ts` | In-container query loop: Claude Agent SDK, IPC input polling |
| `agent-runner/src/ipc-mcp-stdio.ts` | MCP server: `send_message`, `schedule_task`, `list/pause/cancel_task` |

---

## Layer 1: Channels

Pluggable I/O adapters. Accept inbound messages, deliver outbound responses.

**Interface** (`types.ts`):
```
Channel {
  name, connect(), sendMessage(jid, text), isConnected(),
  ownsJid(jid), disconnect(), setTyping?(jid, bool), syncMetadata?(force)
}
```

**Bus integration**: Channels emit `InboundMessage` and `ChatMetadata` events directly to the MessageBus. Outbound delivery is handled by the `channel-delivery` bus handler (priority 50), which finds the owning channel and calls `sendMessage()`.

**Registry** (`channels/registry.ts`): Hard-coded `ChannelDefinition[]` with `isConfigured()` guards. WhatsApp auto-activates if `store/auth/creds.json` exists. CLI activates only via `CHANNELS=cli` env var. Dynamic imports defer heavy dependencies.

**Routing**: Each channel implements `ownsJid(jid)` — the bus handler iterates channels to find the owner. WhatsApp JIDs look like `12345@s.whatsapp.net`; CLI uses `cli:console`; Web uses `web:ui`.

**Adding a channel**: Implement `Channel`, add a `ChannelDefinition` to the registry array. Emit `InboundMessage` to the bus on receive. No other files need changes.

---

## Layer 2: MessageBus

The event backbone. All inter-component communication flows through it. See [BUS-ARCHITECTURE.md](BUS-ARCHITECTURE.md) for the complete reference.

**Startup sequence** (`CamBotApp.start()`):
1. Verify Docker is running, kill orphaned containers
2. Open SQLite DB, create schema, migrate
3. Load state: cursors, sessions, registered groups
4. Create bus via `createAppBus()` (installs middleware)
5. Register bus handlers (storage, delivery, audit, routing)
6. Initialize integrations and channels
7. Install shadow-admin, persistent agents, content pipes
8. Wire GroupQueue with GroupMessageProcessor
9. Recover pending messages (re-enqueue groups with lagging cursors)
10. Register message-router handler (priority 110, reactive routing)

**Message routing**: The `message-router` bus handler fires instantly on every `InboundMessage` event. Guards check registration, channel ownership, and trigger pattern. Routes to active containers via IPC or enqueues for new containers. No polling.

---

## Layer 3: Queue & Concurrency

`src/groups/group-queue.ts` — per-group serialization with a global container pool.

**Concurrency model**: Up to `MAX_CONCURRENT_CONTAINERS` (default 5) containers run simultaneously across all groups. Each group runs at most one container at a time.

**State machine per group**:
```
idle ──enqueue──▶ waiting ──slot opens──▶ active ──finishes──▶ idle
                                            │
                                            ├── pendingMessages → re-run
                                            └── pendingTasks → preempt idle, re-run
```

**Key operations**:
- `enqueueMessageCheck(jid)` — queue group for message processing
- `enqueueTask(jid, taskId, fn)` — queue scheduled task (deduped by ID)
- `sendMessage(jid, text)` — inject message into active container via IPC file
- `closeStdin(jid)` — write `_close` sentinel to signal container exit
- `notifyIdle(jid)` — container is idle; preempt if tasks are pending

**Drain priority**: Tasks first, then pending messages, then waiting groups.

**Retry/backoff**: 5 retries, exponential backoff (5s → 10s → 20s → 40s → 80s). After max retries, the group resets and retries on next incoming trigger.

**Shutdown**: Sets `shuttingDown` flag. Active containers are *not* killed — they detach and `--rm` cleans them up. This prevents killing agents mid-response.

---

## Layer 4: Container Isolation

Each group runs Claude Agent SDK inside a Docker container with isolated mounts.

**Volume mounts** (host → container):

| Host Path | Container Path | Mode | Notes |
|-----------|---------------|------|-------|
| `PROJECT_ROOT` | `/workspace/project` | ro | Main group only |
| `groups/<folder>/` | `/workspace/group` | rw | Agent working directory |
| `groups/global/` | `/workspace/global` | ro | Shared CLAUDE.md (non-main) |
| `data/sessions/<folder>/.claude/` | `/home/node/.claude` | rw | Session, settings, skills |
| `data/ipc/<folder>/` | `/workspace/ipc` | rw | IPC messages/tasks/input |
| `data/sessions/<folder>/agent-runner-src/` | `/app/src` | rw | Customizable runner source |
| Allowlisted paths | `/workspace/extra/<name>` | ro/rw | Validated by mount-security |

**Input protocol** (host → container):
- **Initial**: JSON on stdin — `{ prompt, sessionId?, groupFolder, chatJid, isMain, secrets }`
- **Follow-up messages**: JSON files in `data/ipc/<group>/input/<timestamp>.json`
- **Close signal**: Empty file `data/ipc/<group>/input/_close`

Secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) are passed via stdin only — never written to disk, unset from env before every Bash tool invocation.

**Output protocol** (container → host):
```
---CAMBOT_AGENT_OUTPUT_START---
{"status":"success","result":"...","newSessionId":"..."}
---CAMBOT_AGENT_OUTPUT_END---
```
Streamed incrementally via stdout. Each marker pair triggers `onOutput` callback. Timeout resets on each marker (activity detection).

**Container lifecycle**: `docker run -i --rm`, runs as `node` user (non-root). Recompiles agent-runner TypeScript on every start (allows per-group customization). Hard timeout = `max(CONTAINER_TIMEOUT, IDLE_TIMEOUT + 30s)`. Graceful `docker stop` then `SIGKILL` on timeout.

---

## Data Flows

### Inbound Message → Response

```
Channel ─────► bus.emit(InboundMessage) ──► MessageBus
                                                │ sequential handlers
                                                ├── shadow-admin (10) — may cancel
                                                ├── input-sanitizer (15)
                                                ├── content-pipe (20) — may cancel
                                                ├── persistent-agent-handler (20) — may cancel
                                                ├── db-store (100) — writes to SQLite
                                                ├── lifecycle-ingest (100)
                                                ├── message-router (110) ──► route
                                                │       │
                                                │       ├── active container? → IPC pipe
                                                │       └── no container → enqueue
                                                │                              │
                                                │                    GroupMessageProcessor
                                                │                              │
                                                │                     runContainerAgent()
                                                │                              │
                                                │                    ┌─────────┴──────────┐
                                                │                    │  Docker Container   │
                                                │                    │  Claude Agent SDK   │
                                                │                    └─────────┬──────────┘
                                                │                              │
                                                │                    IPC output → bus.emit(OutboundMessage)
                                                │                              │
                                                └── audit (200)      channel.sendMessage() → User
```

### IPC: Container → Host

```
Container                           Host
─────────                           ────
MCP tool call                       IPC Watcher (1s poll)
  │                                      │
  ▼                                      ▼
Write JSON to                       Scan data/ipc/*/
/workspace/ipc/messages/              │
  or /tasks/                          ├── messages/*.json
                                      │     ├── Auth check (main can send anywhere,
                                      │     │   non-main only to own JID)
                                      │     └── bus.emit(OutboundMessage)
                                      │
                                      └── tasks/*.json
                                            ├── schedule_task → createTask (SQLite)
                                            ├── pause/resume/cancel → updateTask
                                            └── register_group → registerGroup
```

### Scheduled Task Execution

```
Scheduler (60s poll)
       │
  getDueTasks() ◄── SQLite (WHERE next_run <= now)
       │
  queue.enqueueTask()
       │
  runTask()
       │
  runContainerAgent(isScheduledTask: true)
       │
  Container runs with [SCHEDULED TASK] label
       │
  10s close timer after first result
       │
  logTaskRun() + updateTaskAfterRun() ──► SQLite
       │
  Compute next_run (cron/interval) or complete (once)
```

---

## Design Patterns

| Pattern | Where Used |
|---------|------------|
| **Event-driven bus** | All inter-component communication via MessageBus with priority-ordered handlers |
| **Cursor-based recovery** | Per-group `agentTimestamp` cursors prevent message loss on crash |
| **Strategy pattern** | Channel registry (pluggable I/O); container runtime abstraction |
| **File-based IPC** | Containers write JSON files, host polls and processes (atomic rename for safety) |
| **Per-group isolation** | Separate mounts, sessions, IPC namespaces per group folder |
| **Exponential backoff** | GroupQueue retries: 5s × 2^n, max 5 attempts |
| **Sentinel files** | `_close` file signals container to exit; avoids signal complexity across Docker |
| **Streaming markers** | `OUTPUT_START`/`OUTPUT_END` pairs enable incremental result delivery |
| **Idle preemption** | Tasks arriving while container is idle trigger `closeStdin` to recycle it |
| **Graceful degradation** | Shutdown lets active containers finish; orphan cleanup on restart |
| **Cancellation chain** | Sequential handlers can cancel propagation (shadow-admin, content-pipe) |

---

## Security Model

**Container isolation**: Each group gets its own Docker container with separate filesystem mounts. Containers run as non-root (`node` user). Project root is mounted read-only (main group only).

**Secret handling**: API keys passed via stdin, never written to disk. Agent-runner `unset`s secrets from env before every Bash tool invocation.

**IPC authorization**: Directory-name-based identity. Main group can send to any registered chat. Non-main groups can only send to their own JID.

**Mount security**: Additional mounts validated against `~/.config/cambot-agent/mount-allowlist.json` (outside project root — agents cannot read or modify it). Blocked patterns include `.ssh`, `.aws`, `.env`, `credentials`, private keys. Non-main groups forced read-only if `nonMainReadOnly=true`. Symlinks resolved before validation.

**Group folders**: `src/groups/group-folder.ts` validates paths, blocks traversal (`..`), ensures folders resolve within `groups/` directory.

---

## Persistence (SQLite)

All state lives in `store/cambot.sqlite` via `better-sqlite3`.

| Table | Purpose |
|-------|---------|
| `chats` | Chat discovery — JID, name, channel, timestamps |
| `messages` | Message history — content, sender, timestamps, bot flag |
| `scheduled_tasks` | Task definitions — prompt, schedule, next_run, status |
| `task_run_logs` | Execution history — duration, status, result, errors |
| `router_state` | Key-value for cursors (`last_agent_timestamp`) |
| `sessions` | Claude SDK session IDs per group folder |
| `registered_groups` | Group config — JID, folder, trigger pattern, container config |
| `bus_events` | Event journal — all bus events for audit/replay |

**Cursor recovery**: On startup, `recoverPendingMessages()` compares each group's `agentTimestamp` against the DB. Groups with unprocessed messages are re-enqueued.
