# Bus Architecture

Definitive reference for CamBot-Agent's event-driven architecture. The MessageBus is the backbone — all inter-component communication flows through it. There is no polling loop.

## Overview

```
┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ WhatsApp │   │  Email   │   │   Web    │   │   CLI    │
└────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘
     │              │              │              │
     └──────────────┴──────┬───────┴──────────────┘
                           │ emit(InboundMessage)
                    ┌──────▼──────┐
                    │  MessageBus │
                    └──────┬──────┘
                           │ sequential by priority
     ┌─────────────────────┼──────────────────────────┐
     │                     │                          │
 ┌───▼────┐          ┌─────▼──────┐            ┌──────▼──────┐
 │ Guards │          │  Storage   │            │   Routing   │
 │ 10-20  │          │   100      │            │    110      │
 └────────┘          └────────────┘            └──────┬──────┘
  shadow-admin        db-store                        │
  input-sanitizer     lifecycle-ingest          ┌─────▼──────┐
  content-pipe                                  │ GroupQueue  │
  persistent-agent                              └─────┬──────┘
                                                      │
                                                ┌─────▼──────┐
                                                │ Container  │
                                                └────────────┘
```

## Composition Root

`src/bus/create-app-bus.ts` — called once in `CamBotApp.start()`:

```typescript
const appBus = createAppBus({ db: getDatabase() });
```

This creates the bus and installs three middleware layers (in order):

1. **Dedup filter** — drops duplicate event IDs (LRU cache, 10k entries)
2. **Backpressure** — warns when in-flight events exceed 500
3. **Event journal** — persists every event to SQLite (`bus_events` table)

## Event Types

### Class-based (used in code)

| Class | Type String | File | Fields |
|-------|-------------|------|--------|
| `InboundMessage` | `message.inbound` | `src/bus/events/inbound-message.ts` | `jid`, `message`, `channel` |
| `OutboundMessage` | `message.outbound` | `src/bus/events/outbound-message.ts` | `jid`, `text`, `groupFolder`, `broadcast`, `agentId` |
| `ChatMetadata` | `chat.metadata` | `src/bus/events/chat-metadata.ts` | `jid`, `name`, `isGroup`, `channel` |
| `TypingUpdate` | `typing.update` | `src/bus/events/typing-update.ts` | `jid`, `isTyping` |
| `AgentTelemetry` | `agent.telemetry` | `src/bus/events/agent-telemetry.ts` | `chatJid`, `durationMs`, `inputTokens`, `outputTokens`, `totalCostUsd` |
| `AgentError` | `agent.error` | `src/bus/events/agent-error.ts` | `chatJid`, `error`, `durationMs` |

### String-based (registered for discoverability)

Memory: `memory.session_summarized`, `memory.short_term_promoted`, `memory.fact_contradicted`, `memory.reflections_generated`

Telemetry: `telemetry.api_call`, `telemetry.tool_invocation`, `telemetry.error`

Security: `security.anomaly`, `security.injection_detected`, `security.tool_blocked`, `security.alert_escalated`

System: `system.startup`, `system.shutdown`, `bus.backpressure`, `bus.dead_letter`

Agent lifecycle: `agent.spawned`, `agent.completed`

Full list in `src/bus/event-types.ts`.

### Envelope (inherited by all events)

Every event carries:

```typescript
id: string              // UUID v4
type: string            // discriminator
version: number         // schema version (default 1)
correlationId?: string  // links request/response chains
causationId?: string    // parent event ID
target?: string         // routing target
channel?: string        // transport channel
source: string          // who produced this
timestamp: string       // ISO 8601
cancelled: boolean      // mutable — handlers can cancel propagation
```

## Handler Chain

### InboundMessage (sequential, by priority)

Because shadow-admin sets `sequential: true`, ALL InboundMessage handlers run one at a time in priority order. If any handler sets `event.cancelled = true`, remaining handlers are skipped.

