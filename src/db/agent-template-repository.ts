/**
 * Agent Template Repository — global templates (soul, identity) for agents.
 *
 * Seeds from disk (groups/global/SOUL.md, CLAUDE.md) on first run,
 * then serves templates from the database for dynamic agent creation.
 */
import fs from 'fs';
import type Database from 'better-sqlite3';

import { logger } from '../logger.js';

export interface AgentTemplate {
  key: string;
  value: string;
  updatedAt: string;
}

export interface AgentTemplateRepository {
  ensureTable(): void;
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  getAll(): AgentTemplate[];
  seedFromDisk(globalDir: string): void;
}

export function createAgentTemplateRepository(db: Database.Database): AgentTemplateRepository {
  return {
    ensureTable(): void {
      db.exec(`
        CREATE TABLE IF NOT EXISTS agent_templates (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    },

    get(key: string): string | undefined {
      const row = db.prepare('SELECT value FROM agent_templates WHERE key = ?').get(key) as { value: string } | undefined;
      return row?.value;
    },

    set(key: string, value: string): void {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT OR REPLACE INTO agent_templates (key, value, updated_at) VALUES (?, ?, ?)',
      ).run(key, value, now);
    },

    getAll(): AgentTemplate[] {
      return db.prepare('SELECT key, value, updated_at as updatedAt FROM agent_templates ORDER BY key').all() as AgentTemplate[];
    },

    seedFromDisk(globalDir: string): void {
      const existing = db.prepare('SELECT COUNT(*) as count FROM agent_templates').get() as { count: number };
      if (existing.count > 0) return;

      const soulPath = `${globalDir}/SOUL.md`;
      if (fs.existsSync(soulPath)) {
        this.set('soul', fs.readFileSync(soulPath, 'utf-8').trim());
        logger.info('Seeded agent_templates "soul" from SOUL.md');
      }

      const identityPath = `${globalDir}/CLAUDE.md`;
      if (fs.existsSync(identityPath)) {
        this.set('identity', fs.readFileSync(identityPath, 'utf-8').trim());
        logger.info('Seeded agent_templates "identity" from CLAUDE.md');
      }
    },
  };
}
