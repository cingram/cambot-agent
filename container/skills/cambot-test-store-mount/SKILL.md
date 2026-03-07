---
name: cambot-test-store-mount
description: Test that non-main agents have read-only access to the knowledge database at /workspace/project/store/cambot.sqlite. Verifies the store mount is working for all container agents.
allowed-tools: Bash(ls:*), Bash(sqlite3:*), Bash(cat:*), Bash(echo:*), Bash(test:*), Bash(stat:*)
---

# Test Store Mount Access

Verifies that the `store/` directory is mounted read-only at `/workspace/project/store` inside non-main agent containers, giving all agents access to the knowledge database.

## Background

Non-main agents (webchat, email, etc.) don't get the full project root mounted — only main does. The store mount is added separately so all agents can query `cambot.sqlite` for memory, knowledge, and configuration data.

## How to Run

Execute each test below and report results as a table.

## Test Suite 1: Mount Exists

### 1.1 Store directory is mounted

```bash
test -d /workspace/project/store && echo "PASS: /workspace/project/store exists" || echo "FAIL: /workspace/project/store not found"
```

### 1.2 Database file is present

```bash
test -f /workspace/project/store/cambot.sqlite && echo "PASS: cambot.sqlite found" || echo "FAIL: cambot.sqlite not found"
```

### 1.3 Directory listing shows expected files

```bash
ls -la /workspace/project/store/
# EXPECT: cambot.sqlite present, possibly web-auth-token and other store files
```

## Test Suite 2: Read Access

### 2.1 Can open and query the database

```bash
sqlite3 /workspace/project/store/cambot.sqlite ".tables"
# EXPECT: List of tables (registered_agents, agent_templates, messages, etc.)
```

### 2.2 Can read agent_templates

```bash
sqlite3 /workspace/project/store/cambot.sqlite "SELECT name FROM agent_templates LIMIT 5;"
# EXPECT: At least 'identity' and 'soul' template names
```

### 2.3 Can read registered_agents

```bash
sqlite3 /workspace/project/store/cambot.sqlite "SELECT id, name FROM registered_agents LIMIT 5;"
# EXPECT: At least one registered agent row
```

### 2.4 Can read messages table schema

```bash
sqlite3 /workspace/project/store/cambot.sqlite ".schema messages"
# EXPECT: CREATE TABLE statement for messages
```

## Test Suite 3: Read-Only Enforcement

### 3.1 Cannot write to the database

```bash
sqlite3 /workspace/project/store/cambot.sqlite "CREATE TABLE _qa_write_test (id INTEGER);" 2>&1
# EXPECT: Error — "attempt to write a readonly database" or "read-only"
# If this succeeds, the mount is NOT read-only (FAIL)
```

### 3.2 Cannot create files in the store directory

```bash
echo "test" > /workspace/project/store/_qa_test_file 2>&1
# EXPECT: Permission denied or read-only filesystem error
# If this succeeds, the mount is NOT read-only (FAIL)
```

### 3.3 Cannot delete files in the store directory

```bash
rm /workspace/project/store/cambot.sqlite 2>&1
# EXPECT: Permission denied or read-only filesystem error
# If this succeeds, the mount is NOT read-only (CRITICAL FAIL)
```

## Test Suite 4: Main vs Non-Main Detection

### 4.1 Detect which mount path we're using

```bash
# Main agents access store via /workspace/project/store (part of project root mount)
# Non-main agents access it via a dedicated read-only mount at the same path
# Either way, the path should work:
if test -d /workspace/project/src; then
  echo "INFO: Running as main agent (full project root mounted)"
else
  echo "INFO: Running as non-main agent (dedicated store mount)"
fi
test -f /workspace/project/store/cambot.sqlite && echo "PASS: Store accessible regardless of agent type" || echo "FAIL: Store not accessible"
```

## Expected Results

| # | Test | Expected |
|---|------|----------|
| 1.1 | Store dir exists | `/workspace/project/store` is a directory |
| 1.2 | DB file present | `cambot.sqlite` exists |
| 1.3 | Directory listing | Shows store contents |
| 2.1 | Query tables | Returns table list |
| 2.2 | Read templates | Returns identity/soul rows |
| 2.3 | Read agents | Returns agent rows |
| 2.4 | Read schema | Returns CREATE TABLE statement |
| 3.1 | Write blocked | "readonly database" error |
| 3.2 | File create blocked | Permission denied |
| 3.3 | File delete blocked | Permission denied |
| 4.1 | Path works for both | Store accessible from main and non-main |

If tests 3.1–3.3 succeed (write operations work), the mount is NOT read-only — this is a security issue that must be fixed.

If tests 1.x or 2.x fail, the store mount is not working for this agent type.
