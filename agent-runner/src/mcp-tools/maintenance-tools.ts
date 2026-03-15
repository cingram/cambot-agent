/**
 * MCP tool registration: database maintenance (decay, dedup, purge, optimize).
 */
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError, requestWithTimeout } from './helpers.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

export function registerMaintenanceTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'run_maintenance',
    `Run database maintenance on the knowledge base. Performs cleanup, optimization, and deduplication.

Steps (all or selected):
1. fact_decay — Age out stale facts using exponential half-life
2. fact_purge — Remove low-quality facts (scoring-based)
3. entity_dedup — Merge duplicate entities (fuzzy token matching)
4. orphan_cleanup — Remove dangling junction rows for inactive facts
5. hard_delete — Physically remove facts inactive for 30+ days
6. fts_rebuild — Rebuild full-text search index
7. vacuum — Reclaim disk space and update query planner stats
8. backup — Create a SQLite backup (VACUUM INTO), rotates old backups (keeps 7)

Use this tool for periodic database hygiene. Safe to run at any time — it only affects inactive/low-quality data.`,
    {
      steps: z.array(z.enum([
        'fact_decay',
        'fact_purge',
        'entity_dedup',
        'orphan_cleanup',
        'hard_delete',
        'fts_rebuild',
        'vacuum',
        'backup',
      ])).optional().describe('Which steps to run. Omit to run all steps.'),
    },
    async (args) => {
      const result = await requestWithTimeout(ctx.client, {
        type: FRAME_TYPES.MAINTENANCE_RUN,
        id: uuid(),
        payload: {
          steps: args.steps,
        },
      }, 120_000, 'Database maintenance');

      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );
}
