# Agent Conduit — Technical Design

> Replaces file-based IPC with a TCP socket transport protocol between the host process and agent containers. Cross-platform: Windows, macOS, Linux.

## 1. Naming

**AgentConduit** — the transport layer that carries structured frames between the message bus (host) and agent containers.

| Current Name | New Name |
|---|---|
| `src/ipc/` | `src/conduit/` |
| `agent-runner/src/ipc-channel.ts` | `agent-runner/src/conduit-client.ts` |
| `agent-runner/src/ipc-query-bridge.ts` | `agent-runner/src/conduit-query-bridge.ts` |
| `agent-runner/src/ipc-mcp-stdio.ts` | `agent-runner/src/conduit-mcp-stdio.ts` |
| `IpcChannel` class | `ConduitClient` class |
| `IpcDeps` interface | `ConduitDeps` interface |
| `startIpcWatcher()` | Gone (replaced by `ConduitServer`) |
| `processTaskIpc()` | Gone (replaced by typed command handlers) |
| `processMessageFiles()` | Gone (replaced by outbound frame handler) |
| `data/ipc/{group}/` | Gone (no filesystem artifacts) |
| `IPC_POLL_INTERVAL` | Gone |
| `IPC_POLL_MS` | Gone |
| `resolveGroupIpcPath()` | Gone |

## 2. Problem Statement

The current IPC layer uses filesystem polling to bridge the host process and Docker containers:

- **500ms latency floor** on every message (poll interval)
- **Race conditions** on file read/write (TOCTOU, partial writes)
- **1063-line task handler** dispatching 20+ command types through untyped JSON
- **No backpressure** — files pile up with no flow control
- **Cleanup burden** — stale files, error directories, orphan sentinels
- **Two polling loops** — host polls `data/ipc/`, container polls `ipc/input/`

## 3. Solution

Replace file-based IPC with a **TCP socket** using a length-prefixed binary framing protocol. The host listens on a single TCP port. Each container connects over `host.docker.internal`. A handshake frame authenticates the container and maps the connection to its group.

### Why TCP, Not Unix Sockets

Unix domain socket mounts **do not work on Windows Docker Desktop**. The bind mount translation layer (9P/grpcfuse between Windows and WSL2) cannot bridge Windows AF_UNIX sockets to Linux AF_UNIX sockets. Since the system must run on Windows, macOS, and Linux, TCP is the only transport that works identically on all three.

### Transport

```
Host:      net.createServer() listening on 0.0.0.0:{CONDUIT_PORT}
Container: net.createConnection(CONDUIT_PORT, 'host.docker.internal')
```

| Platform | `host.docker.internal` | Setup Required |
|---|---|---|
| **Windows** (Docker Desktop) | Built-in | None |
| **macOS** (Docker Desktop) | Built-in | None |
| **Linux** (Docker Engine) | Requires flag | `--add-host=host.docker.internal:host-gateway` in container args |

### Security

The conduit port listens on `0.0.0.0` but is secured by:

1. **Token authentication** — Every connection must send a `handshake` frame with the owner token generated at spawn time. Connections without valid tokens are immediately closed.
2. **Firewall recommendation** — Production deployments should firewall the conduit port to localhost/Docker network only.
3. **Single-connection-per-group** — If a group already has an active connection, new connections for that group close the old one (supersession, same as current `_owner` file behavior).

## 4. Wire Protocol

### Frame Format

```
┌──────────────────────────────────────────────┐
│  4 bytes: payload length (uint32 big-endian) │
│  N bytes: JSON payload (utf-8)               │
└──────────────────────────────────────────────┘
```

Length-prefixed framing solves message boundary ambiguity without relying on newlines or sentinel markers.

**Max frame size**: 16 MB (enforced by decoder). Frames exceeding this are rejected and the connection is closed.

### Frame Schema

Every frame is a self-describing JSON object:

```typescript
interface ConduitFrame<T = unknown> {
  type: string;       // Command discriminator (e.g. 'message.input', 'task.schedule')
  id: string;         // Unique frame ID (uuid v4)
  replyTo?: string;   // Correlation ID — references the `id` of the frame being replied to
  payload: T;         // Typed per command
}
```

`replyTo` enables request/response patterns. The caller sends a frame with `id`, the responder replies with `replyTo` pointing to that `id`. This replaces FIFO queue correlation and result files.

### Connection Lifecycle

```
Container connects to host.docker.internal:{CONDUIT_PORT}
  ──► sends handshake frame { group, token }
  ◄── receives handshake.ack { ok: true }
  ... bidirectional framed communication ...
  ──► connection close = container dead
```

### Handshake Frame

The first frame on any connection **must** be a handshake. The host validates the token against the one generated at container spawn time.

```typescript
// Container → Host (first frame, mandatory)
{
  type: 'handshake',
  id: '...',
  payload: {
    group: string,    // Group folder name (e.g. 'main', 'email-agent')
    token: string,    // Owner token from ContainerInput.ipcToken
  }
}

// Host → Container (reply)
{
  type: 'handshake.ack',
  id: '...',
  replyTo: '...',
  payload: { ok: true }
}

// Or rejection:
{
  type: 'handshake.reject',
  id: '...',
  replyTo: '...',
  payload: { error: 'Invalid token' }
}
// Connection closed immediately after rejection.
```

### Frame Types — Host → Container

