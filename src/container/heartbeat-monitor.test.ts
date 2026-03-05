import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { createHeartbeatMonitor, type HeartbeatMonitorConfig, type HeartbeatMonitorCallbacks } from './heartbeat-monitor.js';

vi.mock('fs');

const HEARTBEAT_PATH = '/tmp/test-ipc/_heartbeat';

function makeConfig(overrides: Partial<HeartbeatMonitorConfig> = {}): HeartbeatMonitorConfig {
  return {
    heartbeatPath: HEARTBEAT_PATH,
    intervalMs: 1000,
    warnAfterMissed: 3,
    closeAfterMissed: 6,
    stopAfterMissed: 12,
    killAfterMissed: 18,
    idleTimeoutMs: 1800000,
    groupName: 'test-group',
    containerName: 'cambot-agent-test-123',
    ...overrides,
  };
}

function makeCallbacks() {
  return {
    onWarn: vi.fn<(missedCount: number, groupName: string) => void>(),
    onClose: vi.fn<(groupName: string) => void>(),
    onStop: vi.fn<(containerName: string, groupName: string) => void>(),
    onKill: vi.fn<(containerName: string, groupName: string) => void>(),
  };
}

/** Helper: set up readFileSync to return a heartbeat with given timestamp and phase. */
function mockHeartbeat(timestamp: number, phase = 'querying') {
  vi.mocked(fs.readFileSync).mockReturnValue(
    JSON.stringify({ timestamp, phase, containerName: 'cambot-agent-test-123', pid: 42, queryCount: 1, uptimeMs: 5000 }),
  );
}

/** Helper: set up readFileSync to throw ENOENT. */
function mockNoFile() {
  vi.mocked(fs.readFileSync).mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
}

