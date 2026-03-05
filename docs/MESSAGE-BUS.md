# Message Bus

Type-safe event bus for decoupling producers (agent output, IPC, channels) from consumers (DB storage, channel delivery, interceptors).

## Architecture

### Class-based routing

Events are classes, not strings. The bus routes by `instanceof`, so handlers receive strongly-typed objects with no casting required.

```
BusEvent (abstract)
├── InboundMessage    — user message arrives from a channel
├── OutboundMessage   — bot response to deliver to a channel
├── ChatMetadata      — chat name/metadata updates
├── TypingUpdate      — typing indicators
├── AgentTelemetry    — cost/token/duration data from agent execution
└── AgentError        — agent execution failures
```

### Single `emit()` method

One async method handles everything. The bus auto-decides execution mode based on registered handlers:

- **Parallel** (default): Handlers run concurrently via `Promise.allSettled`. One handler failing doesn't block others.
- **Sequential**: If ANY matching handler declares `sequential: true`, ALL handlers for that event run in priority order. This enables cancellation — a handler can set `event.cancelled = true` to stop subsequent handlers.

### File layout

```
src/bus/
  bus-event.ts          — abstract BusEvent base class
  message-bus.ts        — MessageBus class + createMessageBus factory
  events/
    inbound-message.ts
    outbound-message.ts
    chat-metadata.ts
    typing-update.ts
    agent-telemetry.ts
    agent-error.ts
    index.ts            — barrel export
  index.ts              — barrel export (re-exports everything)
```

All bus types are also re-exported from `src/types.ts` for convenience.

## Usage

### Emitting events

Construct an event object and call `emit()`:

```ts
import { OutboundMessage, TypingUpdate, InboundMessage, ChatMetadata } from './bus/index.js';

// Send a message to a chat
await bus.emit(new OutboundMessage('agent', chatJid, responseText, {
  groupFolder: group.folder,
}));

// Typing indicator
bus.emit(new TypingUpdate('agent', chatJid, true)).catch(() => {});

// Inbound message from a channel
await bus.emit(new InboundMessage('web', jid, newMessage, 'web'));

// Chat metadata update
await bus.emit(new ChatMetadata('web', jid, {
  name: 'Web UI',
  channel: 'web',
  isGroup: false,
}));
```

Every event constructor takes `source` as the first argument — a string identifying who emitted it (e.g. `'agent'`, `'ipc'`, `'web'`, `'task'`, `'workflow'`, `'custom-agent'`).

### Subscribing to events

Pass the event **class** (not a string) to `on()`. The handler receives the concrete type:

```ts
import { OutboundMessage, InboundMessage, ChatMetadata } from './bus/index.js';

// Type-safe — event is OutboundMessage, not a generic object
bus.on(OutboundMessage, (event) => {
  console.log(event.jid);   // string
  console.log(event.text);  // string
  console.log(event.source); // string (inherited from BusEvent)
}, { id: 'my-handler', priority: 100 });
```

`on()` returns an unsubscribe function:

```ts
const unsubscribe = bus.on(InboundMessage, handler);
// later...
unsubscribe();
```

### Handler options

```ts
bus.on(EventClass, handler, {
  id: 'unique-handler-id',   // defaults to auto-generated
  priority: 50,               // lower runs first (default: 100)
  source: 'my-module',        // for debugging/logging
  sequential: true,            // opt-in to sequential execution
});
```

### Priority ordering

Handlers are sorted by `priority` (ascending). Lower numbers run first:

| Priority | Use case |
|----------|----------|
| 10 | Interceptors (shadow admin) |
| 50 | Channel delivery |
| 100 | Default (DB storage) |

### Sequential mode and cancellation

When any handler for an event type declares `sequential: true`, all handlers run sequentially in priority order. This enables the cancellation pattern:

```ts
// Shadow admin intercepts inbound messages before DB storage
bus.on(InboundMessage, (event) => {
  if (isAdminCommand(event.message.content)) {
    event.cancelled = true;  // prevents DB handler from running
    handleAdminCommand(event);
  }
}, { id: 'shadow-admin', priority: 10, sequential: true });

// DB storage runs at priority 100 — skipped if cancelled
bus.on(InboundMessage, (event) => {
  storeMessage(event.message);
}, { id: 'db-store', priority: 100 });
```

