# CamBot-Agent

Personal Claude assistant. See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions. See [docs/CUSTOM-AGENTS.md](docs/CUSTOM-AGENTS.md) for multi-provider custom agents.

## Quick Context

Single Node.js process that connects to channels (WhatsApp, email, web, CLI), routes messages via a reactive event bus to Claude Agent SDK running in containers (Linux VMs). Each group has isolated filesystem and memory. See [docs/BUS-ARCHITECTURE.md](docs/BUS-ARCHITECTURE.md) for the definitive bus reference.

## Key Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Entry point (~15 lines, boots CamBotApp) |
| `src/orchestrator/app.ts` | CamBotApp facade: init sequence, shutdown, wiring |
| `src/bus/create-app-bus.ts` | Bus composition root: middleware wiring |
| `src/orchestrator/message-router.ts` | Reactive bus handler: routes messages to containers |
| `src/orchestrator/bus-handlers.ts` | Core handlers: storage, delivery, audit |
| `src/channels/whatsapp.ts` | WhatsApp connection, auth, send/receive |
| `src/ipc/watcher.ts` | IPC watcher polling loop |
| `src/ipc/task-handler.ts` | IPC task processing (schedule, workflows, agents) |
| `src/config/config.ts` | Trigger pattern, paths, intervals |
| `src/container/runner.ts` | Spawns agent containers with mounts |
| `src/scheduling/task-scheduler.ts` | Runs scheduled tasks |
| `src/db/` | SQLite repositories (chat, message, task, group, session, etc.) |
| `groups/{name}/CLAUDE.md` | Per-group memory (isolated) |
| `src/utils/workspace-mcp-service.ts` | Google Workspace MCP process manager |
| `src/channels/email.ts` | Email channel (Gmail polling + reply) |
| `agent-runner/src/index.ts` | In-container agent loop: Claude Agent SDK, IPC input polling |
| `container/skills/agent-browser.md` | Browser automation tool (available to all agents via Bash) |

## Skills

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |

## Development

Run commands directly—don't tell the user to run them.

```bash
npm run dev          # Run with hot reload
npm run build        # Compile TypeScript
./container/build.sh # Rebuild agent container
```

Service management:
```bash
# macOS (launchd)
launchctl load ~/Library/LaunchAgents/com.cambot-agent.plist
launchctl unload ~/Library/LaunchAgents/com.cambot-agent.plist
launchctl kickstart -k gui/$(id -u)/com.cambot-agent  # restart

# Linux (systemd)
systemctl --user start cambot-agent
systemctl --user stop cambot-agent
systemctl --user restart cambot-agent
```

## Additional Mounts (Giving Agents Access to Host Directories)

Mounting a host directory into agent containers requires configuration in **two places**:

### 1. Mount Allowlist (security gate)

File: `~/.config/cambot-agent/mount-allowlist.json`

This file lives outside the project root and is never mounted into containers, so agents cannot modify it. All additional mounts must be under an allowed root.

```json
{
  "allowedRoots": [
    {
      "path": "C:/cambot-folder",
      "allowReadWrite": true,
      "description": "Shared folder for agent access"
    }
  ],
  "blockedPatterns": [],
  "nonMainReadOnly": true
}
```

- `allowedRoots`: directories agents are allowed to access
- `allowReadWrite`: `false` forces read-only regardless of group config
- `nonMainReadOnly`: when `true`, non-main groups get read-only even if the root allows read-write
- `blockedPatterns`: additional path patterns to block (merged with built-in list: `.ssh`, `.env`, credentials, etc.)

### 2. Group Container Config (per-group mount assignment)

Stored in the `registered_groups` table in `store/cambot.sqlite` as the `container_config` JSON column.

```sql
UPDATE registered_groups
SET container_config = json('{"additionalMounts":[{"hostPath":"C:/cambot-folder","containerPath":"cambot-folder","readonly":false}]}')
WHERE jid = 'web:ui';
```

- `hostPath`: absolute path on the host
- `containerPath`: relative name (mounted at `/workspace/extra/{containerPath}` in the container)
- `readonly`: requested access level (may be overridden by allowlist)

The agent can also configure this through the `register_group` IPC command or by editing its group's config.

### After changing mount config

Restart the agent. The next container spawn will pick up the new mounts.

## Google Workspace Integration

CamBot integrates with Google Workspace (Gmail, Calendar, Tasks, Drive, Docs, Sheets) via the [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp) server.

### Architecture

- **Host-side**: `workspace-mcp` runs as a persistent HTTP service on the host, spawned by `src/utils/workspace-mcp-service.ts`
- **Container access**: Docker containers connect via `http://host.docker.internal:{port}/mcp` using the Claude Agent SDK's native `type: "http"` MCP support
- **No Docker changes**: Python/uv are only on the host — no changes to the container image
- **Email channel**: `src/channels/email.ts` polls Gmail via workspace-mcp and emits events to the bus; the persistent `email-agent` handles them

### Key files

| File | Purpose |
|------|---------|
| `src/utils/workspace-mcp-service.ts` | Host-side process manager for workspace-mcp |
| `src/channels/email.ts` | Email channel (Gmail polling + reply) |
| `groups/email-agent/CLAUDE.md` | Persistent email agent instructions |

### Configuration

Set in `.env`:
```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
USER_GOOGLE_EMAIL=...
WORKSPACE_MCP_PORT=8000  # optional, default 8000
```

First-time OAuth requires interactive browser consent — run `bun run dev` and follow the browser prompt.

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.
