/**
 * Container-side heartbeat writer.
 * Writes a JSON heartbeat file every `intervalMs` so the host can detect hangs.
 * Atomic: writes to .tmp then renames to avoid partial reads.
 * Errors are logged to stderr, never thrown — heartbeat failure must not crash the agent.
 */
import fs from 'fs';
import path from 'path';

export type HeartbeatPhase = 'starting' | 'querying' | 'tool-call' | 'idle' | 'shutting-down';

export interface HeartbeatPayload {
  timestamp: number;
  phase: HeartbeatPhase;
  containerName: string;
  pid: number;
  queryCount: number;
  uptimeMs: number;
}

export interface HeartbeatWriter {
  start(): void;
  stop(): void;
  setPhase(phase: HeartbeatPhase): void;
  incrementQueryCount(): void;
}

export function createHeartbeatWriter(
  heartbeatPath: string,
  containerName: string,
  intervalMs = 5000,
): HeartbeatWriter {
  const startedAt = Date.now();
  let phase: HeartbeatPhase = 'starting';
  let queryCount = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tmpPath = heartbeatPath + '.tmp';

  function write(): void {
    try {
      const payload: HeartbeatPayload = {
        timestamp: Date.now(),
        phase,
        containerName,
        pid: process.pid,
        queryCount,
        uptimeMs: Date.now() - startedAt,
      };
      fs.writeFileSync(tmpPath, JSON.stringify(payload) + '\n');
      fs.renameSync(tmpPath, heartbeatPath);
    } catch (err) {
      // Log but never throw — heartbeat failure must not crash the agent
      console.error(`[heartbeat] write failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    start() {
      // Write immediately, then on interval
      write();
      timer = setInterval(write, intervalMs);
      // Unref so heartbeat doesn't prevent process exit
      timer.unref();
    },

    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      // Write one final heartbeat with shutting-down phase so the host can
      // show the container transitioning before its file goes stale.
      // Don't delete — let the host-side stale cleanup handle removal.
      phase = 'shutting-down';
      write();
      try { fs.unlinkSync(tmpPath); } catch { /* ENOENT is fine */ }
    },

    setPhase(newPhase: HeartbeatPhase) {
      phase = newPhase;
    },

    incrementQueryCount() {
      queryCount++;
    },
  };
}
