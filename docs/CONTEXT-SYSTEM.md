# Context System

How CamBot builds and injects context into the agent's system prompt.

## Overview

Every time a container spawns, the agent receives a structured system prompt assembled from multiple sources. The flow has two phases:

1. **Host-side** — The orchestrator generates context files before spawning the container
2. **Container-side** — The agent-runner assembles those files into a single `<cambot-context>` block appended to the Claude Code base prompt

```
Host (orchestrator)                     Container (agent-runner)
───────────────────                     ───────────────────────
writeContextFiles()                     ContextBuilder.build()
  │                                       │
  ├─ copies SOUL.md from groups/global/   ├─ reads global CLAUDE.md (non-main only)
  ├─ generates TOOLS.md                   ├─ generates memory instructions
  ├─ generates AGENTS.md                  ├─ reads all .md files from context dir
  ├─ generates HEARTBEAT.md               └─ wraps everything in <cambot-context>
  └─ generates CHANNELS.md                     │
       │                                       ▼
       ▼                                  SDK query() with systemPrompt:
  data/ipc/{group}/context/                 preset: claude_code
    01-SOUL.md                              append: <cambot-context>...</cambot-context>
    02-USER.md
    03-TOOLS.md
    04-AGENTS.md
    05-HEARTBEAT.md
    06-CHANNELS.md
```

## Source Files

### groups/global/ (static source files)

These are the only hand-authored context files. They live in `groups/global/` and apply to all groups.

| File | Purpose | Injected As |
|------|---------|-------------|
| `CLAUDE.md` | Agent identity, capabilities, formatting rules, communication guidelines | `## Identity` section (non-main groups only; main groups use their per-group CLAUDE.md via Claude SDK) |
| `SOUL.md` | Core personality, values, tone, behavioral boundaries — *who* the agent is | `01-SOUL.md` (all groups) |

**Main vs non-main group distinction:**
- **Main group**: Claude SDK auto-loads `CLAUDE.md` from the group's own directory (`/workspace/group/CLAUDE.md`). The global `CLAUDE.md` is injected only via the `## Identity` section for non-main groups.
- **All groups**: `SOUL.md` is always copied from `groups/global/` regardless of main/non-main status.

### container/CLAUDE.md (sandbox rules)

Copied into each group's `.claude/` session directory before container spawn. Claude SDK loads this as the project-level `CLAUDE.md` inside the container. Contains sandbox rules (filesystem boundaries, code quality, output format).

**Source:** `container/CLAUDE.md`
**Destination:** `data/sessions/{group}/.claude/CLAUDE.md`
**Loaded by:** Claude SDK (automatic, via `settingSources: ['project', 'user']`)

### container/mcp-servers.json (MCP template)

Template for MCP server configuration inside containers. Uses `${VARIABLE}` placeholders resolved at runtime by `agent-runner/src/mcp-config.ts`.

**Variables:**
| Variable | Value |
|----------|-------|
| `${SCRIPT_DIR}` | Directory containing compiled agent-runner scripts |
| `${CHAT_JID}` | Current chat's JID (e.g., `12345@s.whatsapp.net`) |
| `${GROUP_FOLDER}` | Group folder name |
| `${IS_MAIN}` | `1` or `0` |

Dynamic HTTP MCP servers (e.g., Google Workspace) are merged at runtime from the host's integration manager.

## Generated Context Files

Written by `src/utils/context-files.ts` into `data/ipc/{group}/context/` before each container spawn.

| File | Source | Content |
|------|--------|---------|
| `01-SOUL.md` | Static copy from `groups/global/SOUL.md` | Personality, values, tone |
| `02-USER.md` | Empty placeholder | Reserved; agent queries the memory DB on demand |
| `03-TOOLS.md` | Generated from `ContextFileDeps` | Available MCP tools, workflow-builder tools, skills list |
| `04-AGENTS.md` | Generated from `customAgents` DB rows | Custom agent registry (name, provider, model, trigger) |
| `05-HEARTBEAT.md` | Generated from `tasks` + `workflows` | Active scheduled tasks, workflow schedules |
| `06-CHANNELS.md` | Generated from `chatJid` + `getChats()` | Current channel, all known chats grouped by channel type |

Files are numbered to control injection order. Empty files are skipped by the assembler.