| Priority | Handler ID | File | Cancels? | Description |
|----------|-----------|------|----------|-------------|
| 10 | `shadow-admin-intercept` | `src/agents/shadow-agent.ts` | Yes | Admin command interception (3-gate auth). Cancels to prevent normal flow. |
| 15 | `input-sanitizer` | `src/orchestrator/bus-handlers.ts` | No | Null bytes, encoding, byte limits. Mutates `event.message.content`. |
| 20 | `content-pipe` | `src/pipes/content-pipe-handler.ts` | Yes | Untrusted channels: summarize + injection detection. Cancels on critical injection if `blockOnCritical=true`. |
| 20 | `persistent-agent-handler` | `src/agents/persistent-agent-handler.ts` | Yes | Routes agent-claimed channels to container spawner with circuit breaker + bulkhead. Cancels to prevent legacy flow. |
| 100 | `db-store-inbound` | `src/orchestrator/bus-handlers.ts` | No | Writes message to SQLite. |
| 100 | `lifecycle-ingest` | `src/orchestrator/bus-handlers.ts` | No | Feeds message to memory system. |
| 110 | `message-router` | `src/orchestrator/message-router.ts` | No | Routes to active container (IPC pipe) or enqueues for new container. |
| 200 | `audit-inbound` | `src/orchestrator/bus-handlers.ts` | No | Audit log entry. |

### OutboundMessage

| Priority | Handler ID | File | Description |
|----------|-----------|------|-------------|
| 50 | `channel-delivery` | `src/orchestrator/bus-handlers.ts` | Sends text to owning channel(s). Supports broadcast. |
| 100 | `db-store-outbound` | `src/orchestrator/bus-handlers.ts` | Stores bot message + updates chat metadata. |
| 200 | `audit-outbound` | `src/orchestrator/bus-handlers.ts` | Audit log entry. |

### ChatMetadata

| Priority | Handler ID | File | Description |
|----------|-----------|------|-------------|
| 100 | `db-store-metadata` | `src/orchestrator/bus-handlers.ts` | Stores/updates chat metadata in SQLite. |

## Message Flow

### Inbound: User sends a message

```
1. Channel receives message (WhatsApp webhook, email poll, HTTP POST, readline)
2. Channel calls bus.emit(new InboundMessage(...))
3. Middleware pipeline:
   a. Dedup: check event ID → allow or drop
   b. Backpressure: increment in-flight counter
   c. Event journal: INSERT into bus_events
4. Handlers run sequentially by priority (10 → 200)
   - Guards may cancel (shadow-admin, content-pipe, persistent-agent-handler)
   - Storage at priority 100 (guaranteed before routing)
   - Routing at priority 110 (message already in DB)
5. Middleware after hooks:
   a. Event journal: UPDATE bus_events SET processed = 1
   b. Backpressure: decrement in-flight counter
```

### Outbound: Agent sends a response

```
1. Container writes result to IPC
2. IPC handler calls bus.emit(new OutboundMessage(...))
3. Handlers run:
   a. channel-delivery (50): sends via channel.sendMessage()
   b. db-store-outbound (100): stores in SQLite
   c. audit-outbound (200): audit log
```

### Reactive routing (replaced polling)

The old `MessageLoop` polled SQLite every 2 seconds. The new `message-router` handler fires instantly on every `InboundMessage` event at priority 110:

1. **Guard: registered group?** — skip if JID not registered
2. **Guard: channel owns JID?** — skip if no channel claims it
3. **Guard: trigger required?** — non-main groups need `@Andy` in content (unless `requiresTrigger=false`)
4. **Try pipe to active container** — `queue.sendMessage()` writes IPC file
5. **If no active container** — `queue.enqueueMessageCheck()` starts one

No debounce needed. Natural batching handles rapid messages:
- No container running: `enqueueMessageCheck()` is idempotent. Container startup takes seconds; all rapid messages accumulate in DB.
- Container running: each message triggers a pipe. Container's IPC `drain()` batches accumulated files.

### Startup recovery

`recoverPendingMessages()` (`src/orchestrator/message-recovery.ts`) runs once before bus handlers activate. It scans all registered groups for unprocessed messages and enqueues any that have pending work.

## Event Emission Sources

### Channels (emit InboundMessage + ChatMetadata)

| Channel | File | Trigger |
|---------|------|---------|
| WhatsApp | `src/channels/whatsapp.ts` | Baileys message callback |
| Email | `src/channels/email.ts` | Gmail polling cycle |
| Web | `src/channels/web.ts` | POST /message |
| CLI | `src/channels/cli.ts` | readline line event |

### Agent services (emit OutboundMessage)

