/**
 * Host-side handler for database maintenance commands.
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';

import { FRAME_TYPES } from '../protocol/types.js';
import type { CommandRegistry } from './registry.js';
import {
  createFactDecayService,
  createFactPurgerService,
  createOrphanCleanerService,
  createFactHardDeleteService,
  createSqliteMaintenanceService,
  runEntityDedup,
  createEntityStore,
} from 'cambot-core';
import { getDatabase } from '../../db/index.js';
import { STORE_DIR } from '../../config/config.js';
import { logger } from '../../logger.js';

const INACTIVE_DAYS = 30;
const BACKUP_RETENTION_COUNT = 7;

export const MAINTENANCE_STEPS = [
  'fact_decay',
  'fact_purge',
  'entity_dedup',
  'orphan_cleanup',
  'hard_delete',
  'fts_rebuild',
  'vacuum',
  'backup',
] as const;

export type MaintenanceStep = (typeof MAINTENANCE_STEPS)[number];

const MaintenanceRunSchema = z.object({
  steps: z.array(z.enum(MAINTENANCE_STEPS)).optional(),
});

type StepResult = Record<string, unknown>;
type StepRunner = (db: import('better-sqlite3').Database) => StepResult;

const stepRunners: Record<MaintenanceStep, StepRunner> = {
  fact_decay(db) {
    const r = createFactDecayService().batchUpdate(db);
    return { updated: r.updated, archived: r.archived };
  },
  fact_purge(db) {
    const r = createFactPurgerService().runPurge(db);
    return { scanned: r.scanned, rejected: r.rejected, accepted: r.accepted, orphanEntitiesDeleted: r.orphanEntitiesDeleted };
  },
  entity_dedup(db) {
    const r = runEntityDedup(db, createEntityStore());
    return { entitiesBefore: r.entitiesBefore, merged: r.merged, orphansCleaned: r.orphansCleaned };
  },
  orphan_cleanup(db) {
    const r = createOrphanCleanerService().cleanAll(db);
    return { ...r };
  },
  hard_delete(db) {
    const r = createFactHardDeleteService().deleteInactiveFacts(db, INACTIVE_DAYS);
    return { factsDeleted: r.factsDeleted };
  },
  fts_rebuild(db) {
    const r = createSqliteMaintenanceService().ftsRebuild(db);
    return { durationMs: r.durationMs };
  },
  vacuum(db) {
    const svc = createSqliteMaintenanceService();
    const analyze = svc.analyze(db);
    const vacuum = svc.vacuum(db);
    return { analyzeMs: analyze.durationMs, vacuumMs: vacuum.durationMs, sizeBefore: vacuum.sizeBefore, sizeAfter: vacuum.sizeAfter };
  },
  backup(db) {
    const backupDir = path.join(STORE_DIR, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(backupDir, `cambot-${timestamp}.sqlite`);

    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    const size = fs.statSync(backupPath).size;

    const backups = fs.readdirSync(backupDir).filter(f => f.endsWith('.sqlite')).sort().reverse();
    let rotated = 0;
    for (let i = BACKUP_RETENTION_COUNT; i < backups.length; i++) {
      fs.unlinkSync(path.join(backupDir, backups[i]));
      rotated++;
    }

    return { path: backupPath, sizeBytes: size, rotated, kept: Math.min(backups.length, BACKUP_RETENTION_COUNT) };
  },
};

export function registerMaintenanceHandlers(registry: CommandRegistry): void {
  registry.register(
    FRAME_TYPES.MAINTENANCE_RUN,
    MaintenanceRunSchema,
    'main-only',
    async (payload, frame, connection) => {
      const requested = payload.steps ?? MAINTENANCE_STEPS;
      const db = getDatabase();
      const results: Record<string, unknown> = {};
      const startTime = Date.now();

      logger.info({ steps: requested, group: connection.identity.group }, 'Running database maintenance');

      for (const step of requested) {
        try {
          results[step] = stepRunners[step](db);
        } catch (err) {
          results[step] = { error: err instanceof Error ? err.message : String(err) };
          logger.warn({ step, error: err }, 'Maintenance step failed');
        }
      }

      const durationMs = Date.now() - startTime;
      results.durationMs = durationMs;

      logger.info({ durationMs, steps: requested }, 'Database maintenance complete');

      connection.reply(frame, FRAME_TYPES.MAINTENANCE_RUN, {
        status: 'ok',
        result: JSON.stringify(results),
      });
    },
  );
}
