---
name: cambot-test-agent-access
description: Test that agent tool policies and MCP server scoping are enforced. Verifies agents must explicitly declare tools and plugins to get access — no policy means no tools.
allowed-tools: Bash(curl:*), Bash(echo:*), Bash(cat:*), Bash(jq:*)
---

# Test Agent Tool & Plugin Access Control

Verifies that the tool policy and MCP server scoping systems are enforced correctly. Agents must explicitly declare their tools and plugins — undeclared means no access.

## Prerequisites

```bash
TOKEN=$(cat /workspace/project/store/web-auth-token 2>/dev/null || cat store/web-auth-token 2>/dev/null)
BASE="http://host.docker.internal:3100"
# For host-side testing:
# BASE="http://localhost:3100"
```

## Access Control Rules Under Test

| Config | Behavior |
|--------|----------|
| `toolPolicy: null` | No SDK tools (Bash, Read, Write, etc.) |
| `toolPolicy: { preset: "full" }` | All 16 SDK tools |
| `toolPolicy: { preset: "readonly" }` | Read, Glob, Grep, WebSearch, WebFetch, ToolSearch, Skill only |
| `toolPolicy: { preset: "full", deny: ["Bash"] }` | All except Bash |
| `toolPolicy: { allow: ["Read", "Grep"] }` | Exactly Read and Grep |
| `mcpServers: []` | No dynamic MCP servers (least privilege) |
| `mcpServers: ["cambot-agent"]` | Only cambot-agent MCP server |

---

## Suite 1: Tool Policy Enforcement

### 1.1 No tool policy = no SDK tools

Create an agent with no toolPolicy. Verify it gets created with `toolPolicy: null`.
This agent would get zero SDK tools inside the container.

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-no-tools",
    "name": "QA No Tools",
    "folder": "qa-no-tools",
    "channels": ["qa-no-tools-ch"]
  }'
# EXPECT: 201
# VERIFY: toolPolicy is null/undefined — agent gets NO SDK tools
# This is the "least privilege" default. Agents must opt-in.
```

### 1.2 Full preset = all SDK tools

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-full-tools",
    "name": "QA Full Tools",
    "folder": "qa-full-tools",
    "channels": ["qa-full-tools-ch"],
    "toolPolicy": {"preset": "full"}
  }'
# EXPECT: 201, toolPolicy = {"preset": "full"}
# RESOLVES TO: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch,
#              Task, TaskOutput, TaskStop, TeamCreate, TeamDelete,
#              SendMessage, TodoWrite, ToolSearch, Skill, NotebookEdit
```

### 1.3 Readonly preset = restricted tools

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-readonly",
    "name": "QA Readonly",
    "folder": "qa-readonly",
    "channels": ["qa-readonly-ch"],
    "toolPolicy": {"preset": "readonly"}
  }'
# EXPECT: 201, toolPolicy = {"preset": "readonly"}
# RESOLVES TO: Read, Glob, Grep, WebSearch, WebFetch, ToolSearch, Skill
# NO: Bash, Write, Edit, Task*, Team*, SendMessage, TodoWrite, NotebookEdit
```

### 1.4 Deny list = subtract from preset

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-deny-bash",
    "name": "QA Deny Bash",
    "folder": "qa-deny-bash",
    "channels": ["qa-deny-bash-ch"],
    "toolPolicy": {"preset": "full", "deny": ["Bash", "WebSearch"]}
  }'
# EXPECT: 201, toolPolicy = {"preset": "full", "deny": ["Bash", "WebSearch"]}
# RESOLVES TO: All full tools EXCEPT Bash and WebSearch
```

### 1.5 Explicit allow list = only those tools

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-allow-only",
    "name": "QA Allow Only",
    "folder": "qa-allow-only",
    "channels": ["qa-allow-only-ch"],
    "toolPolicy": {"allow": ["Read", "Grep"]}
  }'
# EXPECT: 201, toolPolicy = {"allow": ["Read", "Grep"]}
# RESOLVES TO: Exactly Read and Grep — nothing else
```

### 1.6 Add list = extend a preset

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-add-tools",
    "name": "QA Add Tools",
    "folder": "qa-add-tools",
    "channels": ["qa-add-tools-ch"],
    "toolPolicy": {"preset": "minimal", "add": ["Bash"]}
  }'
# EXPECT: 201, toolPolicy = {"preset": "minimal", "add": ["Bash"]}
# RESOLVES TO: Read, Glob, Grep (minimal) + Bash = 4 tools
```

### 1.7 Auto-provisioned agents get full tools

```bash
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "qa-auto-provision"}'
# EXPECT: 201
#   toolPolicy = {"preset": "full"}
#   mcpServers = ["cambot-agent", "workflow-builder"]
# Auto-provisioned agents get full tools + default MCP servers.
# Pre-defined agents with no toolPolicy/mcpServers get nothing — they must declare.
```

### 1.8 Verify all agents persisted correctly

```bash
curl -s "$BASE/api/agents" -H "Authorization: Bearer $TOKEN"
# Check each qa-* agent has the expected toolPolicy value.
# Map of expected values:
#   qa-no-tools      → null (no tools)
#   qa-full-tools    → {"preset": "full"}
#   qa-readonly      → {"preset": "readonly"}
#   qa-deny-bash     → {"preset": "full", "deny": ["Bash", "WebSearch"]}
#   qa-allow-only    → {"allow": ["Read", "Grep"]}
#   qa-add-tools     → {"preset": "minimal", "add": ["Bash"]}
#   qa-auto-provision-agent → {"preset": "full"}, mcpServers: ["cambot-agent", "workflow-builder"]
```

