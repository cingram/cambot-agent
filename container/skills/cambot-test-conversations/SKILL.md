---
name: cambot-test-conversations
description: Run QA tests against the CamBot conversation management system. Tests CRUD, activation/switching, channel isolation, auto-rotation config, and edge cases. Use when you need to verify conversation lifecycle is working correctly.
allowed-tools: Bash(curl:*), Bash(echo:*), Bash(cat:*)
---

# Test CamBot Conversation Management

Run a comprehensive QA suite against the conversation management API to verify conversation CRUD, active switching, per-channel isolation, and rotation readiness.

## Prerequisites

- CamBot server running (default: http://localhost:3100)
- Auth token available at `store/web-auth-token`

## How to run

Read the auth token, then run each test suite below. Report results as a table.

```bash
# Read auth token
TOKEN=$(cat /workspace/project/store/web-auth-token 2>/dev/null || cat store/web-auth-token 2>/dev/null)
BASE="http://host.docker.internal:3100"
```

## Setup: Provision test agents

```bash
# Agent 1 — multi-channel (web + whatsapp)
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-conv-agent",
    "name": "QA Conversation Agent",
    "folder": "qa-conv-agent",
    "channels": ["qa-web", "qa-whatsapp"]
  }'
# EXPECT: 201

# Agent 2 — isolated agent
curl -s -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "qa-conv-agent-2",
    "name": "QA Conversation Agent 2",
    "folder": "qa-conv-agent-2",
    "channels": ["qa-other"]
  }'
# EXPECT: 201
```

## Test Suite 1: Conversation CRUD

### 1.1 — Create first conversation

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "First conversation", "channel": "qa-web"}'
# EXPECT: 201, id present, title="First conversation", isActive=true, channel="qa-web"
# SAVE: CONV1_ID from response .id
```

### 1.2 — List shows one conversation

```bash
curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, conversations array with 1 item, that item isActive=true
```

### 1.3 — Create second conversation on same channel (deactivates first)

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Second conversation", "channel": "qa-web"}'
# EXPECT: 201, isActive=true, channel="qa-web"
# SAVE: CONV2_ID from response .id
```

### 1.4 — List shows two conversations, only second is active

```bash
curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, 2 conversations, exactly 1 has isActive=true (the second one)
```

### 1.5 — Rename a conversation

```bash
curl -s -X PATCH "$BASE/api/agents/qa-conv-agent/conversations/$CONV1_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Renamed first"}'
# EXPECT: 200, success=true
```

### 1.6 — Verify rename persisted

```bash
curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: conversation with CONV1_ID has title="Renamed first"
```

## Test Suite 2: Activation & Switching

### 2.1 — Activate first conversation (switch back)

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations/$CONV1_ID/activate" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, returned conversation has isActive=true, id=CONV1_ID
```

### 2.2 — List confirms switch

```bash
curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: CONV1_ID isActive=true, CONV2_ID isActive=false
```

### 2.3 — Switch back to second

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations/$CONV2_ID/activate" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, CONV2_ID isActive=true
```

