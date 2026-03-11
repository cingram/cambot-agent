# Prompt: Add Memory Strategy UI to cambot-core-ui

## Task

Add UI controls for viewing and editing the `memoryStrategy` field on agents. This field already exists on the backend (`cambot-agent`) and is returned in the API response — the UI just doesn't know about it yet.

The memory strategy controls how an agent handles conversation persistence and memory across spawns. There are four modes:

| Mode | Behavior |
|------|----------|
| **ephemeral** | No memory. Starts fresh every time. No conversation rows in DB. |
| **conversation-scoped** | Memory wiped when conversation rotates. Per-agent rotation thresholds. |
| **persistent** | Default. Memory survives rotation. Current behavior for all agents. |
| **long-lived** | Very high rotation threshold (50MB). Agent reads archived transcripts. |

Each mode can optionally have:
- `rotationIdleTimeoutMs` — override idle timeout before rotation (not applicable to ephemeral or long-lived)
- `rotationMaxSizeKb` — override max transcript size before rotation (not applicable to ephemeral)

---

## Backend API Shape

The backend already accepts and returns `memoryStrategy` on agents. No API changes needed.

### GET /api/agents → `RegisteredAgent[]`

Each agent may have:
```typescript
memoryStrategy?: {
  mode: 'ephemeral' | 'conversation-scoped' | 'persistent' | 'long-lived';
  rotationIdleTimeoutMs?: number;
  rotationMaxSizeKb?: number;
}
```

When `memoryStrategy` is `undefined`, the agent uses persistent mode (default).

### PUT /api/agents/:id

Accepts `memoryStrategy` in the update payload. Send the full object (mode + optional overrides) or `undefined` to clear it.

### POST /api/agents

Accepts `memoryStrategy` in the create payload.

**Important**: Changing strategy on a live agent invalidates all sessions and (if switching to ephemeral) deactivates all conversations. The UI should show a warning when changing this field on an existing agent.

---

## Files to Modify

All paths are relative to the `cambot-core-ui` project root.

### 1. `src/lib/types/api/agents.ts` — Add types

Add the `MemoryStrategy` interface and add the field to `RegisteredAgent`, `CreateAgentInput`, and `UpdateAgentInput`:

```typescript
export type MemoryStrategyMode = 'ephemeral' | 'conversation-scoped' | 'persistent' | 'long-lived';

export interface MemoryStrategy {
  mode: MemoryStrategyMode;
  rotationIdleTimeoutMs?: number;
  rotationMaxSizeKb?: number;
}
```

Add to `RegisteredAgent`:
```typescript
memoryStrategy?: MemoryStrategy;
```

Add to `CreateAgentInput`:
```typescript
memoryStrategy?: MemoryStrategy;
```

Add to `UpdateAgentInput`:
```typescript
memoryStrategy?: MemoryStrategy;
```

### 2. `src/lib/constants.ts` — Add memory strategy constants

Add constants for the UI to reference:

```typescript
export const MEMORY_STRATEGY_MODES = [
  {
    value: 'ephemeral',
    label: 'Ephemeral',
    description: 'No memory. Starts fresh every spawn. No conversation history.',
    icon: 'Zap',           // or whatever icon suits — fast/disposable
    color: 'amber',        // warning-ish, stands out
    hasIdleTimeout: false,
    hasMaxSize: false,
  },
  {
    value: 'conversation-scoped',
    label: 'Conversation Scoped',
    description: 'Memory wiped when conversation rotates. Clean breaks between conversations.',
    icon: 'MessageSquare',
    color: 'blue',
    hasIdleTimeout: true,
    hasMaxSize: true,
  },
  {
    value: 'persistent',
    label: 'Persistent',
    description: 'Default. Memory and archives survive rotation.',
    icon: 'Database',
    color: 'cyan',
    hasIdleTimeout: true,
    hasMaxSize: true,
  },
  {
    value: 'long-lived',
    label: 'Long-Lived',
    description: 'Rarely rotates (50MB threshold). Agent reads archived transcripts.',
    icon: 'Clock',
    color: 'emerald',
    hasIdleTimeout: false,
    hasMaxSize: true,
  },
] as const;

export const ROTATION_IDLE_PRESETS = [
  { label: '5m',  ms: 300_000 },
  { label: '30m', ms: 1_800_000 },
  { label: '1h',  ms: 3_600_000 },
  { label: '4h',  ms: 14_400_000 },
  { label: '24h', ms: 86_400_000 },
] as const;

export const ROTATION_SIZE_PRESETS = [
  { label: '100 KB', kb: 100 },
  { label: '500 KB', kb: 500 },
  { label: '2 MB',   kb: 2048 },
  { label: '10 MB',  kb: 10240 },
  { label: '50 MB',  kb: 51200 },
] as const;
```

