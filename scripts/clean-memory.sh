#!/bin/bash
# ===========================================================================
# Clean memory/knowledge data from cambot.sqlite
# Preserves: agents, groups, tasks, templates, config, credentials
# Removes:  facts, entities, summaries, short-term memory, opinions
# ===========================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DB="${1:-$SCRIPT_DIR/../store/cambot.sqlite}"

if [ ! -f "$DB" ]; then
  echo "Database not found: $DB"
  exit 1
fi

echo "Cleaning memory from: $DB"

# Count before
FACT_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM facts;" 2>/dev/null || echo "?")
ENTITY_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM entities;" 2>/dev/null || echo "?")
echo "  Before: $FACT_COUNT facts, $ENTITY_COUNT entities"

sqlite3 "$DB" <<'SQL'
-- Memory / knowledge
DELETE FROM facts;
DELETE FROM fact_links;
DELETE FROM fact_sources;
DELETE FROM fact_access_log;
DELETE FROM short_term_memory;
DELETE FROM session_summaries;
DELETE FROM reflection_sources;

-- Entities
DELETE FROM entity_facts;
DELETE FROM entities;
DELETE FROM entity_aliases;
DELETE FROM opinion_history;

-- FTS index (rebuild from empty facts table)
INSERT INTO facts_fts(facts_fts) VALUES('rebuild');

-- Vector embeddings
DELETE FROM fact_embeddings;

-- Conversations / sessions (stale without memory context)
DELETE FROM conversations;
DELETE FROM sessions;

-- Message history
DELETE FROM messages;

-- Logs and telemetry (not needed on deploy target)
DELETE FROM agent_messages;
DELETE FROM agent_actions;
DELETE FROM api_calls;
DELETE FROM bus_events;
DELETE FROM tool_invocations;
DELETE FROM cost_ledger;
DELETE FROM task_run_logs;
DELETE FROM security_events;
DELETE FROM logs;
DELETE FROM raw_content;

-- Shrink the file
VACUUM;
SQL

# Count after
FACT_COUNT=$(sqlite3 "$DB" "SELECT COUNT(*) FROM facts;" 2>/dev/null || echo "0")
echo "  After:  $FACT_COUNT facts"
echo ""

# Show what's preserved
echo "Preserved:"
sqlite3 "$DB" <<'SQL'
SELECT '  agents:     ' || COUNT(*) FROM registered_agents;
SELECT '  groups:     ' || COUNT(*) FROM registered_groups;
SELECT '  tasks:      ' || COUNT(*) FROM scheduled_tasks;
SELECT '  templates:  ' || COUNT(*) FROM agent_templates;
SELECT '  credentials:' || COUNT(*) FROM anthropic_credentials;
SQL

echo ""
echo "Done."