### 2.4 — Create third conversation while second is active

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Third conversation", "channel": "qa-web"}'
# EXPECT: 201, third is active, second becomes inactive
# SAVE: CONV3_ID from response .id
```

### 2.5 — Verify only one active per channel

```bash
RESULT=$(curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN")
echo "$RESULT"
# EXPECT: exactly 1 conversation with isActive=true out of 3 total (all on qa-web)
# Count active: echo "$RESULT" | grep -o '"isActive":true' | wc -l → should be 1
```

## Test Suite 3: Channel Isolation

Each channel maintains its own independent active conversation. Creating or switching on one channel must NOT affect another.

### 3.1 — Create conversation on different channel (whatsapp)

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "WhatsApp conv 1", "channel": "qa-whatsapp"}'
# EXPECT: 201, isActive=true, channel="qa-whatsapp"
# SAVE: WA_CONV1_ID from response .id
```

### 3.2 — Web channel active conversation is unchanged

```bash
RESULT=$(curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN")
echo "$RESULT"
# EXPECT: CONV3_ID (qa-web) still isActive=true
# EXPECT: WA_CONV1_ID (qa-whatsapp) also isActive=true
# Two active conversations — one per channel
ACTIVE_COUNT=$(echo "$RESULT" | grep -o '"isActive":true' | wc -l)
echo "Active conversations: $ACTIVE_COUNT"
# EXPECT: 2
```

### 3.3 — Create second whatsapp conversation (deactivates only whatsapp)

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "WhatsApp conv 2", "channel": "qa-whatsapp"}'
# EXPECT: 201, isActive=true
# SAVE: WA_CONV2_ID from response .id
```

### 3.4 — Verify: web still active, only new whatsapp is active

```bash
RESULT=$(curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN")
echo "$RESULT"
# EXPECT: CONV3_ID (qa-web) isActive=true — UNCHANGED
# EXPECT: WA_CONV1_ID (qa-whatsapp) isActive=false — deactivated
# EXPECT: WA_CONV2_ID (qa-whatsapp) isActive=true — new active
# Total active: 2 (one web, one whatsapp)
```

### 3.5 — Switching whatsapp conversation does not affect web

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations/$WA_CONV1_ID/activate" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, WA_CONV1_ID isActive=true

RESULT=$(curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN")
echo "$RESULT"
# EXPECT: CONV3_ID (qa-web) isActive=true — STILL unchanged
# EXPECT: WA_CONV1_ID (qa-whatsapp) isActive=true — switched back
# EXPECT: WA_CONV2_ID (qa-whatsapp) isActive=false — deactivated
```

## Test Suite 4: Cross-Agent Isolation

### 4.1 — Create conversation on second agent

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent-2/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Agent 2 conversation", "channel": "qa-other"}'
# EXPECT: 201
```

### 4.2 — First agent conversations are unaffected

```bash
RESULT=$(curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN")
COUNT=$(echo "$RESULT" | grep -o '"id"' | wc -l)
echo "Agent 1 conversations: $COUNT"
# EXPECT: 5 (3 web + 2 whatsapp)
```

### 4.3 — Second agent has only its own conversation

```bash
curl -s "$BASE/api/agents/qa-conv-agent-2/conversations" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 1 conversation
```

## Test Suite 5: Deletion

### 5.1 — Delete a web conversation

```bash
curl -s -X DELETE "$BASE/api/agents/qa-conv-agent/conversations/$CONV3_ID" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, success=true
```

### 5.2 — List confirms deletion, whatsapp unaffected

```bash
RESULT=$(curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN")
echo "$RESULT"
# EXPECT: 4 total (2 web + 2 whatsapp)
# EXPECT: whatsapp active conversation unchanged
```

### 5.3 — Remaining web conversation can be activated

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations/$CONV1_ID/activate" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 200, isActive=true
```

## Test Suite 6: Edge Cases & Validation

### 6.1 — Conversations for non-existent agent returns 404

```bash
curl -s "$BASE/api/agents/does-not-exist/conversations" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 404, "Agent not found"
```

### 6.2 — Create conversation for non-existent agent returns 404

```bash
curl -s -X POST "$BASE/api/agents/does-not-exist/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"title": "Ghost"}'
# EXPECT: 404, "Agent not found"
```

### 6.3 — Activate non-existent conversation returns error

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations/fake-uuid/activate" \
  -H "Authorization: Bearer $TOKEN"
# EXPECT: 400, error about conversation not found
```

### 6.4 — Rename with empty title returns 400

```bash
SOME_ID=$(curl -s "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
curl -s -X PATCH "$BASE/api/agents/qa-conv-agent/conversations/$SOME_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{}'
# EXPECT: 400, "title is required"
```

### 6.5 — Create conversation with no title defaults to "New conversation"

```bash
curl -s -X POST "$BASE/api/agents/qa-conv-agent/conversations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"channel": "qa-web"}'
# EXPECT: 201, title="New conversation"
```

## Cleanup

Delete all test agents and their conversations:

```bash
for id in qa-conv-agent qa-conv-agent-2; do
  curl -s -X DELETE "$BASE/api/agents/$id" -H "Authorization: Bearer $TOKEN"
done

# Verify cleanup
curl -s "$BASE/api/agents" -H "Authorization: Bearer $TOKEN" | grep -o '"qa-conv[^"]*"' || echo "All test agents cleaned up"
```

## Expected Results

| Suite | Tests | Expected |
|-------|-------|----------|
| CRUD | 6 | Create, list, create-deactivates-same-channel, list-verify, rename, rename-verify |
| Activation | 5 | Switch back, list-verify, switch again, create-deactivates, single-active-per-channel |
| Channel Isolation | 5 | Cross-channel create, both active, deactivate only same channel, verify, cross-channel switch |
| Agent Isolation | 3 | Second agent conversation, first unaffected, second has 1 |
| Deletion | 3 | Delete one, list-verify + whatsapp unaffected, activate remaining |
| Edge Cases | 5 | 404 on missing agent, 404 on create, bad activate, empty rename, default title |

**Total: 27 tests**

If any test fails, report the HTTP status code and response body for investigation.
