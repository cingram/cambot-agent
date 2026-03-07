---
name: cambot-test-agents
description: Run QA tests against the CamBot agent provisioning system. Tests auto-provisioning, DB-driven inheritance, provider hooks, and edge cases. Use when you need to verify agent creation is working correctly.
allowed-tools: Bash(curl:*), Bash(echo:*), Bash(cat:*)
---

# Test CamBot Agent Creation

Run a comprehensive QA suite against the agent provisioning API to verify agents are fully DB-driven, auto-provisioned on demand, and inherit the CamBot persona correctly.

## Prerequisites

- CamBot server running (default: http://localhost:3100)
- Auth token available at `store/web-auth-token` (auto-generated on first boot)

## How to run

Read the auth token, then run each test suite below. Report results as a table.

```bash
# Read auth token
TOKEN=$(cat /workspace/project/store/web-auth-token 2>/dev/null || cat store/web-auth-token 2>/dev/null)
BASE="http://host.docker.internal:3100"
```

## Test Suite 1: Auto-Provisioning

Tests that agents are created on-demand via `POST /api/agents/provision`.

```bash
# 1.1 — Provision a default agent
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "qa-auto-1"}'
# EXPECT: 201, id="qa-auto-1-agent", provider="claude", systemPrompt=null, soul=null

# 1.2 — Provision with custom provider
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "qa-auto-2", "provider": "openai", "model": "gpt-4o"}'
# EXPECT: 201, provider="openai", model="gpt-4o"

# 1.3 — Duplicate channel rejection
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "qa-auto-1"}'
# EXPECT: 400, error about duplicate

# 1.4 — Missing channel validation
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
# EXPECT: 400, "channel is required"
```

## Test Suite 2: DB-Driven Inheritance

Tests that agents with null persona inherit CamBot identity from templates, while agents with explicit values keep their own.

```bash
# 2.1 — Templates exist
curl -s "$BASE/api/templates" -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, identity and soul templates present with non-empty values

# 2.2 — Default agent has null persona (inherits)
curl -s "$BASE/api/agents/qa-auto-1-agent" -H "Authorization: Bearer $TOKEN"
# EXPECT: systemPrompt=null, soul=null

# 2.3 — Provision with explicit override
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "qa-override", "systemPrompt": "Custom prompt.", "soul": "Custom soul."}'
# EXPECT: 201, systemPrompt="Custom prompt.", soul="Custom soul."

# 2.4 — Full create (pre-defined agent style)
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-predefined",
    "name": "QA Predefined",
    "folder": "qa-predefined",
    "channels": ["qa-pre-ch"],
    "systemPrompt": "Predefined prompt.",
    "soul": "Predefined soul.",
    "concurrency": 2,
    "timeoutMs": 120000
  }'
# EXPECT: 201, all fields match
```

## Test Suite 3: Provider Hooks & Edge Cases

```bash
# 3.1 — Multi-provider provisioning
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "qa-xai", "provider": "xai", "model": "grok-3"}'
# EXPECT: 201, provider="xai", model="grok-3"

# 3.2 — Full create with all custom fields
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-custom-full",
    "name": "QA Custom Full",
    "folder": "qa-custom-full",
    "channels": ["qa-custom-ch"],
    "provider": "openai",
    "model": "gpt-4o",
    "baseUrl": "https://api.example.com/v1",
    "secretKeys": ["CUSTOM_API_KEY"],
    "tools": ["web_search"],
    "temperature": 0.7,
    "maxTokens": 4096
  }'
# EXPECT: 201, all fields persisted

# 3.3 — Special characters in channel name
curl -s -X POST "$BASE/api/agents/provision" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "my.weird_channel!v2"}'
# EXPECT: 201, id sanitized (no dots/underscores/bangs)

# 3.4 — Update preserves provider
curl -s -X PUT "$BASE/api/agents/qa-auto-2-agent" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4-turbo", "temperature": 0.5}'
curl -s "$BASE/api/agents/qa-auto-2-agent" -H "Authorization: Bearer $TOKEN"
# EXPECT: provider still "openai", model changed, temperature=0.5
```

## Cleanup

Delete all test agents after running:

```bash
for id in qa-auto-1-agent qa-auto-2-agent qa-override-agent qa-predefined qa-xai-agent qa-custom-full my-weird-channel-v2-agent; do
  curl -s -X DELETE "$BASE/api/agents/$id" -H "Authorization: Bearer $TOKEN"
done

# Verify
curl -s "$BASE/api/agents" -H "Authorization: Bearer $TOKEN" | grep -o '"qa-[^"]*"' || echo "All test agents cleaned up"
```

## Expected Results

| Suite | Tests | Expected |
|-------|-------|----------|
| Auto-Provisioning | 4 | All pass: create, custom provider, duplicate rejection, validation |
| Inheritance | 4 | All pass: templates exist, null=inherits, override persists, full create |
| Provider & Edge | 4 | All pass: multi-provider, custom fields, sanitization, update preserves |

If any test fails, report the HTTP status code and response body for investigation.
