import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createSchemaManager } from 'cambot-core';

import { STORE_DIR } from '../config/config.js';
import { logger } from '../logger.js';
import { migrateJsonState } from './migration.js';

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
    CREATE TABLE IF NOT EXISTS registered_agents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      description   TEXT NOT NULL DEFAULT '',
      folder        TEXT NOT NULL UNIQUE,
      channels      TEXT NOT NULL DEFAULT '[]',
      mcp_servers   TEXT NOT NULL DEFAULT '[]',
      capabilities  TEXT NOT NULL DEFAULT '[]',
      concurrency   INTEGER NOT NULL DEFAULT 1,
      timeout_ms    INTEGER NOT NULL DEFAULT 300000,
      is_main       INTEGER NOT NULL DEFAULT 0,
      agent_def_id  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
  `);
}

/** Expose the database instance for subsystems that need direct access. */
export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized — call initDatabase() first');
  return db;
}
