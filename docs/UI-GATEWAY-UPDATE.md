# UI Update: System Gateway Agent

## What Changed (Backend)

The gateway router is now a **system agent** — seeded automatically at server startup, protected from deletion, and acting as the default front door for all unclaimed channels.

### New field: `system: boolean` on all agents

Every agent in `GET /api/agents` now includes a `system` field:

```json
{
  "id": "gateway",
  "name": "Gateway Router",
  "description": "Routes incoming messages to specialist agents via lightweight classification. System infrastructure.",
  "system": true,
  "toolPolicy": { "preset": "gateway" },
  "channels": [],
  "capabilities": ["routing", "classification"],
  ...
}
```

- `system: true` — agent is infrastructure, seeded at startup
- `system: false` — normal user-created agent (default)

### Delete protection

- `DELETE /api/agents/gateway` → **403 Forbidden** `{ "error": "Cannot delete system agent \"gateway\"" }`
- Socket `agent.delete { agentId: "gateway" }` → **FORBIDDEN** error
- The repository itself also throws, so all delete paths are protected

### How gateway routing works (for UI context)

The gateway agent **does not claim any channels**. Instead, it's the fallback:

| Scenario | What happens |
|----------|-------------|
| Channel has a direct agent (e.g. `web` → `web-agent`) | Direct agent handles it, gateway not involved |
| Channel has no agent assigned | Gateway classifies the message and delegates to a specialist |

**"Turn off gateway for a channel"** = assign a direct agent to that channel.
**"Turn on gateway for a channel"** = remove the direct agent (or don't create one).

---

## UI Changes Needed

### 1. Agent List — Show system badge

When rendering the agent list, check `agent.system`:

- Show a "System" badge/tag (non-dismissible)
- The gateway agent should be visually distinct — it's infrastructure, not a regular agent
- Consider showing it at the top of the list or in a separate "Infrastructure" section

### 2. Disable delete for system agents

```typescript
// Disable delete button when agent.system === true
const canDelete = !agent.system;
```

Don't show the delete button/option at all, or show it greyed out with a tooltip: "System agents cannot be deleted."

### 3. Agent detail view — Gateway-specific display

When `agent.toolPolicy?.preset === 'gateway'`:

- **Don't show a "Tools" section** — the gateway's tools (`route`, `classify_continuation`) are internal Haiku API schemas, not user-facing SDK/MCP tools. They won't appear in `/api/tools`.
- **Show routing info instead** — e.g. "Routes messages to specialist agents using Haiku classification"
- **Show which channels are using the gateway** — any channel NOT claimed by another agent is implicitly routed through the gateway. You can compute this:

```typescript
// Channels using the gateway = all known channels minus channels claimed by non-gateway agents
const claimedChannels = new Set(agents.filter(a => a.id !== 'gateway').flatMap(a => a.channels));
const gatewayChannels = allChannels.filter(ch => !claimedChannels.has(ch));
```

### 4. Channel assignment UX

The gateway makes channel assignment more meaningful:

- When a channel has **no agent**: show "Routed via Gateway" (with gateway icon)
- When a channel has **a direct agent**: show that agent's name
- Allow users to **assign/unassign** agents to channels — unassigning falls back to gateway automatically

### 5. Agent creation — Don't allow `isSystem` from UI

The `isSystem` field in `CreateAgentInput` is for internal seeding only. The UI should never send `isSystem: true` when creating agents via `POST /api/agents`.

---

## API Response Shape Reference

```typescript
interface Agent {
  id: string;
  name: string;
  description: string;
  folder: string;
  channels: string[];
  mcpServers: string[];
  capabilities: string[];
  concurrency: number;
  timeoutMs: number;
  isMain: boolean;
  system: boolean;              // NEW — true for infrastructure agents
  toolPolicy?: {
    preset: 'full' | 'standard' | 'readonly' | 'minimal' | 'sandboxed' | 'gateway';
    allow?: string[];
    deny?: string[];
    add?: string[];
    mcp?: Record<string, string[]>;
  };
  systemPrompt: string | null;
  soul: string | null;
  provider: string;
  model: string;
  secretKeys: string[];
  tools: string[];
  skills: string[];
  temperature: number | null;
  maxTokens: number | null;
  baseUrl: string | null;
  memoryStrategy?: {
    mode: 'ephemeral' | 'conversation-scoped' | 'persistent' | 'long-lived';
    rotationIdleTimeoutMs?: number;
    rotationMaxSizeKb?: number;
  };
  containerConfig?: object;
  createdAt: string;
  updatedAt: string;
}
```