### 3. `src/app/(app)/agents/_components/shared-form-controls.tsx` — New component

Add a `MemoryStrategySelect` component. This is a radio-card group where each mode is a selectable card showing the mode name, description, and icon. When a mode with `hasIdleTimeout` or `hasMaxSize` is selected, expandable fields appear below:

- **Idle timeout** — reuse the existing `DurationInput` component pattern (number + unit select + preset buttons). Only show when `hasIdleTimeout` is true for the selected mode.
- **Max size** — number input with KB/MB unit toggle + preset buttons from `ROTATION_SIZE_PRESETS`. Only show when `hasMaxSize` is true.

Component signature:
```typescript
interface MemoryStrategySelectProps {
  value: MemoryStrategy | undefined;
  onChange: (strategy: MemoryStrategy | undefined) => void;
  readOnly?: boolean;
  /** Show warning text about session invalidation (for edit mode on existing agents) */
  showChangeWarning?: boolean;
}
```

Design notes:
- When `value` is `undefined`, show "Persistent (default)" as selected — persistent is the implicit default
- The 4 modes should be selectable cards/radio buttons in a 2x2 grid (or 4-column row if space permits)
- Each card: icon + label + short description, cyan border when selected, slate border when not
- Active card should have `bg-cyan-400/10 border-cyan-400/30` styling (match existing patterns)
- Below the card grid, conditionally show the override fields
- When `showChangeWarning` is true and the user changes the mode, show an amber warning: "Changing memory strategy will invalidate all active sessions for this agent."
- Follow the existing dark slate theme: `bg-slate-900`, `text-slate-300`, `border-slate-700`, cyan accents

Read-only display: Show a badge with the mode label + color, and if overrides are set, show them as "Idle timeout: 30m" / "Max size: 500 KB" text below.

### 4. `src/app/(app)/agents/_components/create-agent-dialog.tsx` — Add to create form

Add the memory strategy field to the create dialog.

**Changes:**

1. Add to `CreateDraft` interface:
```typescript
memoryStrategy: MemoryStrategy | undefined;
```

2. Add to `EMPTY_DRAFT`:
```typescript
memoryStrategy: undefined,
```

3. Add to `buildPayload()`:
```typescript
memoryStrategy: draft.memoryStrategy,
```

4. Add a new form section between "Execution" (Section 4) and "Advanced" (Section 5). Use the `FormSection` pattern:
```tsx
<Separator className="bg-slate-700/50" />

{/* ── Section: Memory Strategy ── */}
<FormSection title="Memory Strategy" icon={Brain}>
  <MemoryStrategySelect
    value={draft.memoryStrategy}
    onChange={v => update('memoryStrategy', v)}
  />
</FormSection>
```

The `Brain` icon is already imported. If you want a different icon (e.g. `HardDrive` or `Database`), import it from lucide-react.

### 5. `src/app/(app)/agents/_components/agent-detail-panel.tsx` — Add to edit/view

**Changes to `buildDiff()`:**

Add memory strategy deep comparison (same pattern as `toolPolicy`):
```typescript
if (draft.memoryStrategy !== undefined) {
  const draftJson = JSON.stringify(draft.memoryStrategy);
  const agentJson = JSON.stringify(agent.memoryStrategy);
  if (draftJson !== agentJson) {
    diff.memoryStrategy = draft.memoryStrategy;
    hasDiff = true;
  }
}
```

**Changes to `startEdit` callback:**

Add to the draft initialization:
```typescript
memoryStrategy: agent.memoryStrategy ? { ...agent.memoryStrategy } : undefined,
```

**Changes to `ConfigTab`:**

Add a new `FormSection` in the Config tab, between "Execution" and "Model Parameters":

```tsx
<FormSection title="Memory Strategy" icon={Brain}>
  {editing ? (
    <MemoryStrategySelect
      value={draft.memoryStrategy ?? agent.memoryStrategy}
      onChange={(v) => setDraft((d) => ({ ...d, memoryStrategy: v }))}
      showChangeWarning={true}
    />
  ) : (
    <MemoryStrategySelect
      value={agent.memoryStrategy}
      onChange={() => {}}
      readOnly
    />
  )}
</FormSection>
```

The `Brain` icon is already imported in this file.

### 6. `src/app/(app)/agents/_components/agent-card.tsx` — Show badge on card (optional)

