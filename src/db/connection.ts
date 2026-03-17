import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createSchemaManager } from 'cambot-core';

import { GROUPS_DIR, STORE_DIR } from '../config/config.js';
import { logger } from '../logger.js';
import { migrateJsonState } from './migration.js';
import { createAgentRepository } from './agent-repository.js';
import { createAgentTemplateRepository } from './agent-template-repository.js';
import { createNotificationRepository } from './notification-repository.js';

let db: Database.Database;

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'cambot.sqlite');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000');

  // Load sqlite-vec extension if available
  try {
    db.loadExtension('vec0');
  } catch {
    try {
      db.loadExtension('sqlite-vec');
    } catch {
      logger.debug('sqlite-vec extension not available, vector search disabled');
    }
  }

  // Delegate schema creation to cambot-core's schema manager
  const schema = createSchemaManager();
  schema.initialize(db);

  // Create agent-specific tables not managed by cambot-core schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_images (
      provider TEXT PRIMARY KEY,
      container_image TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      personality TEXT,
      secret_keys TEXT NOT NULL DEFAULT '[]'
    );
  `);

  // Ensure agent tables and run migrations
  const agentRepo = createAgentRepository(db);
  agentRepo.ensureTable();

  const templateRepo = createAgentTemplateRepository(db);
  templateRepo.ensureTable();
  templateRepo.seedFromDisk(path.join(GROUPS_DIR, 'global'));

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  const schema = createSchemaManager();
  schema.initialize(db);

  // Create agent-specific tables not managed by cambot-core schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_images (
      provider TEXT PRIMARY KEY,
      container_image TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_definitions (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      personality TEXT,
      secret_keys TEXT NOT NULL DEFAULT '[]'
    );
  `);

  const agentRepo = createAgentRepository(db);
  agentRepo.ensureTable();

  const templateRepo = createAgentTemplateRepository(db);
  templateRepo.ensureTable();

  const notificationRepo = createNotificationRepository(db);
  notificationRepo.ensureTable();
}

/** Expose the database instance for subsystems that need direct access. */
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDatabase() first');
  return db;
}
