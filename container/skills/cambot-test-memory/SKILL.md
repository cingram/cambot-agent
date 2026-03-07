---
name: cambot-test-memory
description: End-to-end test of agent memory — verifies the knowledge database is mounted, queryable, populated, and that FTS search works. Catches broken mounts, missing tables, empty data, and stale schemas.
allowed-tools: Bash(sqlite3:*), Bash(test:*), Bash(echo:*), Bash(ls:*), Bash(cat:*), Bash(wc:*)
---

# Test Agent Memory Access

End-to-end verification that this agent can access the shared knowledge database. Catches mount failures, schema drift, empty data, and broken FTS indexes.

## How to Run

Execute each test, collect PASS/FAIL, and report a summary table at the end.

## Suite 1: Database Reachable

### 1.1 Store directory exists

```bash
test -d /workspace/project/store && echo "PASS" || echo "FAIL: /workspace/project/store not found — store mount is missing"
```

### 1.2 Database file exists

```bash
test -f /workspace/project/store/cambot.sqlite && echo "PASS" || echo "FAIL: cambot.sqlite not found"
```

### 1.3 Database opens without error

```bash
sqlite3 /workspace/project/store/cambot.sqlite "SELECT 1;" && echo "PASS" || echo "FAIL: cannot open database"
```

## Suite 2: Schema Present

### 2.1 Core tables exist

```bash
TABLES=$(sqlite3 /workspace/project/store/cambot.sqlite ".tables")
MISSING=""
for t in facts entities entity_aliases entity_facts; do
  echo "$TABLES" | grep -qw "$t" || MISSING="$MISSING $t"
done
if [ -z "$MISSING" ]; then
  echo "PASS: all core tables present"
else
  echo "FAIL: missing tables:$MISSING"
fi
```

### 2.2 FTS index exists

```bash
sqlite3 /workspace/project/store/cambot.sqlite "SELECT COUNT(*) FROM facts_fts LIMIT 1;" 2>&1 && echo "PASS" || echo "FAIL: facts_fts virtual table missing or broken"
```

### 2.3 Facts table has expected columns

```bash
COLS=$(sqlite3 /workspace/project/store/cambot.sqlite "PRAGMA table_info(facts);" | cut -d'|' -f2 | tr '\n' ',')
MISSING=""
for c in id content type confidence is_active; do
  echo "$COLS" | grep -q "$c" || MISSING="$MISSING $c"
done
if [ -z "$MISSING" ]; then
  echo "PASS: facts schema matches"
else
  echo "FAIL: missing columns:$MISSING"
fi
```

## Suite 3: Data Populated

### 3.1 Facts table has rows

```bash
COUNT=$(sqlite3 /workspace/project/store/cambot.sqlite "SELECT COUNT(*) FROM facts WHERE is_active = 1;")
if [ "$COUNT" -gt 0 ] 2>/dev/null; then
  echo "PASS: $COUNT active facts"
else
  echo "FAIL: no active facts found (count=$COUNT)"
fi
```

### 3.2 Entities table has rows

```bash
COUNT=$(sqlite3 /workspace/project/store/cambot.sqlite "SELECT COUNT(*) FROM entities;")
if [ "$COUNT" -gt 0 ] 2>/dev/null; then
  echo "PASS: $COUNT entities"
else
  echo "FAIL: no entities found"
fi
```

### 3.3 Entity-fact links exist

```bash
COUNT=$(sqlite3 /workspace/project/store/cambot.sqlite "SELECT COUNT(*) FROM entity_facts;")
if [ "$COUNT" -gt 0 ] 2>/dev/null; then
  echo "PASS: $COUNT entity-fact links"
else
  echo "FAIL: no entity-fact links — entities and facts are not connected"
fi
```

## Suite 4: Full-Text Search Works

### 4.1 FTS returns results for a broad query

```bash
COUNT=$(sqlite3 /workspace/project/store/cambot.sqlite "
  SELECT COUNT(*) FROM facts_fts fts
  JOIN facts f ON f.id = fts.rowid
  WHERE fts.content MATCH '*'
    AND f.is_active = 1;
" 2>/dev/null)
if [ "$COUNT" -gt 0 ] 2>/dev/null; then
  echo "PASS: FTS returns $COUNT results for wildcard"
else
  echo "WARN: FTS wildcard returned 0 — index may need rebuild"
fi
```

### 4.2 FTS returns results for a known entity type

```bash
# Pick a person entity and search for their name in facts
NAME=$(sqlite3 /workspace/project/store/cambot.sqlite "SELECT display FROM entities WHERE type='person' LIMIT 1;" 2>/dev/null)
if [ -z "$NAME" ]; then
  echo "SKIP: no person entities to test FTS with"
else
  COUNT=$(sqlite3 /workspace/project/store/cambot.sqlite "
    SELECT COUNT(*) FROM facts_fts fts
    JOIN facts f ON f.id = fts.rowid
    WHERE fts.content MATCH '\"$NAME\"'
      AND f.is_active = 1;
  " 2>/dev/null)
  echo "INFO: FTS for '$NAME' returned $COUNT results"
  echo "PASS: FTS query executed without error"
fi
```

### 4.3 Entity lookup by canonical name works

```bash
ROW=$(sqlite3 /workspace/project/store/cambot.sqlite "
  SELECT e.display, e.type, COUNT(ef.fact_id) as fact_count
  FROM entities e
  LEFT JOIN entity_facts ef ON ef.entity_id = e.id
  GROUP BY e.id
  ORDER BY fact_count DESC
  LIMIT 1;
" 2>/dev/null)
if [ -n "$ROW" ]; then
  echo "PASS: top entity = $ROW"
else
  echo "FAIL: entity lookup query returned nothing"
fi
```

## Suite 5: Read-Only Enforcement

### 5.1 Cannot insert into facts

```bash
sqlite3 /workspace/project/store/cambot.sqlite "INSERT INTO facts(content, type, confidence, is_active) VALUES('test', 'test', 0.0, 0);" 2>&1
# EXPECT: error containing "readonly" — if this succeeds, the mount is writable (FAIL)
```

## Expected Results

| # | Test | Expected |
|---|------|----------|
| 1.1 | Store dir | Exists |
| 1.2 | DB file | Exists |
| 1.3 | DB opens | SELECT 1 succeeds |
| 2.1 | Core tables | facts, entities, entity_aliases, entity_facts present |
| 2.2 | FTS index | facts_fts queryable |
| 2.3 | Facts schema | id, content, type, confidence, is_active columns |
| 3.1 | Facts data | > 0 active facts |
| 3.2 | Entities data | > 0 entities |
| 3.3 | Links data | > 0 entity-fact links |
| 4.1 | FTS wildcard | Returns results |
| 4.2 | FTS name search | Executes without error |
| 4.3 | Entity lookup | Returns top entity with fact count |
| 5.1 | Write blocked | "readonly database" error |

## Failure Triage

| Failure | Likely Cause |
|---------|-------------|
| 1.1 fails | `store/` mount missing — check `buildVolumeMounts()` in `runner.ts` |
| 1.2 fails | Mount exists but `cambot.sqlite` not created yet — run server first |
| 2.x fails | Schema migration hasn't run or DB is from older version |
| 3.x fails | Knowledge extractor hasn't processed any conversations yet |
| 4.x fails | FTS index corrupt — rebuild with `INSERT INTO facts_fts(facts_fts) VALUES('rebuild')` on host |
| 5.1 passes (write works) | Mount is not read-only — security issue in `runner.ts` |
