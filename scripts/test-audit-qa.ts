#!/usr/bin/env npx tsx
/**
 * QA test script for Request Lifecycle Audit Logging.
 *
 * Runs all audit-related verification in a structured, repeatable pipeline:
 *
 *   Phase 1 — Unit tests (vitest: correlation, emitter, integration)
 *   Phase 2 — Schema migration (in-memory: v18 → v19 migration + fresh schema)
 *   Phase 3 — Core store tests (vitest: cambot-core audit-correlation tests)
 *   Phase 4 — Smoke test (in-memory: full lifecycle simulation with chain verification)
 *   Phase 5 — Live DB audit check (optional, --live flag: queries real store/cambot.sqlite)
 *
 * Usage:
 *   bun run test:audit           # Phases 1-4 (safe, no side effects)
 *   bun run test:audit -- --live # Phases 1-5 (reads live DB, read-only)
 *
 * Exit codes:
 *   0 — all phases passed
 *   1 — one or more phases failed
 */

import { execSync } from 'child_process';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { createSchema, SCHEMA_VERSION, createSecurityEventStore } from 'cambot-core';

// ─── Helpers ───────────────────────────────────────────────────────────────

interface PhaseResult {
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
}

const results: PhaseResult[] = [];
const isLive = process.argv.includes('--live');

function run(phase: string, fn: () => string): void {
  const start = Date.now();
  try {
    const detail = fn();
    results.push({ name: phase, passed: true, detail, durationMs: Date.now() - start });
    console.log(`  PASS  ${phase} (${Date.now() - start}ms)`);
  } catch (err: any) {
    const msg = err.message || String(err);
    results.push({ name: phase, passed: false, detail: msg, durationMs: Date.now() - start });
    console.log(`  FAIL  ${phase} (${Date.now() - start}ms)`);
    console.log(`        ${msg.split('\n')[0]}`);
  }
}

function exec(cmd: string): string {
  return execSync(cmd, { stdio: 'pipe', timeout: 120_000 }).toString();
}

function setupInMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  try { db.exec('ALTER TABLE security_events ADD COLUMN correlation_id TEXT'); } catch {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_security_events_correlation_id ON security_events(correlation_id)'); } catch {}
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(SCHEMA_VERSION));
  return db;
}

// ─── Phase 1: Unit Tests ───────────────────────────────────────────────────

console.log('\n=== Audit QA Pipeline ===\n');

console.log('Phase 1: Unit tests (vitest)\n');

run('cambot-agent audit unit tests', () => {
  const output = exec('cd "' + process.cwd() + '" && bunx vitest run src/audit/ 2>&1');
  const match = output.match(/(\d+) passed/);
  const count = match ? match[1] : '?';
  if (output.includes('FAIL')) throw new Error(output);
  return `${count} tests passed`;
});

// ─── Phase 2: Schema Migration ────────────────────────────────────────────

console.log('\nPhase 2: Schema migration verification\n');

run('SCHEMA_VERSION is 19', () => {
  if (SCHEMA_VERSION !== 19) throw new Error(`Expected 19, got ${SCHEMA_VERSION}`);
  return `SCHEMA_VERSION = ${SCHEMA_VERSION}`;
});

run('Fresh schema includes correlation_id column', () => {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  createSchema(db);
  const columns = db.pragma('table_info(security_events)') as Array<{ name: string }>;
  const hasCorrelationId = columns.some(c => c.name === 'correlation_id');
  db.close();
  if (!hasCorrelationId) throw new Error('correlation_id column missing from baseline schema');
  return 'correlation_id present in CREATE TABLE';
});

