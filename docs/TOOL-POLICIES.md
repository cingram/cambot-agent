# Tool Policies

Tool policies control which SDK tools **and** MCP tools each agent can use. Policies are stored in the database — never mounted into containers — so agents cannot modify their own access.

## How It Works

The host resolves the agent's `toolPolicy` JSON into flat tool lists (SDK + MCP) before spawning the container. Inside the container, the Claude SDK runs in `dontAsk` permission mode: listed tools auto-approve, everything else is denied. The agent never sees tools it doesn't have access to.

Default: agents without an explicit policy get `readonly`.

## SDK Tools by Category

### Shell

| Tool | Description |
|------|-------------|
| `Bash` | Execute shell commands |

### Filesystem — Read

| Tool | Description |
|------|-------------|
| `Read` | Read file contents |
| `Glob` | Find files by pattern |
| `Grep` | Search file contents |

### Filesystem — Write

| Tool | Description |
|------|-------------|
| `Write` | Create or overwrite files |
| `Edit` | Make targeted edits to existing files |
| `NotebookEdit` | Edit Jupyter notebook cells |

### Web

| Tool | Description |
|------|-------------|
| `WebSearch` | Search the web |
| `WebFetch` | Fetch a URL |

### Agent Coordination

| Tool | Description |
|------|-------------|
| `Task` | Spawn a background subagent |
| `TaskOutput` | Read subagent output |
| `TaskStop` | Stop a running subagent |
| `TeamCreate` | Create an agent team |
| `TeamDelete` | Delete an agent team |
| `SendMessage` | Send message to another agent in a team |

### Utilities

| Tool | Description |
|------|-------------|
| `TodoWrite` | Create/update a todo list |
| `ToolSearch` | Discover and load deferred tools |
| `Skill` | Invoke a registered skill |

## MCP Tools by Server

### cambot-agent

| Tool | Description |
|------|-------------|
| `send_message` | Send a message to a channel |
| `send_to_agent` | Delegate a task to another agent |
| `check_email` | Check for new emails (via injection scanner) |
| `read_email` | Read email content (via injection scanner) |
| `list_tasks` | List scheduled tasks |
| `schedule_task` | Create a scheduled task |
| `register_group` | Register a new group (admin) |
| `create_custom_agent` | Create a custom agent (admin) |
| `list_custom_agents` | List all custom agents |
| `invoke_custom_agent` | Run a custom agent |
| `update_custom_agent` | Update a custom agent (admin) |
| `delete_custom_agent` | Delete a custom agent (admin) |
| `list_workflows` | List available workflows |
| `run_workflow` | Execute a workflow |
| `create_workflow` | Create a new workflow |
| `update_workflow` | Update an existing workflow |
| `delete_workflow` | Delete a workflow |
| `memory_query` | Query the memory system |
| `memory_confirm` | Confirm a fading memory |
| `memory_correct` | Correct an incorrect memory |
| `memory_fading` | List fading memories for review |

### google-workspace

| Tool | Description |
|------|-------------|
| `send_gmail_message` | Send an email |
| `list_gmail_labels` | List Gmail labels |
| `list_calendar_events` | List calendar events |
| `create_calendar_event` | Create a calendar event |
| `update_calendar_event` | Update a calendar event |
| `list_task_lists` | List task lists |
| `list_tasks` | List tasks in a list |
| `create_task` | Create a task |
| `complete_task` | Mark a task complete |
| `search_drive_files` | Search Google Drive |
| `get_drive_file_content` | Read a Drive file |
| `list_drive_files` | List Drive files |
| `get_doc_content` | Read a Google Doc |
| `create_doc` | Create a Google Doc |
| `get_spreadsheet` | Read a Google Sheet |
| `create_spreadsheet` | Create a Google Sheet |
| `update_spreadsheet_values` | Update Sheet values |

## Presets

| Preset | SDK Tools | MCP Tools |
|--------|-----------|-----------|
| `full` | All 17 | All cambot-agent + workflow + google-workspace |
| `standard` | All minus Team*/SendMessage/NotebookEdit | Most minus agent CRUD, register_group |
| `sandboxed` | Bash,Read,Write,Edit,Glob,Grep,TodoWrite,ToolSearch,Skill | send_message, check/read_email, list_tasks |
| `readonly` | Read,Glob,Grep,WebSearch,WebFetch,ToolSearch,Skill | send_message, check/read_email, list_tasks, list_workflows, list_custom_agents + google read-only |
| `minimal` | Read,Glob,Grep | send_message, list_tasks |
| `gateway` | Read,Glob,Grep | send_message |