| Type | Payload | Replaces |
|---|---|---|
| `handshake.ack` | `{ ok: true }` | N/A (new) |
| `handshake.reject` | `{ error: string }` | N/A (new) |
| `message.input` | `{ text: string, chatJid: string }` | `ipc/input/*.json` files |
| `session.close` | `{ reason: string }` | `ipc/input/_close` sentinel |
| `ping` | `{ timestamp: number }` | Heartbeat read cycle |

### Frame Types — Container → Host

| Type | Payload | Replaces |
|---|---|---|
| `handshake` | `{ group: string, token: string }` | `_owner` file check |
| `pong` | `{ timestamp: number }` | `_heartbeat` file |
| `heartbeat` | `{ phase, queryCount, uptimeMs }` | `_heartbeat` file writes |
| `output` | `{ status, result, newSessionId?, telemetry? }` | stdout sentinel markers |
| `message.outbound` | `{ chatJid: string, text: string }` | `ipc/messages/*.json` |
| `task.schedule` | `{ prompt, scheduleType, scheduleValue, targetJid, ... }` | `tasks/schedule_task.json` |
| `task.pause` | `{ taskId: string }` | `tasks/pause_task.json` |
| `task.resume` | `{ taskId: string }` | `tasks/resume_task.json` |
| `task.cancel` | `{ taskId: string }` | `tasks/cancel_task.json` |
| `group.refresh` | `{}` | `tasks/refresh_groups.json` |
| `group.register` | `{ jid, name, folder, trigger, ... }` | `tasks/register_group.json` |
| `worker.delegate` | `{ delegationId, workerId, prompt, context? }` | `tasks/delegate_worker.json` |
| `agent.send` | `{ requestId, targetAgent, prompt }` | `tasks/send_to_agent.json` |
| `workflow.run` | `{ workflowId, chatJid? }` | `tasks/run_workflow.json` |
| `workflow.pause` | `{ runId }` | `tasks/pause_workflow.json` |
| `workflow.cancel` | `{ runId }` | `tasks/cancel_workflow.json` |
| `workflow.create` | `{ requestId, workflow }` | `tasks/create_workflow_def.json` |
| `workflow.update` | `{ requestId, workflowId, workflow }` | `tasks/update_workflow_def.json` |
| `workflow.delete` | `{ requestId, workflowId }` | `tasks/delete_workflow_def.json` |
| `workflow.validate` | `{ requestId, workflow }` | `tasks/validate_workflow_def.json` |
| `workflow.clone` | `{ requestId, sourceId, newId, newName? }` | `tasks/clone_workflow_def.json` |
| `workflow.schema` | `{ requestId }` | `tasks/get_workflow_schema.json` |
| `integration.list` | `{ chatJid }` | `tasks/list_integrations.json` |
| `integration.enable` | `{ targetId }` | `tasks/enable_integration.json` |
| `integration.disable` | `{ targetId }` | `tasks/disable_integration.json` |
| `mcp.add` | `{ name, transport, url?, ... }` | `tasks/add_mcp_server.json` |
| `mcp.remove` | `{ targetId }` | `tasks/remove_mcp_server.json` |
| `email.check` | `{ requestId, query?, maxResults? }` | `tasks/check_email.json` |
| `email.read` | `{ requestId, messageId, includeRaw? }` | `tasks/read_email.json` |

### Bidirectional Frames (Request/Response)

Any command that returns a result uses the `replyTo` correlation pattern:

```
Container sends:  { type: 'worker.delegate', id: 'abc', payload: { ... } }
Host processes, then replies:
Host sends:       { type: 'worker.result', id: 'xyz', replyTo: 'abc', payload: { status, result } }
```

The container's `ConduitClient.request()` method sends a frame and returns a promise that resolves when the reply arrives. No polling, no result files.

| Request (Container → Host) | Response (Host → Container) |
|---|---|
| `worker.delegate` | `worker.result` |
| `agent.send` | `agent.result` |
| `email.check` | `email.result` |
| `email.read` | `email.result` |
| `workflow.create/update/delete/validate/clone/schema` | `workflow.result` |

## 5. Component Architecture

```
src/conduit/
├── codec.ts                    # Frame encode/decode (shared)
├── types.ts                    # Frame types, payload schemas
├── server.ts                   # ConduitServer (host-side, single TCP port)
├── connection.ts               # ConduitConnection (per-container)
└── handlers/                   # Typed command handlers
    ├── registry.ts             # Handler registration + dispatch
    ├── message-outbound.ts     # message.outbound → bus emit
    ├── task-schedule.ts        # task.schedule → DB create
    ├── task-lifecycle.ts       # task.pause/resume/cancel
    ├── group-admin.ts          # group.refresh, group.register
    ├── worker-delegate.ts      # worker.delegate → spawn worker
    ├── agent-send.ts           # agent.send → spawn agent
    ├── workflow-runtime.ts     # workflow.run/pause/cancel
    ├── workflow-builder.ts     # workflow CRUD
    ├── integration-admin.ts    # integration + MCP server management
    └── email.ts                # email.check, email.read
```

```
agent-runner/src/
├── conduit-client.ts           # ConduitClient (replaces IpcChannel)
├── conduit-query-bridge.ts     # Replaces ipc-query-bridge.ts
└── conduit-mcp-stdio.ts        # Replaces ipc-mcp-stdio.ts
```

### 5.1 Codec (`src/conduit/codec.ts`)

Shared between host and container. ~80 lines, zero dependencies.

