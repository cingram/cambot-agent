---
name: workflow-builder
description: Design and build YAML workflows with DAG execution — sequential chains, parallel fan-out/fan-in, conditional branching, scheduling, and policy guardrails.
allowed-tools: mcp__workflow-builder__*
---

# Workflow Builder

## Quick start

```
1. get_workflow_schema          → see available step types, tools, operators
2. validate_workflow { ... }    → dry-run validation (fix violations)
3. create_workflow { ... }      → save the validated workflow
4. run_workflow { workflow_id } → execute it (via cambot-agent MCP)
```

## Step types

### agent
Runs a prompt through a Claude or custom agent container.

```json
{
  "id": "research",
  "type": "agent",
  "name": "Research topic",
  "config": {
    "prompt": "Research the latest developments in {{topic}}. Return a JSON object with { summary, keyFindings, sources }."
  }
}
```

Optional config: `model`, `provider`, `agentId`, `baseUrl`, `systemPrompt`, `tools`, `maxTokens`, `temperature`.

### tool
Executes a registered workflow tool (heartbeat checks, maintenance tasks, URL health, etc.).

```json
{
  "id": "health-check",
  "type": "tool",
  "name": "Check channel health",
  "config": {
    "tool": "heartbeat-channel-check"
  }
}
```

Use `get_workflow_schema` to see available tool names.

### memory
Queries the memory system for relevant facts.

```json
{
  "id": "recall",
  "type": "memory",
  "name": "Recall user preferences",
  "config": {
    "query": "user notification preferences"
  }
}
```

### message
Composes a message via AI and sends it to a channel.

```json
{
  "id": "notify",
  "type": "message",
  "name": "Send summary",
  "config": {
    "instruction": "Write a concise summary of the health check results: {{health-check.data}}",
    "channel": "main"
  },
  "after": ["health-check"]
}
```

Channels: `main` (admin chat), `file` (requires `filePath`), or a channel JID.

### gate
Conditional branch — evaluates conditions on a previous step's output.

```json
{
  "id": "check-alerts",
  "type": "gate",
  "name": "Has alerts?",
  "config": {
    "conditions": [
      { "stepId": "health-check", "field": "data.has_alerts", "operator": "eq", "value": true }
    ]
  },
  "after": ["health-check"]
}
```

Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `exists`.

Steps after a gate only run if the gate passes. Use this for conditional notification, error handling, etc.

### parallel
Marker for steps that run concurrently. Steps with the same `after` dependency run in parallel automatically.

### sync
Wait point — ensures all parallel branches complete before continuing.

```json
{
  "id": "wait-all",
  "type": "sync",
  "name": "Wait for parallel research",
  "after": ["research-a", "research-b", "research-c"]
}
```

## DAG patterns

### Sequential chain
```
step-a → step-b → step-c
```
Each step lists the previous in `after`:
```json
{ "id": "step-b", "after": ["step-a"] }
{ "id": "step-c", "after": ["step-b"] }
```

### Parallel fan-out / fan-in
```
         ┌→ branch-a ─┐
start ──→├→ branch-b ──├→ sync → final
         └→ branch-c ─┘
```
All branches have `after: ["start"]`, sync has `after: ["branch-a", "branch-b", "branch-c"]`.

### Conditional branching
```
check → gate → notify (only if gate passes)
```
The gate step evaluates conditions. Steps after the gate only execute if it passes.

## Template substitution

Reference previous step outputs with `{{stepId.field}}`:

```json
{
  "config": {
    "prompt": "Summarize these findings: {{research.data.keyFindings}}"
  },
  "after": ["research"]
}
```

Nested paths: `{{step.data.items[0].name}}`.

## Policy config

Every workflow requires a policy object:

```json
{
  "policy": {
    "maxCostUsd": 0.50,
    "maxTokens": 100000,
    "maxOutputSizeBytes": 524288,
    "piiAction": "redact",
    "secretPatterns": ["sk-[a-zA-Z0-9]+", "ghp_[a-zA-Z0-9]+"],
    "network": {
      "allowed_domains": ["api.example.com", "*.github.com"],
      "block_paywalled": true
    }
  }
}
```

- `maxCostUsd`: abort if cumulative cost exceeds this
- `maxTokens`: abort if total tokens exceed this
- `piiAction`: `block` rejects the output, `redact` strips PII patterns
- `secretPatterns`: regex patterns matched against step outputs
- `network.allowed_domains`: domains the workflow can access (wildcards OK)

## Scheduling

Add a `schedule` object for automatic execution:

```json
{
  "schedule": {
    "cron": "0 9 * * *",
    "timezone": "America/New_York"
  }
}
```

Common cron patterns:
- `0 9 * * *` — daily at 9am
- `0 */6 * * *` — every 6 hours
- `0 9 * * 1` — every Monday at 9am
- `*/30 * * * *` — every 30 minutes

## Best practices

1. **Focused prompts** — each agent step should have a single clear objective
2. **Realistic budgets** — set `maxCostUsd` based on expected model usage; typical agent steps cost $0.01-0.10
3. **Use gates for error handling** — check step outputs before proceeding
4. **Return JSON from agent steps** — downstream gates can inspect structured fields
5. **Validate first** — always `validate_workflow` before `create_workflow`
6. **Use sync for fan-in** — don't reference parallel branches individually, sync them first

## Common mistakes

- **Missing `after` on gate/sync** — these steps MUST reference the steps they depend on
- **Circular dependencies** — step A after B, B after A (validation catches this)
- **Unreachable gate refs** — gate condition references a step that isn't an ancestor
- **Forgetting policy** — every workflow needs a complete policy object
- **Overly broad network** — prefer specific domains over wildcards

## Full example

```json
{
  "id": "daily-health-check",
  "name": "Daily Health Check",
  "description": "Runs heartbeat checks and notifies if issues found",
  "version": "1.0",
  "schedule": { "cron": "0 9 * * *" },
  "policy": {
    "maxCostUsd": 0.25,
    "maxTokens": 50000,
    "maxOutputSizeBytes": 262144,
    "piiAction": "redact",
    "secretPatterns": [],
    "network": { "allowed_domains": [], "block_paywalled": false }
  },
  "steps": [
    {
      "id": "check",
      "type": "tool",
      "name": "Run health checks",
      "config": { "tool": "heartbeat-channel-check" }
    },
    {
      "id": "gate",
      "type": "gate",
      "name": "Issues found?",
      "config": {
        "conditions": [
          { "stepId": "check", "field": "data.unhealthy", "operator": "gt", "value": 0 }
        ]
      },
      "after": ["check"]
    },
    {
      "id": "notify",
      "type": "message",
      "name": "Alert admin",
      "config": {
        "instruction": "Summarize these health check results and highlight issues: {{check.data}}",
        "channel": "main"
      },
      "after": ["gate"]
    }
  ]
}
```
