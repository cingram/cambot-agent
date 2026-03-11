/**
 * MCP tool registration: save_context.
 *
 * Deterministically reads context files from the workspace and sends
 * the assembled content to the host. The agent has no influence over
 * the content — it just triggers the save.
 */
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import type { McpToolContext } from './types.js';
import { uuid, mcpText, mcpError, readFileOr, requestWithTimeout } from './helpers.js';
import { FRAME_TYPES } from '../cambot-socket/types.js';

const CONTEXT_DUMP = '/workspace/context-dump.md';
const GROUP_MEMORY = '/workspace/group/CLAUDE.md';
const SNAPSHOTS_DIR = '/workspace/snapshots';
const EXTRA_DIR = '/workspace/extra';

/** Collect all JSON snapshot files from the snapshots directory. */
function collectSnapshots(): string {
  const sections: string[] = [];
  try {
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.json')) {
          sections.push(`\n## ${entry.name}\n\`\`\`json\n${fs.readFileSync(full, 'utf-8')}\n\`\`\``);
        }
      }
    };
    walk(SNAPSHOTS_DIR);
  } catch {
    // Directory doesn't exist — no snapshots
  }
  return sections.join('\n');
}

/** List extra mount directories. */
function listExtra(): string {
  try {
    const entries = fs.readdirSync(EXTRA_DIR);
    return entries.length > 0 ? entries.join('\n') : '_(none)_';
  } catch {
    return '_(none)_';
  }
}

/** Deterministically assemble the full context from workspace files. */
function assembleContext(): string {
  const sections: string[] = [];

  sections.push('# Context Dump\n');
  sections.push(readFileOr(CONTEXT_DUMP, '_(not found)_'));

  sections.push('\n\n# Group Memory\n');
  sections.push(readFileOr(GROUP_MEMORY, '_(not found)_'));

  sections.push('\n\n# Snapshots');
  sections.push(collectSnapshots());

  sections.push('\n\n# Environment\n');
  sections.push(`HOME=${process.env.HOME ?? 'unknown'}`);
  sections.push(`NODE_VERSION=${process.version}`);

  sections.push('\n## Extra Mounts');
  sections.push(listExtra());

  return sections.join('\n');
}

export function registerContextTools(ctx: McpToolContext): void {
  ctx.server.tool(
    'save_context',
    'Save a full snapshot of your system context to a file on the host. '
    + 'Content is assembled automatically from workspace files — just call this tool.',
    {
      filename: z.string().optional().describe(
        'Output filename (default: context-snapshot-{date}.md). Path separators are stripped for safety.',
      ),
    },
    async (args) => {
      const content = assembleContext();

      const result = await requestWithTimeout(
        ctx.client,
        {
          type: FRAME_TYPES.CONTEXT_SAVE,
          id: uuid(),
          payload: {
            content,
            filename: args.filename,
          },
        },
        30_000,
        'Context save',
      );
      if (result.isError) return mcpError(result.text);
      return mcpText(result.text);
    },
  );
}