```typescript
const MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB

// Encoder
function encodeFrame(frame: ConduitFrame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf-8');
  if (json.length > MAX_FRAME_SIZE) {
    throw new Error(`Frame exceeds max size: ${json.length} > ${MAX_FRAME_SIZE}`);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
}

// Decoder — stateful accumulator
class FrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): ConduitFrame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: ConduitFrame[] = [];

    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);

      if (length > MAX_FRAME_SIZE) {
        throw new FrameSizeError(length, MAX_FRAME_SIZE);
      }

      if (this.buffer.length < 4 + length) break; // incomplete

      const json = this.buffer.subarray(4, 4 + length).toString('utf-8');
      this.buffer = this.buffer.subarray(4 + length);
      frames.push(JSON.parse(json));
    }

    return frames;
  }

  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}
```

### 5.2 ConduitServer (`src/conduit/server.ts`)

Host-side. Single TCP server replaces `startIpcWatcher()` entirely.

```typescript
class ConduitServer {
  private connections = new Map<string, ConduitConnection>(); // group → connection
  private tcpServer: net.Server;
  private pendingTokens = new Map<string, string>();          // token → group (set at spawn)

  constructor(
    private registry: CommandRegistry,
    private bus: MessageBus,
    private port: number,
  ) {}

  /** Start listening on the conduit port. Called once at app startup. */
  async start(): Promise<void> {
    this.tcpServer = net.createServer((socket) => this.onRawConnection(socket));
    await new Promise<void>((resolve) => {
      this.tcpServer.listen(this.port, '0.0.0.0', resolve);
    });
    logger.info({ port: this.port }, 'Conduit server listening');
  }

  /** Register a token for an upcoming container. Called during spawn. */
  registerToken(group: string, token: string): void {
    this.pendingTokens.set(token, group);
  }

  /** Handle raw TCP connection — wait for handshake. */
  private onRawConnection(socket: net.Socket): void {
    const decoder = new FrameDecoder();
    const timeout = setTimeout(() => {
      logger.warn('Conduit: handshake timeout, closing connection');
      socket.destroy();
    }, 10_000);

    const onData = (chunk: Buffer) => {
      const frames = decoder.push(chunk);
      for (const frame of frames) {
        if (frame.type !== 'handshake') {
          socket.destroy();
          return;
        }
        clearTimeout(timeout);
        socket.removeListener('data', onData);
        this.handleHandshake(frame, socket, decoder);
        return;
      }
    };
    socket.on('data', onData);
  }

  private handleHandshake(frame: ConduitFrame, socket: net.Socket, decoder: FrameDecoder): void {
    const { group, token } = frame.payload as { group: string; token: string };
    const expectedGroup = this.pendingTokens.get(token);

    if (!expectedGroup || expectedGroup !== group) {
      socket.write(encodeFrame({
        type: 'handshake.reject',
        id: uuid(),
        replyTo: frame.id,
        payload: { error: 'Invalid token' },
      }));
      socket.destroy();
      return;
    }

    this.pendingTokens.delete(token);

    // Supersede any existing connection for this group
    const existing = this.connections.get(group);
    if (existing) {
      existing.close('superseded');
    }

    const conn = new ConduitConnection(group, socket, this.registry, decoder);
    this.connections.set(group, conn);

    socket.write(encodeFrame({
      type: 'handshake.ack',
      id: uuid(),
      replyTo: frame.id,
      payload: { ok: true },
    }));

    logger.info({ group }, 'Conduit: container connected');

    socket.on('close', () => {
      if (this.connections.get(group) === conn) {
        this.connections.delete(group);
        logger.info({ group }, 'Conduit: container disconnected');
      }
    });
  }

  /** Send a frame to a specific group's container. */
  send(group: string, frame: ConduitFrame): boolean {
    const conn = this.connections.get(group);
    if (!conn || !conn.isAlive()) return false;
    return conn.send(frame);
  }

  /** Check if a group has an active conduit connection. */
  hasConnection(group: string): boolean {
    const conn = this.connections.get(group);
    return !!conn && conn.isAlive();
  }

  /** Shut down the server and all connections. */
  async shutdown(): Promise<void> {
    for (const conn of this.connections.values()) {
      conn.close('shutdown');
    }
    this.connections.clear();
    await new Promise<void>((resolve) => this.tcpServer.close(() => resolve()));
  }
}
```

### 5.3 ConduitConnection (`src/conduit/connection.ts`)

One per container. Wraps a connected socket with the frame decoder and dispatches to the command registry.

