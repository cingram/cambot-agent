# Agent Memory Strategy

How CamBot manages per-agent memory persistence and conversation lifecycle.

## Overview

Every agent can declare a `memoryStrategy` that controls how long its conversations last, whether SDK memory persists across spawns, and when rotation occurs. This replaces the one-size-fits-all global memory config with per-agent control.

```
Agent Definition (DB)         Conversation Resolution           Container Spawn
─────────────────────         ──────────────────────            ───────────────
memoryStrategy: {             resolveActiveConversation()       cleanupSdkMemory() (if needed)
  mode: 'ephemeral'     ──►     │                         ──►  memoryStrategy → ContainerInput
  rotationIdleTimeoutMs?        ├─ ephemeral: transient obj     memoryMode derived from strategy
  rotationMaxSizeKb?            ├─ others: DB lookup + rotate   memory-instructions.ts → systemPrompt
}                               └─ returns ConversationResolution
```

Agents without a `memoryStrategy` default to `persistent` — identical to the behavior before this feature existed.

---

## Strategy Modes

| Mode | Session Resume | SDK Memory Persists | Rotation | DB Rows |
|------|---------------|-------------------|----------|---------|
| **ephemeral** | Never | Wiped each spawn | None | None |
| **conversation-scoped** | Within conversation | Wiped on rotation | Per-agent thresholds | Yes |
| **persistent** (default) | Within conversation | Yes | Per-agent thresholds (fallback to global) | Yes |
| **long-lived** | Within conversation | Yes | Very high threshold (50MB) | Yes |

### Ephemeral

The agent starts completely fresh every time. No conversation row is created in the database — `resolveActiveConversation()` returns a transient in-memory object. SDK auto-memory (`MEMORY.md`) is wiped before every spawn. No `sessionId` is ever passed to the container.

Use for: stateless lookup bots, calculators, one-shot tools.

### Conversation-scoped

Normal conversation lifecycle with per-agent rotation thresholds. When rotation occurs, SDK auto-memory is wiped so knowledge doesn't bleed into the next conversation. The agent can use `memory.md` in its workspace for within-conversation notes, but these reset on rotation.

Use for: support agents, session-based assistants, agents that should forget between conversations.

### Persistent (default)

Current behavior, unchanged. SDK memory and conversation archives survive rotation. Per-agent rotation overrides apply if set, otherwise global `CONVERSATION_IDLE_TIMEOUT_MS` and `CONVERSATION_MAX_SIZE_KB` control rotation.

Use for: most agents. This is the zero-config default.

### Long-lived

Rotation threshold is very high (default 50MB via `LONG_LIVED_DEFAULT_MAX_SIZE_KB`) rather than disabled entirely — this prevents unbounded `.jsonl` growth. Idle timeout is disabled. The agent is instructed to reference the `conversations/` directory for historical context from archived transcripts.

Use for: project agents, long-running assistants, agents that need months of context.

---

## Type Definitions

```typescript
// src/types.ts
export type MemoryStrategyMode = 'ephemeral' | 'conversation-scoped' | 'persistent' | 'long-lived';

export interface MemoryStrategy {
  mode: MemoryStrategyMode;
  /** Override idle timeout (ms). Applies to persistent and conversation-scoped. */
  rotationIdleTimeoutMs?: number;
  /** Override max transcript size (KB). Applies to all modes except ephemeral. */
  rotationMaxSizeKb?: number;
}
```

The field lives on `RegisteredAgent`:
```typescript
interface RegisteredAgent {
  // ...existing fields...
  memoryStrategy?: MemoryStrategy; // undefined = 'persistent'
}
```

---

## Conversation Resolution

All pipelines (AgentRunner, PersistentAgentSpawner) call `resolveActiveConversation()` which returns a `ConversationResolution`:

