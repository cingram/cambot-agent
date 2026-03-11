/**
 * context.save handler — writes agent context to a host-side directory.
 *
 * The agent sends its assembled context markdown via this tool,
 * and the host writes it to {DATA_DIR}/context-exports/{group}/{filename}.
 * This lets the file land on the host filesystem where the user can access it,
 * rather than being trapped inside the container's /workspace/group/.
 */

import fs from 'fs';
import path from 'path';
import { z } from 'zod';

import { DATA_DIR } from '../../config/config.js';
import { logger } from '../../logger.js';
import { FRAME_TYPES } from '../protocol/types.js';
import type { CommandRegistry } from './registry.js';

const ContextSaveSchema = z.object({
  content: z.string().min(1),
  filename: z.string().optional(),
});

export function registerContextSave(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.CONTEXT_SAVE,
    ContextSaveSchema,
    'any',
    async (payload, frame, connection) => {
      const { group: sourceGroup } = connection.identity;

      try {
        // Replace characters illegal in Windows paths (colon, etc.)
        const safeGroup = sourceGroup.replace(/[<>:"/\\|?*]/g, '-');
        const exportDir = path.join(DATA_DIR, 'context-exports', safeGroup);
        fs.mkdirSync(exportDir, { recursive: true });

        const filename = payload.filename
          || `context-snapshot-${new Date().toISOString().slice(0, 10)}.md`;

        // Sanitize filename — strip path separators
        const safeName = path.basename(filename);
        const filePath = path.join(exportDir, safeName);

        fs.writeFileSync(filePath, payload.content, 'utf-8');

        connection.reply(frame, FRAME_TYPES.CONTEXT_SAVE, {
          status: 'ok',
          result: `Context saved to ${filePath}`,
        });

        logger.info({ sourceGroup, filePath }, 'context.save: wrote context export');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err }, 'context.save failed');
        connection.replyError(frame, 'HANDLER_ERROR', msg);
      }
    },
  );
}