```typescript
class ConduitConnection {
  private pendingReplies = new Map<string, {
    resolve: (frame: ConduitFrame) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    readonly group: string,
    private socket: net.Socket,
    private registry: CommandRegistry,
    private decoder: FrameDecoder,
  ) {
    socket.on('data', (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          this.handleFrame(frame);
        }
      } catch (err) {
        logger.error({ group, err }, 'Conduit: frame decode error, closing connection');
        this.close('decode-error');
      }
    });

    socket.on('error', (err) => {
      logger.error({ group, err }, 'Conduit: socket error');
    });
  }

  private handleFrame(frame: ConduitFrame): void {
    // If this is a reply to a pending request, resolve the promise
    if (frame.replyTo && this.pendingReplies.has(frame.replyTo)) {
      const pending = this.pendingReplies.get(frame.replyTo)!;
      clearTimeout(pending.timer);
      this.pendingReplies.delete(frame.replyTo);
      pending.resolve(frame);
      return;
    }

    // Otherwise dispatch to typed handler
    this.registry.dispatch(frame, this);
  }

  /** Send a frame and await a reply frame. */
  request(frame: ConduitFrame, timeoutMs = 30_000): Promise<ConduitFrame> {
    this.send(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(frame.id);
        reject(new Error(`Conduit request timed out: ${frame.type} (${frame.id})`));
      }, timeoutMs);
      this.pendingReplies.set(frame.id, { resolve, timer });
    });
  }

  /** Reply to a received frame. */
  reply(originalFrame: ConduitFrame, type: string, payload: unknown): void {
    this.send({
      type,
      id: uuid(),
      replyTo: originalFrame.id,
      payload,
    });
  }

  send(frame: ConduitFrame): boolean {
    if (this.socket.destroyed) return false;
    return this.socket.write(encodeFrame(frame));
    // Returns false = backpressure (socket buffer full)
  }

  isAlive(): boolean {
    return !this.socket.destroyed;
  }

  close(reason: string): void {
    logger.debug({ group: this.group, reason }, 'Conduit: closing connection');
    // Reject all pending requests
    for (const [id, pending] of this.pendingReplies) {
      clearTimeout(pending.timer);
      pending.resolve({ type: 'error', id: '', replyTo: id, payload: { error: `Connection closed: ${reason}` } });
    }
    this.pendingReplies.clear();
    this.socket.destroy();
  }
}
```

### 5.4 ConduitClient (`agent-runner/src/conduit-client.ts`)

Container-side. Replaces `IpcChannel` (file polling) and `HeartbeatWriter` (file writes).

```typescript
class ConduitClient {
  private decoder = new FrameDecoder();
  private pendingReplies = new Map<string, { resolve: Function; timer: ReturnType<typeof setTimeout> }>();
  private messageQueue: string[] = [];
  private messageResolve: ((msg: string | null) => void) | null = null;
  private closed = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private phase: HeartbeatPhase = 'starting';
  private queryCount = 0;
  private startedAt = Date.now();

  private constructor(private socket: net.Socket) {
    socket.on('data', (chunk) => {
      try {
        for (const frame of this.decoder.push(chunk)) {
          this.handleFrame(frame);
        }
      } catch {
        this.close();
      }
    });

    socket.on('close', () => {
      this.closed = true;
      // Resolve any pending waitForMessage with null (session ended)
      if (this.messageResolve) {
        this.messageResolve(null);
        this.messageResolve = null;
      }
    });

    socket.on('error', () => { this.closed = true; });
  }

  /**
   * Connect to the conduit server and perform handshake.
   * Retries with exponential backoff (100ms → 3200ms, 6 attempts).
   */
  static async connect(host: string, port: number, group: string, token: string): Promise<ConduitClient> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const socket = await new Promise<net.Socket>((resolve, reject) => {
          const s = net.createConnection(port, host, () => resolve(s));
          s.on('error', reject);
        });

        const client = new ConduitClient(socket);

        // Perform handshake
        const reply = await client.request({
          type: 'handshake',
          id: uuid(),
          payload: { group, token },
        }, 5_000);

        if (reply.type === 'handshake.reject') {
          socket.destroy();
          throw new Error(`Handshake rejected: ${(reply.payload as { error: string }).error}`);
        }

        return client;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
      }
    }
    throw lastError ?? new Error('Conduit connection failed');
  }

  private handleFrame(frame: ConduitFrame): void {
    // Reply correlation
    if (frame.replyTo && this.pendingReplies.has(frame.replyTo)) {
      const pending = this.pendingReplies.get(frame.replyTo)!;
      clearTimeout(pending.timer);
      this.pendingReplies.delete(frame.replyTo);
      pending.resolve(frame);
      return;
    }

    switch (frame.type) {
      case 'message.input':
        this.deliverMessage((frame.payload as { text: string }).text);
        break;
      case 'session.close':
        this.close();
        break;
      case 'ping':
        this.send({
          type: 'pong',
          id: uuid(),
          replyTo: frame.id,
          payload: { timestamp: Date.now() },
        });
        break;
    }
  }

  private deliverMessage(text: string): void {
    if (this.messageResolve) {
      const resolve = this.messageResolve;
      this.messageResolve = null;
      resolve(text);
    } else {
      this.messageQueue.push(text);
    }
  }

  /** Wait for the next inbound message. Returns null on close. */
  waitForMessage(signal?: AbortSignal): Promise<string | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.messageQueue.length > 0) {
      return Promise.resolve(this.messageQueue.shift()!);
    }
    return new Promise((resolve) => {
      this.messageResolve = resolve;
      signal?.addEventListener('abort', () => {
        this.messageResolve = null;
        resolve(null);
      }, { once: true });
    });
  }

  /** Start periodic heartbeat frames (replaces HeartbeatWriter). */
  startHeartbeat(intervalMs = 5000): void {
    this.sendHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), intervalMs);
    this.heartbeatTimer.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.phase = 'shutting-down';
    this.sendHeartbeat();
  }

  private sendHeartbeat(): void {
    this.send({
      type: 'heartbeat',
      id: uuid(),
      payload: {
        phase: this.phase,
        queryCount: this.queryCount,
        uptimeMs: Date.now() - this.startedAt,
      },
    });
  }

  setPhase(phase: HeartbeatPhase): void { this.phase = phase; }
  incrementQueryCount(): void { this.queryCount++; }

  /** Send a frame. */
  send(frame: ConduitFrame): void {
    if (!this.closed) {
      this.socket.write(encodeFrame(frame));
    }
  }

  /** Send and await reply. */
  request(frame: ConduitFrame, timeoutMs = 30_000): Promise<ConduitFrame> {
    this.send(frame);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(frame.id);
        reject(new Error(`Conduit request timed out: ${frame.type}`));
      }, timeoutMs);
      this.pendingReplies.set(frame.id, { resolve, timer });
    });
  }

  /** Send outbound message to user. */
  sendMessage(chatJid: string, text: string): void {
    this.send({ type: 'message.outbound', id: uuid(), payload: { chatJid, text } });
  }

  /** Send output (replaces stdout sentinel markers). */
  sendOutput(output: { status: string; result: string | null; newSessionId?: string; telemetry?: unknown }): void {
    this.send({ type: 'output', id: uuid(), payload: output });
  }

  /** Delegate to a worker and await result. */
  async delegateWorker(workerId: string, prompt: string, context?: string): Promise<ConduitFrame> {
    return this.request({
      type: 'worker.delegate',
      id: uuid(),
      payload: { delegationId: uuid(), workerId, prompt, context },
    });
  }

  isConnected(): boolean { return !this.closed; }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.socket.destroy();
  }
}
```