```typescript
interface ConversationResolution {
  conversation: Conversation;
  rotatedFrom?: Conversation;  // set when rotation occurred
  isNew: boolean;              // true if conversation was just created
  isTransient: boolean;        // true for ephemeral (not in DB)
}
```

This tells the caller everything it needs to react:

- **`isTransient`** — skip all session tracking, don't call `setConversationSession()` or `updatePreview()`
- **`rotatedFrom`** — if set and mode is `conversation-scoped`, call `cleanupSdkMemory()`
- **`isNew`** — informational, useful for logging

### Resolution Flow

```
resolveActiveConversation(folder, channel, chatJid, memoryStrategy)
  │
  ├─ ephemeral? → return transient (no DB touch)
  │
  ├─ active conversation exists?
  │   ├─ needs rotation? → deactivate old, create new, return rotatedFrom
  │   └─ no → touch timestamp, return existing
  │
  └─ no active → create new conversation
```

---

## Rotation Thresholds

Rotation is checked on every message. Two conditions trigger it:

1. **Idle timeout** — time since last `updated_at` exceeds threshold
2. **Transcript size** — `.jsonl` file on disk exceeds size threshold

Thresholds are resolved per-mode:

| Mode | Idle Timeout | Max Size |
|------|-------------|----------|
| ephemeral | N/A | N/A |
| conversation-scoped | `rotationIdleTimeoutMs` or global `CONVERSATION_IDLE_TIMEOUT_MS` | `rotationMaxSizeKb` or global `CONVERSATION_MAX_SIZE_KB` |
| persistent | `rotationIdleTimeoutMs` or global `CONVERSATION_IDLE_TIMEOUT_MS` | `rotationMaxSizeKb` or global `CONVERSATION_MAX_SIZE_KB` |
| long-lived | Disabled (`null`) | `rotationMaxSizeKb` or `LONG_LIVED_DEFAULT_MAX_SIZE_KB` (50MB) |

Global defaults from `config.ts`:
- `CONVERSATION_IDLE_TIMEOUT_MS` = 4 hours
- `CONVERSATION_MAX_SIZE_KB` = 500 KB
- `LONG_LIVED_DEFAULT_MAX_SIZE_KB` = 50 MB

---

## SDK Memory Cleanup

SDK auto-memory lives at:
```
data/sessions/{agentFolder}/.claude/projects/-workspace-group/memory/
```

`cleanupSdkMemory(agentFolder)` in `src/utils/memory-cleanup.ts` removes this directory. It is called:

- **Ephemeral**: before every container spawn (in `runner.ts`)
- **Conversation-scoped**: when rotation occurs (in `agent-runner.ts` and `persistent-agent-spawner.ts`)

Persistent and long-lived modes never wipe SDK memory.

---

## Container-Side Instructions

The agent-runner inside the container receives the strategy mode via `ContainerInput.memoryStrategy` and generates mode-specific system prompt instructions:

| Mode | Instructions |
|------|-------------|
| ephemeral | "No persistent memory. Each conversation starts fresh. Do not save notes or reference past conversations." |
| conversation-scoped | "Memory is scoped to this conversation. Use `memory.md` for notes within this conversation. It will be cleared when the conversation ends." |
| persistent | Standard memory instructions (database + markdown based on `MEMORY_MODE`) |
| long-lived | "Long-term persistent memory. Your conversations rarely rotate. Reference `conversations/` directory for archived conversation history." |

This happens in `agent-runner/src/memory-instructions.ts` → called by `agent-runner/src/context-builder.ts`.

---

## Strategy Change Side Effects

When an agent's `memoryStrategy` is updated via the API:

1. **Session invalidation** — all `session_id` values on that agent's conversations are set to `NULL` (forces fresh SDK session on next message)
2. **Ephemeral deactivation** — if switching TO ephemeral, all active conversations for that agent are deactivated (`is_active = 0`)

This is handled in `agent-repository.ts` `update()`.

---

## Data Flow

### Message arrives for an ephemeral agent