## Policy JSON

Stored in the `tool_policy` column of `registered_agents`.

### Preset only

```json
{"preset": "readonly"}
```

### Preset + SDK additions

```json
{"preset": "readonly", "add": ["TodoWrite"]}
```

### Preset + SDK removals

```json
{"preset": "standard", "deny": ["Bash"]}
```

### Explicit SDK allowlist (ignores preset)

```json
{"allow": ["Read", "Glob", "Grep", "Bash"]}
```

### MCP overrides

Add MCP tools on top of preset defaults:
```json
{"preset": "readonly", "mcp": {"add": ["schedule_task"]}}
```

Remove specific MCP tools:
```json
{"preset": "full", "mcp": {"deny": ["send_to_agent"]}}
```

Explicit MCP allowlist (ignores preset MCP defaults):
```json
{"mcp": {"allow": ["send_message", "list_tasks"]}}
```

Gateway preset for web chat frontends:
```json
{"preset": "gateway"}
```

## Resolution Order

### SDK Tools
1. If `allow` is set, use it directly (highest priority)
2. Otherwise, start from `preset` (default: `full`)
3. Remove tools in `deny`
4. Add tools in `add`

### MCP Tools
1. If `mcp.allow` is set, use it directly (highest priority)
2. Otherwise, start from preset's MCP defaults
3. Remove tools in `mcp.deny`
4. Add tools in `mcp.add`
5. **Safety denials applied last** (cannot be overridden)

## Safety Restrictions

These are enforced **after** policy resolution and **cannot** be overridden by any policy:

| Restriction | Reason |
|-------------|--------|
| `search_gmail_messages`, `get_gmail_message` always blocked | Must go through `check_email`/`read_email` IPC (injection scanner) |
| `send_to_agent` blocked for inter-agent targets | Prevents infinite agent→agent loops |
| `register_group`, agent CRUD blocked for non-main agents | Admin tools require main-group privileges |

## CLI Examples

```powershell
# Apply a preset from a file
bun run scripts/bus-send.ts update email-agent --tool-policy @config-examples/policies/readonly.json

# Show resolved SDK + MCP tools for an agent
bun run scripts/bus-send.ts tools email-agent

# List all agents and their policies
bun run scripts/bus-send.ts list

# Create a gateway agent for web chat
bun run scripts/bus-send.ts create web-chat --name "Web Chat" --tool-policy '{"preset":"gateway"}'

# Add schedule_task to a readonly agent
bun run scripts/bus-send.ts update my-agent --tool-policy '{"preset":"readonly","mcp":{"add":["schedule_task"]}}'
```

## Adding a New Tool

### SDK Tool
1. Add the tool name to `ALL_SDK_TOOLS` in `src/tools/tool-policy.ts`
2. Add it to the appropriate presets in `TOOL_PRESETS` (same file)
3. Add it to `DEFAULT_SDK_TOOLS` in `agent-runner/src/sdk-query-runner.ts` if agents without a policy should get it

### MCP Tool
1. Add the tool name to the appropriate constant in `src/tools/tool-policy.ts` (`CAMBOT_MCP_TOOLS`, `GOOGLE_MCP_TOOLS`, etc.)
2. Add it to the appropriate entries in `MCP_PRESETS` (same file)
3. Add it to `TOOL_SERVER_MAP` in `agent-runner/src/mcp-config.ts`
4. If the tool should be safety-blocked, add it to `ALWAYS_BLOCKED_MCP_TOOLS` or `ADMIN_ONLY_MCP_TOOLS`

No DB migration or container rebuild needed unless the tool itself requires agent-runner changes.

## Security Notes

- **Untrusted input channels** (email, web) should use `readonly` or `minimal` — never `full`.
- **Bash** is the highest-risk SDK tool. Only grant it to agents that genuinely need shell access.
- **Agent coordination tools** (Task, TeamCreate, SendMessage) allow an agent to spawn or message other agents. Restrict these to prevent privilege escalation.
- **`send_to_agent`** allows cross-agent delegation. Automatically blocked for inter-agent targets to prevent loops.
- **Gmail read tools** are always blocked at the MCP level. Use `check_email`/`read_email` IPC tools instead, which route through the injection scanner.
- Policy changes take effect on the next container spawn. Existing sessions use the new policy.
- Policies are stored in the host DB only — never mounted into containers, no IPC to modify them.
