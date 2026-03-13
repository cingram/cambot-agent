/**
 * Shared schema migration utilities for SQLite repositories.
 */

import type Database from 'better-sqlite3';

/**
 * Add a column to a table if it doesn't already exist.
 * Uses PRAGMA table_info to check first, avoiding silent catch-all error swallowing.
 */
export function addColumnIfMissing(
  db: Database.Database,
  table: string,
  column: string,
  definition: string,
): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