### 5.5 Command Registry (`src/conduit/handlers/registry.ts`)

Replaces the 1063-line switch statement with typed handler registration.

```typescript
type FrameHandler<T = unknown> = (
  payload: T,
  frame: ConduitFrame<T>,
  connection: ConduitConnection,
  deps: ConduitDeps,
) => void | Promise<void>;

interface RegisteredHandler {
  schema: ZodSchema;          // Runtime validation at boundary
  handler: FrameHandler;
  auth: 'any' | 'main-only' | 'self-or-main';
}

class CommandRegistry {
  private handlers = new Map<string, RegisteredHandler>();

  constructor(private deps: ConduitDeps) {}

  register<T>(
    type: string,
    schema: ZodSchema<T>,
    auth: RegisteredHandler['auth'],
    handler: FrameHandler<T>,
  ): void {
    this.handlers.set(type, { schema, handler: handler as FrameHandler, auth });
  }

  dispatch(frame: ConduitFrame, connection: ConduitConnection): void {
    const registered = this.handlers.get(frame.type);
    if (!registered) {
      logger.warn({ type: frame.type }, 'conduit: unknown frame type');
      return;
    }

    // Authorization check
    const isMain = connection.group === MAIN_GROUP_FOLDER;
    if (registered.auth === 'main-only' && !isMain) {
      logger.warn({ type: frame.type, group: connection.group }, 'conduit: unauthorized');
      connection.reply(frame, 'error', { error: 'Unauthorized: main group only' });
      return;
    }

    // Schema validation at the boundary
    const parsed = registered.schema.safeParse(frame.payload);
    if (!parsed.success) {
      logger.warn({ type: frame.type, errors: parsed.error.issues }, 'conduit: invalid payload');
      connection.reply(frame, 'error', { error: 'Invalid payload', details: parsed.error.issues });
      return;
    }

    // Dispatch to handler
    Promise.resolve(registered.handler(parsed.data, frame, connection, this.deps))
      .catch((err) => {
        logger.error({ type: frame.type, err }, 'conduit: handler error');
        connection.reply(frame, 'error', { error: err instanceof Error ? err.message : String(err) });
      });
  }
}
```

### 5.6 Example Handler (`src/conduit/handlers/task-schedule.ts`)

Each handler is a small, focused module. Compare to the 100-line `case 'schedule_task':` block.

```typescript
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import { TIMEZONE, MAIN_GROUP_FOLDER } from '../../config/config.js';
import { createTask } from '../../db/index.js';
import type { FrameHandler } from './registry.js';

export const ScheduleTaskPayload = z.object({
  prompt: z.string().min(1),
  scheduleType: z.enum(['cron', 'interval', 'once']),
  scheduleValue: z.string().min(1),
  targetJid: z.string().min(1),
  contextMode: z.enum(['group', 'isolated']).default('isolated'),
  agentId: z.string().optional(),
});

export type ScheduleTaskPayload = z.infer<typeof ScheduleTaskPayload>;

export const scheduleTaskHandler: FrameHandler<ScheduleTaskPayload> = (
  payload, frame, connection, deps,
) => {
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[payload.targetJid];

  if (!targetGroup) {
    connection.reply(frame, 'error', { error: 'Target group not registered' });
    return;
  }

  // Auth: non-main can only schedule for self
  const isMain = connection.group === MAIN_GROUP_FOLDER;
  if (!isMain && targetGroup.folder !== connection.group) {
    connection.reply(frame, 'error', { error: 'Unauthorized: can only schedule for own group' });
    return;
  }

  const nextRun = computeNextRun(payload.scheduleType, payload.scheduleValue);
  if (!nextRun) {
    connection.reply(frame, 'error', { error: 'Invalid schedule expression' });
    return;
  }

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createTask({
    id: taskId,
    group_folder: targetGroup.folder,
    chat_jid: payload.targetJid,
    prompt: payload.prompt,
    schedule_type: payload.scheduleType,
    schedule_value: payload.scheduleValue,
    context_mode: payload.contextMode,
    agent_id: payload.agentId || null,
    next_run: nextRun,
    status: 'active',
    created_at: new Date().toISOString(),
  });

  connection.reply(frame, 'task.scheduled', { taskId });
};

function computeNextRun(type: string, value: string): string | null {
  if (type === 'cron') {
    try {
      const interval = CronExpressionParser.parse(value, { tz: TIMEZONE });
      return interval.next().toISOString();
    } catch {
      return null;
    }
  }
  if (type === 'interval') {
    const ms = parseInt(value, 10);
    return isNaN(ms) || ms <= 0 ? null : new Date(Date.now() + ms).toISOString();
  }
  if (type === 'once') {
    const relMatch = value.match(/^\+(\d+)(s|m|h)$/);
    if (relMatch) {
      const amount = parseInt(relMatch[1], 10);
      const multiplier = relMatch[2] === 's' ? 1000 : relMatch[2] === 'm' ? 60_000 : 3_600_000;
      return new Date(Date.now() + amount * multiplier).toISOString();
    }
    let v = value;
    if (!/[Zz]$/.test(v) && !/[+-]\d{2}:\d{2}$/.test(v)) v += 'Z';
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}
```