| Source | File | Trigger |
|--------|------|---------|
| IPC message handler | `src/ipc/message-handler.ts` | Container writes messages.json |
| Custom agent service | `src/agents/custom-agent-service.ts` | Streaming container output |
| Workflow service | `src/workflows/workflow-service.ts` | Workflow step message completion |
| Persistent agent handler | `src/agents/persistent-agent-handler.ts` | Agent spawn failure notification |

### Internal (emit TypingUpdate)

| Source | File | Trigger |
|--------|------|---------|
| Message router | `src/orchestrator/message-router.ts` | Successful pipe to active container |

## Middleware

### Dedup Filter (`src/bus/middleware/dedup-filter.ts`)

- In-memory LRU map (default 10k entries)
- `before()` returns `false` if event ID already seen → event dropped
- Prevents re-emission during retries or replay

### Backpressure (`src/bus/middleware/backpressure.ts`)

- Tracks in-flight event count
- Strategy: `warn` (log but allow) or `drop` (reject event)
- Default high-water mark: 500
- `before()` increments; `after()` decrements

### Event Journal (`src/bus/middleware/event-journal.ts`)

- Persists every event to `bus_events` SQLite table
- Uses WriteQueue for batched inserts (50ms interval, 200-item batches)
- `before()` inserts event record; `after()` marks `processed = 1`
- Query API: `queryEvents({ type?, limit?, since? })`

Schema:
```sql
CREATE TABLE bus_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT,
  correlation_id TEXT,
  causation_id TEXT,
  target TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  timestamp TEXT NOT NULL,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

## Durable Queue (`src/bus/durable-queue/`)

SQLite-backed FIFO queue with priority lanes, retry, and dead-lettering. Used by the event journal's WriteQueue.

- **Priority ordering**: lower number = higher priority
- **Retry**: configurable max attempts (default 5) with automatic dead-lettering
- **Batching**: configurable batch size (default 200)
- **Adaptive polling**: fast interval when items pending, slow when idle
- **Metrics**: batch sizes, drain durations, total drained/failed
- **Registry**: `src/bus/durable-queue/registry.ts` for observability

## Channel Bus Adapter (`src/bus/channel-bus-adapter.ts`)

Bridges the class-based MessageBus to the string-based interface expected by `cambot-channels` (external package). Two-way conversion:

- Inbound: string event → class instance (`'message.inbound'` → `new InboundMessage(...)`)
- Outbound: class instance → plain object for string-based handlers

## WebSocket Transport (`src/bus/transport/ws-transport.ts`)

Middleware that broadcasts bus events to connected WebSocket clients. Configured with event type filters (e.g., only `message.outbound` and `typing.update`). Used by the web channel for real-time UI updates.

## Key Design Decisions

### Sequential mode is all-or-nothing
If ANY handler for an event sets `sequential: true`, ALL handlers for that event run sequentially. This simplifies ordering guarantees and makes cancellation deterministic.

### Priority ordering
Lower number = higher priority. Guards run first (10-20), storage in the middle (100), routing after storage (110), audit last (200).

### Cancellation
`event.cancelled = true` stops propagation to remaining sequential handlers. Only works in sequential mode (parallel handlers can't be cancelled after launch). Three handlers can cancel InboundMessage: shadow-admin, content-pipe, persistent-agent-handler.

### No polling
The MessageBus is fully reactive. Events flow through handlers the instant they're emitted. The only polling in the system is IPC file watching and scheduled task checking — message routing itself is event-driven.

## Key Files

| File | Purpose |
|------|---------|
| `src/bus/message-bus.ts` | Core bus: subscribe, emit, match, execute |
| `src/bus/bus-event.ts` | Abstract base class for all events |
| `src/bus/create-app-bus.ts` | Composition root (middleware wiring) |
| `src/bus/events/` | Event class definitions |
| `src/bus/event-types.ts` | Event type registry |
| `src/bus/middleware/` | Dedup, backpressure, event journal |
| `src/bus/durable-queue/` | SQLite-backed queue with retry |
| `src/bus/write-queue/` | Batched SQL write operations |
| `src/bus/transport/ws-transport.ts` | WebSocket event broadcasting |
| `src/bus/channel-bus-adapter.ts` | String ↔ class event bridge |
| `src/orchestrator/bus-handlers.ts` | Core handler registrations |
| `src/orchestrator/message-router.ts` | Reactive message routing (replaces polling) |
| `src/orchestrator/message-recovery.ts` | Startup recovery for pending messages |
| `src/orchestrator/app.ts` | Wires everything together |