```
1. AgentRunner.run() / PersistentAgentSpawner.spawn()
2. Look up agent → memoryStrategy = { mode: 'ephemeral' }
3. resolveActiveConversation() → transient conversation (no DB write)
4. cleanupSdkMemory() wipes memory dir
5. runContainerAgent() with sessionId=undefined, memoryStrategy passed
6. Container receives ContainerInput with memoryStrategy.mode='ephemeral'
7. ContextBuilder generates "no persistent memory" instructions
8. Agent runs with no session resume, no memory
9. Response returned — no session saved, no preview updated
```

### Message arrives for a conversation-scoped agent (with rotation)

```
1. AgentRunner.run() / PersistentAgentSpawner.spawn()
2. Look up agent → memoryStrategy = { mode: 'conversation-scoped', rotationIdleTimeoutMs: 5000 }
3. resolveActiveConversation() → finds active, idle > 5s → rotate
   Returns: { conversation: newConv, rotatedFrom: oldConv, isNew: true, isTransient: false }
4. cleanupSdkMemory() wipes memory dir (because rotatedFrom is set)
5. runContainerAgent() with fresh sessionId=undefined
6. Container runs with scoped memory instructions
7. New session ID saved to new conversation row
```

### Message arrives for a persistent agent (default)

```
1. AgentRunner.run() / PersistentAgentSpawner.spawn()
2. Look up agent → memoryStrategy = undefined (defaults to persistent)
3. resolveActiveConversation() → returns existing active conversation
4. No cleanup
5. runContainerAgent() with existing sessionId → SDK resumes session
6. Normal memory instructions
7. Session continues
```

---

## API Usage

Set via agent CRUD (no new endpoints):

```bash
# Ephemeral
bun run scripts/bus-send.ts create my-bot --memory-strategy ephemeral

# Conversation-scoped with 30min idle timeout
bun run scripts/bus-send.ts create my-bot --memory-strategy conversation-scoped --rotation-idle 1800000

# Long-lived with 100MB size threshold
bun run scripts/bus-send.ts create my-bot --memory-strategy long-lived --rotation-size 102400

# Persistent with custom rotation (or just omit --memory-strategy entirely)
bun run scripts/bus-send.ts create my-bot --memory-strategy persistent --rotation-idle 7200000

# Change strategy on existing agent
bun run scripts/bus-send.ts update my-bot --memory-strategy ephemeral

# Inspect
bun run scripts/bus-send.ts show my-bot
bun run scripts/bus-send.ts convos my-bot --count
bun run scripts/bus-send.ts convos my-bot --active
```

---

## Key Files

| File | Role |
|------|------|
| `src/types.ts` | `MemoryStrategyMode`, `MemoryStrategy` type definitions |
| `src/config/config.ts` | `LONG_LIVED_DEFAULT_MAX_SIZE_KB` constant |
| `src/db/agent-repository.ts` | Stores/retrieves `memoryStrategy` as JSON column |
| `src/db/conversation-repository.ts` | Strategy-aware `resolveActiveConversation()` + rotation logic |
| `src/utils/memory-cleanup.ts` | `cleanupSdkMemory()` — wipes SDK auto-memory directory |
| `src/container/runner.ts` | Ephemeral cleanup before spawn, passes strategy to container |
| `src/orchestrator/agent-runner.ts` | Default pipeline: resolves strategy, handles rotation cleanup |
| `src/agents/persistent-agent-spawner.ts` | Persistent pipeline: same strategy handling |
| `agent-runner/src/types.ts` | Container-side `memoryStrategy` field on `ClaudeContainerInput` |
| `agent-runner/src/memory-instructions.ts` | Mode-specific system prompt instructions |
| `agent-runner/src/context-builder.ts` | Passes strategy mode to instruction generator |
| `scripts/bus-send.ts` | CLI: `--memory-strategy`, `--rotation-idle`, `--rotation-size`, `convos` subcommand |