## 6. Lifecycle Changes

### What's Eliminated

| Current | Why It's Gone |
|---|---|
| `_owner` token file | Handshake token authenticates the connection. One connection = one container. |
| `_heartbeat` file + HeartbeatMonitor | Heartbeat frames over socket. Disconnect = dead. |
| `_close` sentinel file | `session.close` frame over socket. |
| IPC watcher polling loop (host) | Socket `data` event — instant, event-driven. |
| IPC file polling loop (container) | Socket `data` event — instant, event-driven. |
| Error directory (`data/ipc/errors/`) | Schema validation rejects bad frames inline with error replies. |
| Result files (`*-results/*.json`) | Reply frames with `replyTo` correlation. |
| Sentinel markers on stdout | `output` frame over socket. |
| 7 IPC subdirectories per group | No filesystem artifacts. |

### Container Spawn Changes (`runner.ts`)

Before:
```typescript
// Create 7 IPC subdirectories
fs.mkdirSync(path.join(groupIpcDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'tasks'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'input'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'worker-results'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'workflow-results'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'agent-results'), { recursive: true });
fs.mkdirSync(path.join(groupIpcDir, 'context'), { recursive: true });
// Write _owner file
// Pass input via stdin, parse stdout markers
```

After:
```typescript
// Register token with conduit server
const token = `cambot-agent-${safeName}-${Date.now()}`;
conduitServer.registerToken(execution.folder, token);
input.conduitToken = token;
input.conduitPort = CONDUIT_PORT;
// No filesystem setup needed for communication
// Container connects via TCP after startup
```

### Container Args Changes (`runner.ts`)

```typescript
function buildContainerArgs(...): string[] {
  const args: string[] = ['run', '-i', '--rm', '--name', containerName];

  // Linux: add host.docker.internal resolution
  if (process.platform === 'linux') {
    args.push('--add-host=host.docker.internal:host-gateway');
  }

  // ... existing mount args ...
  args.push(containerImage);
  return args;
}
```

### Container Startup Changes (`agent-runner/src/index.ts`)

Before:
```typescript
const ipc = new IpcChannel(paths, logger);
ipc.setOwnerToken(containerInput.ipcToken);
if (!ipc.isStillOwner()) process.exit(0);
ipc.initialize();
const heartbeat = createHeartbeatWriter(paths.heartbeatFile, containerInput.ipcToken || 'unknown');
heartbeat.start();
// ... wire queryRunner with ipc, heartbeat ...
```

After:
```typescript
const conduit = await ConduitClient.connect(
  'host.docker.internal',
  containerInput.conduitPort,
  containerInput.groupFolder,
  containerInput.conduitToken,
);
// Connection success + handshake accepted = we're the active container
// If handshake rejected = orphan → exit
conduit.startHeartbeat();
// ... wire queryRunner with conduit ...
```

### Heartbeat Replacement

Instead of file-based heartbeat with host-side monitor:

1. Container sends `heartbeat` frames at `HEARTBEAT_INTERVAL_MS` (phase, queryCount, uptimeMs)
2. Host sends `ping` frames at the same interval
3. Container replies with `pong`
4. Escalation ladder triggers on missed heartbeats or pongs (same thresholds as current)
5. **TCP disconnect is an additional signal** — if the socket closes, the container is dead. No escalation needed.

### Output Streaming Replacement

Before (stdout sentinel markers):
```
---CAMBOT_AGENT_OUTPUT_START---
{"status":"success","result":"Hello!","telemetry":{...}}
---CAMBOT_AGENT_OUTPUT_END---
```

After (socket frame):
```typescript
conduit.sendOutput({
  status: 'success',
  result: 'Hello!',
  newSessionId: '...',
  telemetry: { ... },
});
```

Host `ConduitConnection` receives the `output` frame and calls the same `onOutput` callback that currently processes parsed sentinel markers. Stdout is freed for SDK debug logging only.

## 7. Bus Integration

### Outbound: Bus → Container

The message router sends frames through the conduit server instead of writing files:

```typescript
// In message-router.ts:
if (conduitServer.hasConnection(group.folder)) {
  conduitServer.send(group.folder, {
    type: 'message.input',
    id: uuid(),
    payload: { text: safeFormatted, chatJid },
  });
  // Update timestamps, emit typing...
} else {
  queue.enqueueMessageCheck(chatJid); // No active container, spawn one
}
```