Without `sequential: true`, both handlers would run concurrently and cancellation would be a race condition.

## Event reference

### InboundMessage

User message arriving from a channel.

| Field | Type | Description |
|-------|------|-------------|
| `jid` | `string` | Chat JID |
| `message` | `NewMessage` | Full message object |
| `channel` | `string?` | Channel name (e.g. `'web'`, `'whatsapp'`) |

### OutboundMessage

Bot response to deliver to a channel.

| Field | Type | Description |
|-------|------|-------------|
| `jid` | `string` | Target chat JID |
| `text` | `string` | Message text |
| `groupFolder` | `string?` | Source group folder |
| `broadcast` | `boolean?` | Send to all connected channels |
| `agentId` | `string?` | Custom agent ID (if applicable) |

### ChatMetadata

Chat name or metadata update.

| Field | Type | Description |
|-------|------|-------------|
| `jid` | `string` | Chat JID |
| `name` | `string?` | Chat display name |
| `channel` | `string?` | Channel name |
| `isGroup` | `boolean?` | Whether this is a group chat |

### TypingUpdate

Typing indicator.

| Field | Type | Description |
|-------|------|-------------|
| `jid` | `string` | Chat JID |
| `isTyping` | `boolean` | Whether typing is active |

### AgentTelemetry

Cost and performance data from agent execution.

| Field | Type | Description |
|-------|------|-------------|
| `chatJid` | `string` | Chat JID |
| `durationMs` | `number` | Execution duration |
| `inputTokens` | `number?` | Input token count |
| `outputTokens` | `number?` | Output token count |
| `totalCostUsd` | `number?` | Total cost in USD |

### AgentError

Agent execution failure.

| Field | Type | Description |
|-------|------|-------------|
| `chatJid` | `string` | Chat JID |
| `error` | `string` | Error message |
| `durationMs` | `number` | Time before failure |

### Inherited fields (BusEvent)

All events include these fields from the abstract base:

| Field | Type | Description |
|-------|------|-------------|
| `source` | `string` | Who emitted the event |
| `timestamp` | `string` | ISO 8601 timestamp (set automatically) |
| `cancelled` | `boolean` | Set to `true` to stop subsequent sequential handlers |

## Lifecycle hooks

The bus accepts optional hooks for observability and control:

```ts
const bus = new MessageBus({
  onEventReceived(event) {
    // Return false to suppress the event entirely
  },
  onAfterEmit(event) {
    // Called after all handlers have run
  },
  onHandlerError(error, event, handlerId) {
    // Return true to swallow the error silently
  },
  onHandlerStart(event, handlerId) {
    // Called before each handler executes
  },
  onCancel(event, cancelledByHandlerId) {
    // Called when a cancelled event skips a handler
  },
});
```

## Testing

In tests, create a real `MessageBus` instance — no mocking needed:

```ts
import { MessageBus, InboundMessage } from './bus/index.js';

const bus = new MessageBus();

// Subscribe
const received: InboundMessage[] = [];
bus.on(InboundMessage, (event) => {
  received.push(event);
});

// Emit
await bus.emit(new InboundMessage('test', 'web:ui', testMessage));

// Assert
expect(received).toHaveLength(1);
expect(received[0].jid).toBe('web:ui');
```

For spying on subscriptions:

```ts
const bus = new MessageBus();
const onSpy = vi.spyOn(bus, 'on');

createShadowAgent({ messageBus: bus, ... });

expect(onSpy).toHaveBeenCalledWith(
  InboundMessage,
  expect.any(Function),
  expect.objectContaining({ priority: 10, sequential: true }),
);
```

## Adding a new event type

1. Create `src/bus/events/my-event.ts`:
   ```ts
   import { BusEvent } from '../bus-event.js';

   export class MyEvent extends BusEvent {
     readonly someField: string;

     constructor(source: string, someField: string) {
       super(source);
       this.someField = someField;
     }
   }
   ```

2. Export from `src/bus/events/index.ts`:
   ```ts
   export { MyEvent } from './my-event.js';
   ```

3. Optionally re-export from `src/types.ts` if widely used.

4. Emit: `await bus.emit(new MyEvent('my-module', 'value'))`

5. Subscribe: `bus.on(MyEvent, (event) => { ... })`