/** Advance time by one interval tick, updating the mock timestamp so it looks fresh. */
function tickFresh(intervalMs: number, phase = 'querying') {
  mockHeartbeat(Date.now() + intervalMs, phase);
  vi.advanceTimersByTime(intervalMs);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHeartbeatMonitor', () => {
  it('does not fire callbacks when heartbeat is continuously fresh', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    mockHeartbeat(Date.now());
    monitor.start();

    // Keep heartbeat fresh for 20 intervals
    for (let i = 0; i < 20; i++) {
      tickFresh(1000);
    }

    expect(callbacks.onWarn).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    expect(callbacks.onStop).not.toHaveBeenCalled();
    expect(callbacks.onKill).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('fires onWarn after warnAfterMissed intervals with stale heartbeat', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    // First tick: fresh
    mockHeartbeat(Date.now() + 1000);
    monitor.start();
    vi.advanceTimersByTime(1000);

    // Now stop updating — all subsequent checks are stale
    // missed=1 at t=2000, missed=2 at t=3000, missed=3 at t=4000 → warn
    vi.advanceTimersByTime(3000);

    expect(callbacks.onWarn).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('fires full escalation ladder at correct missed counts', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    // First tick: fresh
    mockHeartbeat(Date.now() + 1000);
    monitor.start();
    vi.advanceTimersByTime(1000);

    // Now stale: advance 18 intervals for full escalation
    // missed=3 → warn, missed=6 → close, missed=12 → stop, missed=18 → kill
    vi.advanceTimersByTime(18000);

    expect(callbacks.onWarn).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(callbacks.onStop).toHaveBeenCalledTimes(1);
    expect(callbacks.onKill).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it('escalation is one-shot per level (no duplicates)', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    mockHeartbeat(Date.now() + 1000);
    monitor.start();
    vi.advanceTimersByTime(1000);

    // Go way past kill threshold
    vi.advanceTimersByTime(30000);

    // Each callback should fire exactly once
    expect(callbacks.onWarn).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);
    expect(callbacks.onStop).toHaveBeenCalledTimes(1);
    expect(callbacks.onKill).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it('resets escalation on fresh heartbeat after missed beats', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    // Fresh start
    mockHeartbeat(Date.now() + 1000);
    monitor.start();
    vi.advanceTimersByTime(1000);

    // 4 stale intervals → warn fires (missed=3 on 4th)
    vi.advanceTimersByTime(4000);
    expect(callbacks.onWarn).toHaveBeenCalledTimes(1);
    expect(callbacks.onClose).not.toHaveBeenCalled();

    // Fresh heartbeat arrives — resets everything
    tickFresh(1000);
    expect(callbacks.onClose).not.toHaveBeenCalled();

    // 4 more stale intervals → warn fires again (reset worked)
    vi.advanceTimersByTime(4000);
    expect(callbacks.onWarn).toHaveBeenCalledTimes(2);
    // Close still not fired (only 4 missed after reset, need 6)
    expect(callbacks.onClose).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('acknowledgeActivity() resets missed count and fired flags', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    mockHeartbeat(Date.now() + 1000);
    monitor.start();
    vi.advanceTimersByTime(1000);

    // 4 stale intervals → warn fires
    vi.advanceTimersByTime(4000);
    expect(callbacks.onWarn).toHaveBeenCalledTimes(1);

    // External activity acknowledged — resets everything
    monitor.acknowledgeActivity();

    // 4 more stale intervals → warn fires again
    vi.advanceTimersByTime(4000);
    expect(callbacks.onWarn).toHaveBeenCalledTimes(2);
    // Close not fired (only 4 missed since reset, need 6)
    expect(callbacks.onClose).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('ignores ENOENT during startup grace period (30s)', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    // File doesn't exist yet (container still booting)
    mockNoFile();
    monitor.start();

    // Within 30s grace period — no callbacks
    vi.advanceTimersByTime(25000);
    expect(callbacks.onWarn).not.toHaveBeenCalled();

    monitor.stop();
  });

  it('fires callbacks after ENOENT past grace period', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    mockNoFile();
    monitor.start();

    // Advance past grace period
    vi.advanceTimersByTime(31000);

    // Now ENOENT counts as missed — 3 more intervals → warn
    vi.advanceTimersByTime(3000);
    expect(callbacks.onWarn).toHaveBeenCalled();

    monitor.stop();
  });

  it('fires onClose when idle phase exceeds idleTimeoutMs', () => {
    const callbacks = makeCallbacks();
    const config = makeConfig({ idleTimeoutMs: 5000 });
    const monitor = createHeartbeatMonitor(config, callbacks);

    monitor.start();

    // Keep updating heartbeat (container is alive) but phase stays idle
    for (let i = 0; i < 8; i++) {
      tickFresh(1000, 'idle');
    }

    // After 5+ seconds of idle phase, onClose should fire exactly once
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it('resets idle tracking when phase changes from idle', () => {
    const callbacks = makeCallbacks();
    const config = makeConfig({ idleTimeoutMs: 5000 });
    const monitor = createHeartbeatMonitor(config, callbacks);

    monitor.start();

    // Idle for 3 seconds
    for (let i = 0; i < 3; i++) {
      tickFresh(1000, 'idle');
    }
    expect(callbacks.onClose).not.toHaveBeenCalled();

    // Phase changes to querying — resets idle timer
    tickFresh(1000, 'querying');

    // Back to idle for 3 seconds (idleSince set on first, then 2 more = 2000ms elapsed)
    for (let i = 0; i < 3; i++) {
      tickFresh(1000, 'idle');
    }
    expect(callbacks.onClose).not.toHaveBeenCalled();

    // 3 more seconds of idle → total 5000ms continuous idle → fires
    // (idleSince was set at first idle tick, need 5 more intervals to reach 5000ms)
    for (let i = 0; i < 3; i++) {
      tickFresh(1000, 'idle');
    }
    expect(callbacks.onClose).toHaveBeenCalledTimes(1);

    monitor.stop();
  });

  it('stop() prevents further checks', () => {
    const callbacks = makeCallbacks();
    const monitor = createHeartbeatMonitor(makeConfig(), callbacks);

    mockHeartbeat(Date.now() + 1000);
    monitor.start();
    vi.advanceTimersByTime(1000);

    monitor.stop();

    // Even many intervals later, no callbacks
    vi.advanceTimersByTime(100000);
    expect(callbacks.onWarn).not.toHaveBeenCalled();
  });
});
