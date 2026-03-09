/**
 * Agent Message Repository — persists inter-agent communication records.
 *
 * Stores messages exchanged via send_to_agent and delegate_to_worker
 * for debugging and auditing agent-to-agent interactions.
 */

import type Database from 'better-sqlite3';

export interface AgentMessage {
  id: number;
  source: string;
  target: string;
  type: 'agent.send' | 'worker.delegate';
  prompt: string;
  result: string | null;
  status: 'success' | 'error' | 'timeout';
  error: string | null;
  durationMs: number | null;
  frameId: string | null;
  createdAt: string;
}

export interface AgentMessageInsert {
  source: string;
  target: string;
  type: 'agent.send' | 'worker.delegate';
  prompt: string;
  result: string | null;
  status: 'success' | 'error' | 'timeout';
  error: string | null;
  durationMs: number | null;
  frameId: string | null;
}

export interface AgentMessageQueryOpts {
  source?: string;
  target?: string;
  type?: 'agent.send' | 'worker.delegate';
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export interface AgentMessageRepository {
  insert(msg: AgentMessageInsert): void;
  query(opts?: AgentMessageQueryOpts): AgentMessage[];
  getByAgent(agentId: string, limit?: number): AgentMessage[];
  getBetween(agentA: string, agentB: string, limit?: number): AgentMessage[];
}

interface AgentMessageRow {
  id: number;
  source: string;
  target: string;
  type: string;
  prompt: string;
  result: string | null;
  status: string;
  error: string | null;
  duration_ms: number | null;
  frame_id: string | null;
  created_at: string;
}

function parseRow(row: AgentMessageRow): AgentMessage {
  return {
    id: row.id,
    source: row.source,
    target: row.target,
    type: row.type as AgentMessage['type'],
    prompt: row.prompt,
    result: row.result,
    status: row.status as AgentMessage['status'],
    error: row.error,
    durationMs: row.duration_ms,
    frameId: row.frame_id,
    createdAt: row.created_at,
  };
}

export function createAgentMessageRepository(db: Database.Database): AgentMessageRepository {
  const insertStmt = db.prepare(`
    INSERT INTO agent_messages (source, target, type, prompt, result, status, error, duration_ms, frame_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const byAgentStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE source = ? OR target = ?
    ORDER BY created_at DESC
    LIMIT ?
  `);

  const betweenStmt = db.prepare(`
    SELECT * FROM agent_messages
    WHERE (source = ? AND target = ?) OR (source = ? AND target = ?)
    ORDER BY created_at DESC
    LIMIT ?
  `);

  return {
    insert(msg) {
      insertStmt.run(
        msg.source,
        msg.target,
        msg.type,
        msg.prompt,
        msg.result,
        msg.status,
        msg.error,
        msg.durationMs,
        msg.frameId,
      );
    },

    query(opts = {}) {
      const clauses: string[] = [];
      const params: unknown[] = [];

      if (opts.source) { clauses.push('source = ?'); params.push(opts.source); }
      if (opts.target) { clauses.push('target = ?'); params.push(opts.target); }
      if (opts.type) { clauses.push('type = ?'); params.push(opts.type); }
      if (opts.since) { clauses.push('created_at >= ?'); params.push(opts.since); }
      if (opts.until) { clauses.push('created_at <= ?'); params.push(opts.until); }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const limit = opts.limit ?? 100;
      const offset = opts.offset ?? 0;

      const rows = db.prepare(
        `SELECT * FROM agent_messages ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as AgentMessageRow[];

      return rows.map(parseRow);
    },

    getByAgent(agentId, limit = 50) {
      const rows = byAgentStmt.all(agentId, agentId, limit) as AgentMessageRow[];
      return rows.map(parseRow);
    },

    getBetween(agentA, agentB, limit = 50) {
      const rows = betweenStmt.all(agentA, agentB, agentB, agentA, limit) as AgentMessageRow[];
      return rows.map(parseRow);
    },
  };
}
