/**
 * Host-side heartbeat monitor.
 * Reads the container's heartbeat file on an interval and escalates
 * when the container stops updating: warn -> close -> stop -> kill.
 *
 * Also tracks idle phase duration and fires onClose after idleTimeoutMs.
 */
import fs from 'fs';

/** Heartbeat phase (must match agent-runner/src/heartbeat-writer.ts). */
type HeartbeatPhase = 'starting' | 'querying' | 'tool-call' | 'idle' | 'shutting-down';

export interface HeartbeatMonitorConfig {
  heartbeatPath: string;
  intervalMs: number;
  warnAfterMissed: number;
  closeAfterMissed: number;
  stopAfterMissed: number;
  killAfterMissed: number;
  idleTimeoutMs: number;
  groupName: string;
  containerName: string;
}

export interface HeartbeatMonitorCallbacks {
  onWarn: (missedCount: number, groupName: string) => void;
  onClose: (groupName: string) => void;
  onStop: (containerName: string, groupName: string) => void;
  onKill: (containerName: string, groupName: string) => void;
}

interface HeartbeatPayload {
  timestamp: number;
  phase: HeartbeatPhase;
  containerName: string;
  pid: number;
  queryCount: number;
  uptimeMs: number;
}

export interface HeartbeatMonitor {
  start(): void;
  stop(): void;
  /** Reset missed count — call when activity is detected outside heartbeat (e.g. OUTPUT_MARKER). */
  acknowledgeActivity(): void;
}

export function createHeartbeatMonitor(
  config: HeartbeatMonitorConfig,
  callbacks: HeartbeatMonitorCallbacks,
): HeartbeatMonitor {
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSeenTimestamp = 0;
  let missedCount = 0;
  let startedAt = 0;

  // One-shot escalation flags (prevent duplicate stop/kill commands)
  let warnFired = false;
  let closeFired = false;
  let stopFired = false;
  let killFired = false;

  // Idle phase tracking
  let idleSince: number | null = null;
  let idleCloseFired = false;

  let stopped = false;

  function check(): void {
    if (stopped) return;

    let payload: HeartbeatPayload | null = null;

    try {
      const raw = fs.readFileSync(config.heartbeatPath, 'utf-8');
      payload = JSON.parse(raw.trim());
    } catch (err: unknown) {
      // ENOENT during startup grace period is normal (container still booting)
      const isEnoent = err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT';
      if (isEnoent && (Date.now() - startedAt) < 30_000) {
        return; // Startup grace: ignore missing file for first 30s
      }
      // File missing or corrupt — count as missed beat
    }

    if (payload && payload.timestamp > lastSeenTimestamp) {
      // Fresh heartbeat — reset everything
      lastSeenTimestamp = payload.timestamp;
      missedCount = 0;
      warnFired = false;
      closeFired = false;
      stopFired = false;
      killFired = false;

      // Track idle phase duration
      if (payload.phase === 'idle') {
        if (idleSince === null) idleSince = Date.now();
        if (!idleCloseFired && (Date.now() - idleSince) >= config.idleTimeoutMs) {
          idleCloseFired = true;
          callbacks.onClose(config.groupName);
        }
      } else {
        // Not idle — reset idle tracker
        idleSince = null;
        idleCloseFired = false;
      }
      return;
    }

    // Timestamp unchanged — count as missed
    missedCount++;

    // Escalation ladder (one-shot per level)
    if (missedCount >= config.killAfterMissed && !killFired) {
      killFired = true;
      callbacks.onKill(config.containerName, config.groupName);
    } else if (missedCount >= config.stopAfterMissed && !stopFired) {
      stopFired = true;
      callbacks.onStop(config.containerName, config.groupName);
    } else if (missedCount >= config.closeAfterMissed && !closeFired) {
      closeFired = true;
      callbacks.onClose(config.groupName);
    } else if (missedCount >= config.warnAfterMissed && !warnFired) {
      warnFired = true;
      callbacks.onWarn(missedCount, config.groupName);
    }
  }

  return {
    start() {
      startedAt = Date.now();
      timer = setInterval(check, config.intervalMs);
      // Don't unref — host needs this to keep running
    },

    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },

    acknowledgeActivity() {
      missedCount = 0;
      warnFired = false;
      closeFired = false;
      stopFired = false;
      killFired = false;
    },
  };
}