If the agent grid cards currently show status badges, add a small memory strategy badge when the mode is not persistent (since persistent is default and not worth showing):

```tsx
{agent.memoryStrategy && agent.memoryStrategy.mode !== 'persistent' && (
  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-400/10 text-amber-400 border border-amber-400/20">
    {agent.memoryStrategy.mode}
  </span>
)}
```

This is optional but provides useful at-a-glance info.

---

## UI Design Guidance

### Memory Strategy Selector (radio cards)

```
┌──────────────────┐ ┌──────────────────┐
│ ⚡ Ephemeral      │ │ 💬 Conv. Scoped   │
│ No memory.       │ │ Wiped on rotate. │
│ Starts fresh.    │ │                  │
└──────────────────┘ └──────────────────┘
┌──────────────────┐ ┌──────────────────┐
│ 🗄️ Persistent    │ │ 🕐 Long-Lived     │
│ Default.         │ │ Rarely rotates.  │
│ Memory survives. │ │ Reads archives.  │
└──────────────────┘ └──────────────────┘

▼ Rotation Overrides (shown when applicable)
┌────────────────────────────────────────┐
│ Idle Timeout    [  30  ] [minutes ▼]  │
│                 5m  30m  1h  4h  24h  │
│                                        │
│ Max Size        [ 500 ] [KB ▼]        │
│                 100KB 500KB 2MB 50MB  │
└────────────────────────────────────────┘
```

### Read-only display

```
Memory Strategy
┌──────────────────────────────────────┐
│ ⚡ Ephemeral                          │
│ No memory. Starts fresh every spawn. │
└──────────────────────────────────────┘
```

Or for modes with overrides:
```
Memory Strategy
┌──────────────────────────────────────┐
│ 💬 Conversation Scoped               │
│ Idle timeout: 30 minutes             │
│ Max size: 500 KB                     │
└──────────────────────────────────────┘
```

### Change warning (edit mode only)

When user changes the memory strategy mode on an existing agent, show:
```
⚠️ Changing memory strategy will invalidate all active sessions for this agent.
   Switching to ephemeral will also deactivate all conversations.
```

Style: `bg-amber-400/10 border border-amber-400/20 text-amber-400 text-xs rounded-md px-3 py-2`

---

## Styling Reference (from existing codebase)

- Background: `bg-slate-900`, `bg-slate-800/50`
- Borders: `border-slate-700`, `border-slate-700/50`
- Text: `text-slate-100` (headings), `text-slate-300` (body), `text-slate-400` (labels), `text-slate-500`/`text-slate-600` (hints)
- Accent: `text-cyan-400`, `bg-cyan-400/10`, `border-cyan-400/30`
- Warning: `text-amber-400`, `bg-amber-400/10`, `border-amber-400/20`
- Section labels: `text-[11px] text-slate-500 uppercase tracking-wider font-medium`
- Form inputs: `h-8 text-sm` for small inputs
- Cards when selected: `bg-cyan-400/10 border-cyan-400/30 text-cyan-400`
- Cards when unselected: `bg-slate-800/50 border-slate-700 text-slate-400 hover:border-slate-600`

---

## Existing Patterns to Follow

1. **FormSection + FormField** — all form groups use these wrappers from `shared-form-controls.tsx`
2. **DurationInput** — already exists for timeout fields. Reuse for `rotationIdleTimeoutMs`
3. **Preset buttons** — see `TIMEOUT_PRESETS` pattern for quick-select buttons
4. **Deep diff for objects** — see `toolPolicy` handling in `buildDiff()` for the JSON.stringify comparison pattern
5. **Read-only vs edit mode** — every field has `{editing ? <Input .../> : <span .../>}` pattern
6. **Draft initialization** — `startEdit()` copies all agent fields into draft state with spread
7. **Import pattern** — components import from `@/lib/constants`, `@/lib/types/api`, `@/components/ui/*`

---

## Testing

After implementation, verify:

1. **Create dialog**: Can select each of the 4 modes, override fields show/hide correctly, payload includes `memoryStrategy`
2. **Detail panel (read-only)**: Shows current strategy with badge + overrides
3. **Detail panel (edit mode)**: Can change strategy, dirty state detected, diff sent correctly
4. **Default behavior**: Agent with no `memoryStrategy` shows "Persistent (default)"
5. **Change warning**: Amber warning appears when changing mode in edit mode
6. **Payload correctness**: Inspect network tab — PUT should send `{ memoryStrategy: { mode: "ephemeral" } }` etc.