---

## Suite 2: MCP Server Scoping

### 2.1 Empty mcpServers = no dynamic servers (least privilege)

```bash
curl -s "$BASE/api/agents/qa-no-tools" -H "Authorization: Bearer $TOKEN"
# VERIFY: mcpServers = [] (empty array)
# BEHAVIOR: Agent gets NO dynamic MCP servers from the host.
# Template MCP servers (from container/mcp-servers.json) are still loaded
# from disk, but no host-side dynamic servers are passed in.
# Agents must declare which servers they need — same as toolPolicy.
```

### 2.2 Explicit MCP server list = scoped access

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-scoped-mcp",
    "name": "QA Scoped MCP",
    "folder": "qa-scoped-mcp",
    "channels": ["qa-scoped-mcp-ch"],
    "toolPolicy": {"preset": "full"},
    "mcpServers": ["cambot-agent"]
  }'
# EXPECT: 201, mcpServers = ["cambot-agent"]
# BEHAVIOR: Agent ONLY gets the cambot-agent MCP server.
# No workflow-builder, no google-workspace — even if they're active on the host.
```

### 2.3 Multiple MCP servers

```bash
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-multi-mcp",
    "name": "QA Multi MCP",
    "folder": "qa-multi-mcp",
    "channels": ["qa-multi-mcp-ch"],
    "toolPolicy": {"preset": "full"},
    "mcpServers": ["cambot-agent", "workflow-builder"]
  }'
# EXPECT: 201, mcpServers = ["cambot-agent", "workflow-builder"]
# BEHAVIOR: Agent gets cambot-agent AND workflow-builder, but NOT google-workspace.
```

### 2.4 Update MCP servers after creation

```bash
curl -s -X PUT "$BASE/api/agents/qa-scoped-mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mcpServers": ["cambot-agent", "google-workspace"]}'

curl -s "$BASE/api/agents/qa-scoped-mcp" -H "Authorization: Bearer $TOKEN"
# VERIFY: mcpServers now = ["cambot-agent", "google-workspace"]
# workflow-builder is excluded.
```

---

## Suite 3: Tool Policy Updates

### 3.1 Upgrade from no tools to full

```bash
curl -s -X PUT "$BASE/api/agents/qa-no-tools" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"toolPolicy": {"preset": "full"}}'

curl -s "$BASE/api/agents/qa-no-tools" -H "Authorization: Bearer $TOKEN"
# VERIFY: toolPolicy changed from null to {"preset": "full"}
# Next container spawn will get all SDK tools.
```

### 3.2 Downgrade from full to readonly

```bash
curl -s -X PUT "$BASE/api/agents/qa-full-tools" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"toolPolicy": {"preset": "readonly"}}'

curl -s "$BASE/api/agents/qa-full-tools" -H "Authorization: Bearer $TOKEN"
# VERIFY: toolPolicy changed from {"preset": "full"} to {"preset": "readonly"}
# Agent loses Bash, Write, Edit, etc. on next spawn.
```

### 3.3 Switch to explicit allow list

```bash
curl -s -X PUT "$BASE/api/agents/qa-full-tools" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"toolPolicy": {"allow": ["Bash", "Read"]}}'

curl -s "$BASE/api/agents/qa-full-tools" -H "Authorization: Bearer $TOKEN"
# VERIFY: toolPolicy = {"allow": ["Bash", "Read"]}
# Only Bash and Read — nothing else.
```

---

## Suite 4: Preset Reference (Expected Tool Resolution)

Use this table to verify test results against the tool-policy resolver:

| Preset | Tools |
|--------|-------|
| `full` | Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch, Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage, TodoWrite, ToolSearch, Skill, NotebookEdit |
| `standard` | Same as full minus: TeamCreate, TeamDelete, SendMessage, NotebookEdit |
| `readonly` | Read, Glob, Grep, WebSearch, WebFetch, ToolSearch, Skill |
| `minimal` | Read, Glob, Grep |
| `sandboxed` | Bash, Read, Write, Edit, Glob, Grep, TodoWrite, ToolSearch, Skill |
| `null` (no policy) | *empty* — no SDK tools at all |

---

## Cleanup

```bash
for id in qa-no-tools qa-full-tools qa-readonly qa-deny-bash qa-allow-only qa-add-tools qa-auto-provision-agent qa-scoped-mcp qa-multi-mcp; do
  curl -s -X DELETE "$BASE/api/agents/$id" -H "Authorization: Bearer $TOKEN"
done

# Verify
curl -s "$BASE/api/agents" -H "Authorization: Bearer $TOKEN" | grep -c '"qa-' || echo "All QA agents cleaned up"
```

## Summary

| # | Test | Verifies |
|---|------|----------|
| 1.1 | No toolPolicy | No SDK tools (least privilege) |
| 1.2 | preset: full | All 16 SDK tools |
| 1.3 | preset: readonly | 7 read-only tools |
| 1.4 | deny list | Subtracts from preset |
| 1.5 | allow list | Exactly specified tools |
| 1.6 | add list | Extends a preset |
| 1.7 | Auto-provision | Gets full tools + default MCP servers |
| 1.8 | Persistence | All policies stored in DB |
| 2.1 | Empty mcpServers | No dynamic servers (least privilege) |
| 2.2 | Scoped mcpServers | Only declared servers |
| 2.3 | Multiple mcpServers | Subset of servers |
| 2.4 | Update mcpServers | Changes take effect |
| 3.1 | Upgrade tools | null → full |
| 3.2 | Downgrade tools | full → readonly |
| 3.3 | Switch to allow | Preset → explicit list |