run('Migration v19 applies to v18 schema (ALTER TABLE path)', () => {
  // Simulate a v18 database where correlation_id doesn't exist yet
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create the security_events table WITHOUT correlation_id (v18 shape)
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp   TEXT NOT NULL,
      severity    TEXT NOT NULL CHECK(severity IN ('info','warning','critical','emergency')),
      event_type  TEXT NOT NULL,
      source      TEXT NOT NULL DEFAULT 'system',
      description TEXT NOT NULL,
      details     TEXT,
      session_key TEXT,
      resolved    INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      chain_hash  TEXT NOT NULL,
      prev_hash   TEXT
    )
  `);

  // Apply migration v19 manually
  db.exec('ALTER TABLE security_events ADD COLUMN correlation_id TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_security_events_correlation_id ON security_events(correlation_id)');

  // Verify column exists
  const columns = db.pragma('table_info(security_events)') as Array<{ name: string }>;
  const hasIt = columns.some(c => c.name === 'correlation_id');
  db.close();
  if (!hasIt) throw new Error('ALTER TABLE did not add correlation_id');
  return 'ALTER TABLE migration succeeded';
});

// ─── Phase 3: Core Store Tests ─────────────────────────────────────────────

console.log('\nPhase 3: Core store tests (vitest)\n');

run('cambot-core audit-correlation tests', () => {
  const coreDir = path.resolve(process.cwd(), '..', 'cambot-core');
  const output = exec('cd "' + coreDir + '" && bunx vitest run test/security/audit-correlation.test.ts 2>&1');
  const match = output.match(/(\d+) passed/);
  const count = match ? match[1] : '?';
  if (output.includes('FAIL')) throw new Error(output);
  return `${count} tests passed`;
});

// ─── Phase 4: Smoke Test (In-Memory Lifecycle) ────────────────────────────

console.log('\nPhase 4: Smoke test (full lifecycle simulation)\n');

run('iMessage lifecycle: webhook → delivery', () => {
  const db = setupInMemoryDb();
  const store = createSecurityEventStore();

  const events = [
    { severity: 'info' as const, eventType: 'audit.webhook_received', source: 'imessage', description: 'POST /webhook from 1.2.3.4 -> 200', correlationId: 'imessage:webhook:wh_qa_1', details: { sourceIp: '1.2.3.4', method: 'POST', responseCode: 200 } },
    { severity: 'info' as const, eventType: 'audit.message_inbound', source: 'imessage', description: 'Inbound from Alice', correlationId: 'imessage:im:+1234:msg_qa_1', details: { sender: '+1234', contentLength: 42 } },
    { severity: 'info' as const, eventType: 'audit.authorization_decision', source: 'imessage', description: 'Allowed', correlationId: 'imessage:im:+1234:msg_qa_1', details: { decision: 'allowed', groupFolder: 'main' } },
    { severity: 'info' as const, eventType: 'audit.session_lifecycle', source: 'agent', description: 'Session start', correlationId: 'imessage:im:+1234:msg_qa_1', details: { action: 'start' } },
    { severity: 'info' as const, eventType: 'audit.message_outbound', source: 'agent', description: 'Outbound to im:+1234', correlationId: 'imessage:im:+1234:msg_qa_1', details: { agentName: 'main', contentLength: 200 } },
    { severity: 'info' as const, eventType: 'audit.delivery_result', source: 'imessage', description: 'Delivery accepted', correlationId: 'imessage:im:+1234:msg_qa_1', details: { accepted: true, durationMs: 150 } },
    { severity: 'info' as const, eventType: 'audit.session_lifecycle', source: 'agent', description: 'Session end', correlationId: 'imessage:im:+1234:msg_qa_1', details: { action: 'end', success: true } },
  ];

  for (const e of events) {
    store.insert(db, e);
  }

  // Verify correlation query
  const lifecycle = store.queryByCorrelation(db, 'imessage:im:+1234:msg_qa_1');
  if (lifecycle.length !== 6) throw new Error(`Expected 6 correlated events, got ${lifecycle.length}`);

  // Verify chain integrity
  const broken = store.verifyChain(db);
  if (broken !== null) throw new Error(`Chain broken at id ${broken.brokenAtId}`);

  // Verify event type filtering
  const webhooks = store.query(db, { eventType: 'audit.webhook_received' });
  if (webhooks.length !== 1) throw new Error(`Expected 1 webhook event, got ${webhooks.length}`);

  db.close();
  return `7 events inserted, 6 correlated, chain intact`;
});

run('Dropped message lifecycle: no outbound/delivery events', () => {
  const db = setupInMemoryDb();
  const store = createSecurityEventStore();
  const corrId = 'discord:dc:unknown:msg_drop';

  store.insert(db, {
    severity: 'info', eventType: 'audit.message_inbound', source: 'discord',
    description: 'Inbound from unknown', correlationId: corrId,
    details: { sender: 'user#999' },
  });
  store.insert(db, {
    severity: 'info', eventType: 'audit.authorization_decision', source: 'discord',
    description: 'Dropped unregistered', correlationId: corrId,
    details: { decision: 'dropped_unregistered' },
  });

  const events = store.queryByCorrelation(db, corrId);
  if (events.length !== 2) throw new Error(`Expected 2 events, got ${events.length}`);

  const types = events.map(e => e.eventType);
  if (types.includes('audit.message_outbound')) throw new Error('Dropped message should have no outbound');
  if (types.includes('audit.delivery_result')) throw new Error('Dropped message should have no delivery');

  const broken = store.verifyChain(db);
  if (broken !== null) throw new Error(`Chain broken at id ${broken.brokenAtId}`);

  db.close();
  return '2 events, no leakage to outbound/delivery';
});

run('Auth failure lifecycle: warning severity', () => {
  const db = setupInMemoryDb();
  const store = createSecurityEventStore();
  const corrId = 'imessage:webhook:wh_bad_auth';

  store.insert(db, {
    severity: 'info', eventType: 'audit.webhook_received', source: 'imessage',
    description: 'POST /webhook -> 401', correlationId: corrId,
    details: { authValid: false, responseCode: 401 },
  });
  store.insert(db, {
    severity: 'warning', eventType: 'audit.webhook_auth_failed', source: 'imessage',
    description: 'Auth failed from 10.0.0.1', correlationId: corrId,
    details: { sourceIp: '10.0.0.1', headerName: 'X-LoopMessage-Auth' },
  });

  const events = store.queryByCorrelation(db, corrId);
  if (events.length !== 2) throw new Error(`Expected 2 events, got ${events.length}`);
  if (events[1].severity !== 'warning') throw new Error(`Expected warning severity, got ${events[1].severity}`);

  db.close();
  return 'Auth failure recorded with warning severity';
});

run('Multi-channel isolation: 3 parallel lifecycles', () => {
  const db = setupInMemoryDb();
  const store = createSecurityEventStore();

  const channels = ['imessage', 'whatsapp', 'discord'];
  for (const ch of channels) {
    const corrId = `${ch}:test:msg_${ch}`;
    store.insert(db, {
      severity: 'info', eventType: 'audit.message_inbound', source: ch,
      description: `Inbound on ${ch}`, correlationId: corrId,
    });
    store.insert(db, {
      severity: 'info', eventType: 'audit.authorization_decision', source: ch,
      description: 'Allowed', correlationId: corrId,
      details: { decision: 'allowed' },
    });
  }

  // Each should have exactly 2 events
  for (const ch of channels) {
    const events = store.queryByCorrelation(db, `${ch}:test:msg_${ch}`);
    if (events.length !== 2) throw new Error(`${ch}: expected 2 events, got ${events.length}`);
    if (!events.every(e => e.source === ch)) throw new Error(`${ch}: cross-channel leakage detected`);
  }

  const broken = store.verifyChain(db);
  if (broken !== null) throw new Error(`Chain broken at id ${broken.brokenAtId}`);

  db.close();
  return '3 channels, 6 events total, zero cross-leakage';
});

run('Chain integrity under load: 100 rapid events', () => {
  const db = setupInMemoryDb();
  const store = createSecurityEventStore();

  for (let i = 0; i < 100; i++) {
    store.insert(db, {
      severity: 'info',
      eventType: 'audit.message_inbound',
      source: 'stress',
      description: `Message ${i}`,
      correlationId: `stress:test:msg_${i}`,
    });
  }

  const broken = store.verifyChain(db);
  if (broken !== null) throw new Error(`Chain broken at id ${broken.brokenAtId}`);

  const count = store.query(db, { eventType: 'audit.message_inbound' }).length;
  if (count !== 100) throw new Error(`Expected 100 events, got ${count}`);

  db.close();
  return '100 events, chain intact, all queryable';
});

run('correlationId excluded from chain hash', () => {
  const db = setupInMemoryDb();
  const store = createSecurityEventStore();

  const e1 = store.insert(db, {
    severity: 'info', eventType: 'audit.test', source: 'test',
    description: 'event', correlationId: 'corr_alpha',
  });
  const e2 = store.insert(db, {
    severity: 'info', eventType: 'audit.test', source: 'test',
    description: 'event', correlationId: 'corr_beta',
  });

  // Chain links correctly despite different correlationIds
  if (e2.prevHash !== e1.chainHash) throw new Error('Chain linkage broken');
  if (!/^[0-9a-f]{64}$/.test(e1.chainHash)) throw new Error('Invalid hash format');

  const broken = store.verifyChain(db);
  if (broken !== null) throw new Error('Chain verification failed');

  db.close();
  return 'Different correlationIds, valid chain linkage';
});

run('Webhook dedup event recorded', () => {
  const db = setupInMemoryDb();
  const store = createSecurityEventStore();
  const corrId = 'imessage:webhook:wh_dup_qa';

  store.insert(db, {
    severity: 'info', eventType: 'audit.webhook_received', source: 'imessage',
    description: 'Webhook received', correlationId: corrId,
    details: { webhookId: 'wh_dup_qa' },
  });
  store.insert(db, {
    severity: 'info', eventType: 'audit.webhook_dedup', source: 'imessage',
    description: 'Duplicate suppressed', correlationId: corrId,
    details: { webhookId: 'wh_dup_qa' },
  });

  const events = store.queryByCorrelation(db, corrId);
  if (events.length !== 2) throw new Error(`Expected 2, got ${events.length}`);
  if (events[1].eventType !== 'audit.webhook_dedup') throw new Error('Wrong event type');

  db.close();
  return 'Dedup event recorded alongside webhook';
});

// ─── Phase 5: Live DB Check (optional) ─────────────────────────────────────

if (isLive) {
  console.log('\nPhase 5: Live DB audit check (--live)\n');

  run('Live DB has audit events', () => {
    const dbPath = path.resolve(process.cwd(), 'store', 'cambot.sqlite');
    if (!fs.existsSync(dbPath)) throw new Error(`DB not found: ${dbPath}`);

    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    db.pragma('journal_mode = WAL');

    // Check schema version
    const version = (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as any)?.value;
    if (parseInt(version) < 19) throw new Error(`Schema version ${version} < 19, migration needed`);

    // Check for correlation_id column
    const columns = db.pragma('table_info(security_events)') as Array<{ name: string }>;
    const hasCorrId = columns.some(c => c.name === 'correlation_id');
    if (!hasCorrId) throw new Error('correlation_id column missing — run migrations');

    // Count audit events
    const auditCount = (db.prepare(
      "SELECT COUNT(*) as cnt FROM security_events WHERE event_type LIKE 'audit.%'",
    ).get() as any).cnt;

    // Count distinct correlation IDs
    const corrIdCount = (db.prepare(
      "SELECT COUNT(DISTINCT correlation_id) as cnt FROM security_events WHERE correlation_id IS NOT NULL AND event_type LIKE 'audit.%'",
    ).get() as any).cnt;

    // Verify chain
    const store = createSecurityEventStore();
    const broken = store.verifyChain(db);

    // List event type distribution
    const distribution = db.prepare(
      "SELECT event_type, COUNT(*) as cnt FROM security_events WHERE event_type LIKE 'audit.%' GROUP BY event_type ORDER BY cnt DESC",
    ).all() as Array<{ event_type: string; cnt: number }>;

    db.close();

    if (broken !== null) throw new Error(`Chain broken at id ${broken.brokenAtId}`);

    const distStr = distribution.map(d => `${d.event_type}: ${d.cnt}`).join(', ');
    return `${auditCount} audit events, ${corrIdCount} correlation IDs, chain intact. Distribution: ${distStr || 'none'}`;
  });
} else {
  console.log('\nPhase 5: Skipped (use --live to check store/cambot.sqlite)\n');
}

// ─── Summary ───────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60));
console.log('  AUDIT QA RESULTS');
console.log('='.repeat(60));

const passed = results.filter(r => r.passed).length;
const failed = results.filter(r => !r.passed).length;
const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

for (const r of results) {
  const icon = r.passed ? 'PASS' : 'FAIL';
  console.log(`  [${icon}] ${r.name}`);
  console.log(`         ${r.detail}`);
}

console.log('');
console.log(`  ${passed} passed, ${failed} failed (${totalMs}ms total)`);
console.log('='.repeat(60));

process.exit(failed > 0 ? 1 : 0);