### Inbound: Container → Bus

The `message.outbound` handler emits an `OutboundMessage` on the bus:

```typescript
// In src/conduit/handlers/message-outbound.ts:
registry.register('message.outbound', MessageOutboundPayload, 'any', (payload, frame, conn, deps) => {
  const isMain = conn.group === MAIN_GROUP_FOLDER;
  const registeredGroups = deps.registeredGroups();
  const targetGroup = registeredGroups[payload.chatJid];

  if (!isMain && (!targetGroup || targetGroup.folder !== conn.group)) {
    conn.reply(frame, 'error', { error: 'Unauthorized: can only send to own JID' });
    return;
  }

  deps.bus.emit(new OutboundMessage('conduit', payload.chatJid, payload.text, { groupFolder: conn.group }));
});
```

## 8. Bus CLI (`scripts/bus-send.ts`)

The bus CLI connects to the same conduit TCP port. It uses a reserved group name (`_bus`) and a static control token from the environment.

```typescript
// scripts/bus-send.ts
const client = await ConduitClient.connect(
  'localhost',
  CONDUIT_PORT,
  '_bus',
  process.env.CONDUIT_CONTROL_TOKEN || 'bus-control',
);

const reply = await client.request({
  type: 'bus.message',
  id: uuid(),
  payload: {
    message: args.message,
    agent: args.agent,
    group: args.group,
  },
});

console.log(JSON.stringify(reply.payload));
client.close();
```

The server recognizes `_bus` as a special group and routes the message through the bus rather than to a container.

## 9. ContainerInput Changes

```typescript
// Added fields:
interface ContainerInput {
  // ... existing fields ...
  conduitPort: number;    // Port to connect to on host.docker.internal
  conduitToken: string;   // Auth token for handshake

  // Removed fields:
  // ipcToken — replaced by conduitToken
}
```

## 10. Files Deleted

These files are fully replaced and should be deleted:

| File | Replacement |
|---|---|
| `src/ipc/watcher.ts` | `src/conduit/server.ts` |
| `src/ipc/task-handler.ts` | `src/conduit/handlers/*` (split into ~12 modules) |
| `src/ipc/message-handler.ts` | `src/conduit/handlers/message-outbound.ts` |
| `src/ipc/result-writers.ts` | Reply frames (no files) |
| `src/ipc/bus-inbound-handler.ts` | Bus CLI connects to conduit port directly |
| `src/ipc/bus-response-router.ts` | Reply frames (no FIFO queues) |
| `src/ipc/email-handler.ts` | `src/conduit/handlers/email.ts` |
| `src/ipc/index.ts` | `src/conduit/index.ts` |
| `src/ipc/ipc-auth.test.ts` | Conduit auth tests |
| `src/ipc/ipc-message-delivery.test.ts` | Conduit delivery tests |
| `agent-runner/src/ipc-channel.ts` | `agent-runner/src/conduit-client.ts` |
| `agent-runner/src/ipc-query-bridge.ts` | `agent-runner/src/conduit-query-bridge.ts` |
| `agent-runner/src/ipc-mcp-stdio.ts` | `agent-runner/src/conduit-mcp-stdio.ts` |
| `agent-runner/src/heartbeat-writer.ts` | Heartbeat frames via conduit |
| `src/container/heartbeat-monitor.ts` | Ping/pong + disconnect detection in `ConduitConnection` |
| `scripts/test-ipc-flow.ts` | Conduit integration test |

## 11. Files Modified

| File | Changes |
|---|---|
| `src/container/runner.ts` | Remove IPC dir creation (7 mkdirs), stdout marker parsing, heartbeat monitor setup. Register conduit token at spawn. Add `--add-host` flag on Linux. Remove `_owner` file write. |
| `src/orchestrator/app.ts` | Replace `startIpcWatcher(deps)` with `conduitServer.start()`. Create `ConduitServer` and `CommandRegistry` during init. |
| `src/orchestrator/message-router.ts` | Replace `queue.sendMessage()` (file write) with `conduitServer.send()` (TCP frame). |
| `src/config/config.ts` | Remove `IPC_POLL_INTERVAL`. Add `CONDUIT_PORT` (default 9500). |
| `src/groups/group-folder.ts` | Remove `resolveGroupIpcPath()`. |
| `src/groups/group-queue.ts` | Remove file-based piping, use conduit server for send. |
| `agent-runner/src/index.ts` | Replace `IpcChannel` + `HeartbeatWriter` with `ConduitClient.connect()`. |
| `agent-runner/src/agent-runner.ts` | Use `ConduitClient` for message waiting. |
| `agent-runner/src/sdk-query-runner.ts` | Use `ConduitClient` for output emission. |
| `agent-runner/src/types.ts` | Remove `IPC_POLL_MS`, `IPC_WAIT_TIMEOUT_MS`, IPC path fields. Add `conduitPort`, `conduitToken`. |
| `agent-runner/src/output-writer.ts` | Send `output` frames via conduit instead of stdout markers. |
| `src/orchestrator/bus-handlers.ts` | Update source strings from `'ipc'` to `'conduit'`. |
| `src/channels/bus.ts` | Connect to conduit port instead of file watching. |
| `scripts/bus-send.ts` | Connect to conduit TCP port instead of writing files. |
| `src/agents/persistent-agent-spawner.ts` | Use `conduitServer.send()` for piping messages. |
| `src/orchestrator/agent-runner.ts` | Update conduit references. |
| `src/container/snapshot-writers.ts` | Update any IPC path references. |
| `src/utils/context-files.ts` | Write context to group session dir instead of IPC context dir. |

