type MemoryMode = 'markdown' | 'database' | 'both';
type MemoryStrategyMode = 'ephemeral' | 'conversation-scoped' | 'persistent' | 'long-lived';

const DATABASE_INSTRUCTIONS = `
## Knowledge Database (Read-Only)

You have access to a SQLite knowledge base at \`/workspace/project/store/cambot.sqlite\`.
Query it to recall stored knowledge before answering questions about people, events, or facts.

### Schema

- \`facts(id, content, type, confidence, source_file, fact_date, is_active)\`
- \`entities(id, canonical, display, type, description)\`
- \`entity_aliases(entity_id, alias)\`
- \`entity_facts(entity_id, fact_id, role)\`
- \`opinion_history(fact_id, confidence, delta, evidence, recorded_at)\`
- \`facts_fts\` — FTS5 virtual table on \`facts.content\` (porter stemming, unicode)

### Example Queries

**Full-text search** (Google-style, supports stemming):
\`\`\`sql
SELECT f.id, f.content, f.confidence
FROM facts_fts fts
JOIN facts f ON f.id = fts.rowid
WHERE fts.content MATCH 'birthday party'
  AND f.is_active = 1
ORDER BY rank;
\`\`\`

**List entities by type:**
\`\`\`sql
SELECT display, type, description FROM entities WHERE type = 'person';
\`\`\`

**Facts about a specific entity:**
\`\`\`sql
SELECT f.content, f.type, f.confidence
FROM entity_facts ef
JOIN facts f ON f.id = ef.fact_id
JOIN entities e ON e.id = ef.entity_id
WHERE (e.canonical = 'cameron' OR e.display LIKE '%Cameron%')
  AND f.is_active = 1;
\`\`\`

When the user asks about people, events, preferences, or personal details, query this database first rather than guessing. The database contains all learned facts.

This database is **read-only**. Use \`sqlite3\` via Bash to query it.
`;

const MARKDOWN_INSTRUCTIONS = `
## Markdown Memory

Use \`memory.md\` in your working directory for personal notes and preferences.
Use \`conversations/\` for conversation history.
Create topic-specific files for structured data and split large files to stay organized.
`;

const EPHEMERAL_INSTRUCTIONS = `
## Memory

No persistent memory. Each conversation starts fresh. Do not save notes or reference past conversations.
`;

const CONVERSATION_SCOPED_INSTRUCTIONS = `
## Memory

Memory is scoped to this conversation. Use \`memory.md\` in your working directory for notes within this conversation. It will be cleared when the conversation ends.
`;

const LONG_LIVED_INSTRUCTIONS = `
## Memory

Long-term persistent memory. Your conversations rarely rotate. Reference the \`conversations/\` directory for archived conversation history when you need context from past interactions.

Use \`memory.md\` in your working directory for persistent notes and preferences.
`;

/**
 * Get memory system instructions based on mode and optional strategy.
 * When a strategyMode is provided, it overrides the default behavior.
 */
export function getMemoryInstructions(mode: MemoryMode, strategyMode?: MemoryStrategyMode): string | null {
  // Strategy-specific instructions take precedence
  if (strategyMode && strategyMode !== 'persistent') {
    switch (strategyMode) {
      case 'ephemeral':
        return EPHEMERAL_INSTRUCTIONS.trim();
      case 'conversation-scoped':
        return CONVERSATION_SCOPED_INSTRUCTIONS.trim();
      case 'long-lived':
        return LONG_LIVED_INSTRUCTIONS.trim();
    }
  }

  // Default: use memoryMode-based instructions (persistent behavior)
  switch (mode) {
    case 'database':
      return DATABASE_INSTRUCTIONS.trim();
    case 'markdown':
      return MARKDOWN_INSTRUCTIONS.trim();
    case 'both':
      return (DATABASE_INSTRUCTIONS + '\n' + MARKDOWN_INSTRUCTIONS).trim();
    default:
      return null;
  }
}
