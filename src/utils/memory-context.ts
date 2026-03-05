/**
 * Host-side memory context builder.
 *
 * Opens cambot-core's SQLite database read-only and uses its
 * search engine + fact link store + query context builder to
 * produce query-relevant memory context for a given message.
 *
 * Gracefully degrades: returns null if the DB doesn't exist
 * or any error occurs. This is a best-effort enrichment layer.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import {
  createSearchEngine,
  createQueryContextBuilder,
  createFactLinkStore,
} from 'cambot-core';
import { STORE_DIR } from '../config/config.js';
import { logger } from '../logger.js';

const DB_PATH = path.join(STORE_DIR, 'cambot.sqlite');

/** Lazily opened read-only database handle. */
let readonlyDb: Database.Database | null = null;

/** Cached builder instances (created once per process). */
let contextBuilder: ReturnType<typeof createQueryContextBuilder> | null = null;

function getDb(): Database.Database | null {
  if (readonlyDb) return readonlyDb;
  if (!fs.existsSync(DB_PATH)) return null;

  try {
    readonlyDb = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    readonlyDb.pragma('journal_mode = WAL');
    return readonlyDb;
  } catch (err) {
    logger.warn({ err, dbPath: DB_PATH }, 'Failed to open cambot-core DB for memory context');
    return null;
  }
}

function getBuilder(): ReturnType<typeof createQueryContextBuilder> | null {
  if (contextBuilder) return contextBuilder;

  const searchEngine = createSearchEngine(null);
  const factLinkStore = createFactLinkStore();
  contextBuilder = createQueryContextBuilder(searchEngine, factLinkStore);
  return contextBuilder;
}

/**
 * Build query-relevant memory context for a user message.
 * Returns the formatted context string, or null if unavailable.
 */
export async function buildMemoryContext(messageText: string): Promise<string | null> {
  try {
    const db = getDb();
    if (!db) return null;

    const builder = getBuilder();
    if (!builder) return null;

    const result = await builder.build(db, messageText);
    if (!result.context || result.context.length === 0) return null;

    logger.debug(
      { factCount: result.factIds.length, contextLength: result.context.length },
      'Built memory context for message',
    );

    return result.context;
  } catch (err) {
    logger.warn({ err }, 'Failed to build memory context');
    return null;
  }
}