## 12. Shared Code Strategy

The `ConduitFrame` types and `codec.ts` must be available to both host (`src/`) and container (`agent-runner/src/`).

Place shared files in `agent-runner/src/conduit/`:
```
agent-runner/src/conduit/
├── codec.ts       # Frame encode/decode
├── types.ts       # ConduitFrame, all payload types
└── schemas.ts     # Zod schemas for validation (host-only, but co-located for coherence)
```

The host already copies `agent-runner/src/` into a per-group mount at spawn time. This is the existing pattern — no workspace config changes needed.

- Host imports: `import { encodeFrame, FrameDecoder } from '../agent-runner/src/conduit/codec.js'`
- Container imports: `import { encodeFrame, FrameDecoder } from './conduit/codec.js'`

## 13. Testing Strategy

### Unit Tests

- **Codec**: Encode/decode round-trip, partial chunks, oversized frames (>16MB rejected), malformed JSON, zero-length payloads, multiple frames in one chunk, frame split across chunks
- **CommandRegistry**: Type dispatch, auth enforcement (`main-only` blocks non-main), schema validation (Zod rejects bad payloads), unknown types logged, handler errors caught
- **Each handler**: Isolated unit test with mocked `ConduitConnection` and `ConduitDeps`. Verify correct bus events emitted, correct reply frames sent, auth enforced.
- **ConduitServer handshake**: Valid token accepted, invalid token rejected, timeout on missing handshake, supersession closes old connection

### Integration Tests

- **Full round-trip**: Create `ConduitServer` on random port → `ConduitClient.connect()` → handshake → send `message.input` → receive `message.outbound` → verify bus event
- **Backpressure**: Flood frames, verify `socket.write()` returns false and frames queue
- **Disconnect detection**: Kill client socket, verify server cleans up connection map
- **Request/reply timeout**: Send request, don't reply, verify timeout error
- **Reconnection**: Disconnect client, reconnect with new token, verify old connection cleaned up

### Smoke Test (end-to-end)

- Start conduit server
- Spawn real Docker container with `--add-host` and conduit port in `ContainerInput`
- Container connects, handshakes, receives `message.input`
- Container processes with Claude SDK, sends `output` frame
- Host receives output, emits `OutboundMessage` on bus
- Verify zero IPC files created anywhere on disk

## 14. Implementation Order

1. **`agent-runner/src/conduit/codec.ts`** + **`types.ts`** — Shared protocol. Unit tests immediately.
2. **`src/conduit/server.ts`** + **`connection.ts`** — Host TCP server with handshake. Integration tests with raw TCP client.
3. **`src/conduit/handlers/registry.ts`** — Command dispatch with auth + Zod validation.
4. **`agent-runner/src/conduit-client.ts`** — Container client with handshake, heartbeat, message waiting.
5. **`src/conduit/handlers/message-outbound.ts`** + **`output` handler** — First handlers: proves the full round-trip works.
6. **Wire into `app.ts` and `runner.ts`** — Replace `startIpcWatcher()`, remove IPC dir creation, register tokens at spawn.
7. **Wire into `agent-runner/src/index.ts`** — Replace `IpcChannel` + `HeartbeatWriter` with `ConduitClient`.
8. **Remaining handlers** — One module per command group (`task-schedule`, `task-lifecycle`, `group-admin`, `worker-delegate`, `agent-send`, `workflow-runtime`, `workflow-builder`, `integration-admin`, `email`).
9. **Bus CLI** — `scripts/bus-send.ts` connects to conduit port.
10. **Delete `src/ipc/`** — Remove all file-based IPC code, update imports across codebase.
11. **Cleanup** — Remove `data/ipc/` references, IPC directory creation in `runner.ts`, update CLAUDE.md and docs.

## 15. Risk Mitigation

| Risk | Mitigation |
|---|---|
| `host.docker.internal` unavailable on Linux | `--add-host=host.docker.internal:host-gateway` in container args. Detect `process.platform === 'linux'` at spawn time. |
| Container connects before server is listening | Exponential backoff in `ConduitClient.connect()` (6 attempts: 100ms → 3200ms). |
| Conduit port conflict | Configurable via `CONDUIT_PORT` env var (default 9500). Fail fast with clear error on `EADDRINUSE`. |
| Socket buffer overflow (backpressure) | `socket.write()` returns false when buffer is full. Implement write queue that drains on `'drain'` event. Log warning when queue depth exceeds threshold. |
| Codec bugs cause silent data loss | Comprehensive codec unit tests. Frame `id` tracking for audit journal. Connection closed on decode error (fail-fast). |
| Container outlives connection | Disconnect event triggers escalation. Container detects socket close and exits gracefully. |
| Network scan finds open port | Token authentication on handshake. Invalid tokens immediately closed. Firewall recommendation in production docs. |
| Token replay attack | Tokens are single-use (deleted from `pendingTokens` map after successful handshake). Tokens include timestamp for uniqueness. |
| Large frames (agent output with full telemetry) | 16 MB max frame size. `FrameSizeError` thrown on oversized frames — connection closed, logged. |