## Assembly Pipeline

### 1. Host: writeContextFiles()

**File:** `src/utils/context-files.ts`
**Called from:** `src/orchestrator/agent-runner.ts` (before container spawn)

Generates the numbered `.md` files into `data/ipc/{group}/context/`. Static files are copied from `groups/global/`; dynamic files are built from database state and runtime config.

### 2. Host: Template sync

**File:** `src/container/runner.ts`

Before spawning Docker, copies `container/CLAUDE.md` and resolved `mcp-servers.json` into the group's session directory (`data/sessions/{group}/.claude/`).

### 3. Container: ContextBuilder.build()

**File:** `agent-runner/src/context-builder.ts`

Runs inside the container at query time:

1. Reads `groups/global/CLAUDE.md` (non-main only, from `/workspace/global/CLAUDE.md`)
2. Generates memory instructions based on `MEMORY_MODE` env var (`markdown` | `database` | `both`)
3. Reads all `.md` files from `/workspace/ipc/context/` (sorted alphabetically = numbered order)
4. Passes everything to `buildCambotContext()`

### 4. Container: buildCambotContext()

**File:** `agent-runner/src/context-assembler.ts`

Wraps all sections into a single XML block:

```xml
<cambot-context>
# CamBot System Context

## Identity
{contents of global CLAUDE.md — non-main only}

## Memory
{memory instructions based on MEMORY_MODE}

{contents of 01-SOUL.md}
{contents of 03-TOOLS.md}
{contents of 04-AGENTS.md}
{contents of 05-HEARTBEAT.md}
{contents of 06-CHANNELS.md}
</cambot-context>
```

### 5. Container: SDK query()

**File:** `agent-runner/src/sdk-query-runner.ts`

The assembled context is passed to the Claude Agent SDK:

```typescript
systemPrompt: {
  type: 'preset',
  preset: 'claude_code',
  append: assembledContext  // <cambot-context>...</cambot-context>
}
```

This appends the CamBot context after Claude Code's built-in system prompt.

### 6. Container: Debug dump

The assembled system prompt is written to `/workspace/ipc/context-dump.md` for debugging. The host can read this from `data/ipc/{group}/context-dump.md`.

## Memory Context (cambot-core)

The memory system in `cambot-core` provides an additional context layer via hooks:

**File:** `cambot-core/src/hooks/bootstrap-memory-context.ts`

At session bootstrap, this hook:
- Keeps: `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md`, `AGENTS.md`, `HEARTBEAT.md`
- Replaces: `MEMORY.md` with a slim auto-generated memory card (~500-800 tokens)
- The slim card contains: last 3 session summaries + top 25 core facts (ranked by importance × confidence × decay)

## Volume Mounts (Context Paths)

| Host Path | Container Path | Contains |
|-----------|---------------|----------|
| `groups/{folder}/` | `/workspace/group/` | Per-group working directory, per-group CLAUDE.md |
| `groups/global/` | `/workspace/global/` | Shared CLAUDE.md (read by non-main groups) |
| `data/ipc/{folder}/context/` | `/workspace/ipc/context/` | Generated context files (01-06) |
| `data/sessions/{folder}/.claude/` | `/home/node/.claude/` | container CLAUDE.md, MCP config, session data |

## Key Files Reference

| File | Role |
|------|------|
| `groups/global/CLAUDE.md` | Agent identity and capabilities (hand-authored) |
| `groups/global/SOUL.md` | Agent personality and values (hand-authored) |
| `container/CLAUDE.md` | Sandbox rules for containers (hand-authored) |
| `container/mcp-servers.json` | MCP server template (hand-authored) |
| `src/utils/context-files.ts` | Host-side context file generator |
| `agent-runner/src/context-builder.ts` | Container-side context orchestrator |
| `agent-runner/src/context-assembler.ts` | Builds `<cambot-context>` XML wrapper |
| `agent-runner/src/memory-instructions.ts` | Memory mode instructions (database/markdown/both) |
| `agent-runner/src/mcp-config.ts` | MCP template variable resolution |
| `agent-runner/src/types.ts` | `ContainerPaths` with all context-related paths |
| `cambot-core/src/hooks/bootstrap-memory-context.ts` | Slim memory card injection |
