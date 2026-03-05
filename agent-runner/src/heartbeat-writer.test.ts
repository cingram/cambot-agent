import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { createHeartbeatWriter, type HeartbeatPayload } from './heartbeat-writer.js';

vi.mock('fs');

const HEARTBEAT_PATH = '/workspace/ipc/_heartbeat';
const TMP_PATH = HEARTBEAT_PATH + '.tmp';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHeartbeatWriter', () => {
  it('writes heartbeat file immediately on start()', () => {
    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    expect(fs.writeFileSync).toHaveBeenCalledWith(
      TMP_PATH,
      expect.stringContaining('"phase":"starting"'),
    );
    expect(fs.renameSync).toHaveBeenCalledWith(TMP_PATH, HEARTBEAT_PATH);

    writer.stop();
  });

  it('writes atomically (tmp + rename)', () => {
    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    const writeCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(writeCall[0]).toBe(TMP_PATH);
    expect(vi.mocked(fs.renameSync).mock.calls[0]).toEqual([TMP_PATH, HEARTBEAT_PATH]);

    writer.stop();
  });

  it('writes on interval', () => {
    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    // Clear initial write
    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.renameSync).mockClear();

    // Advance 5 seconds
    vi.advanceTimersByTime(5000);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(fs.renameSync).toHaveBeenCalledTimes(1);

    // Advance another 5 seconds
    vi.advanceTimersByTime(5000);

    expect(fs.writeFileSync).toHaveBeenCalledTimes(2);

    writer.stop();
  });

  it('includes correct fields in payload', () => {
    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const payload: HeartbeatPayload = JSON.parse(written.trim());

    expect(payload.phase).toBe('starting');
    expect(payload.containerName).toBe('cambot-agent-main-123');
    expect(payload.pid).toBe(process.pid);
    expect(payload.queryCount).toBe(0);
    expect(typeof payload.timestamp).toBe('number');
    expect(typeof payload.uptimeMs).toBe('number');

    writer.stop();
  });

  it('setPhase updates the phase in subsequent writes', () => {
    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    writer.setPhase('querying');
    vi.advanceTimersByTime(5000);

    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string;
    const payload: HeartbeatPayload = JSON.parse(written.trim());
    expect(payload.phase).toBe('querying');

    writer.stop();
  });

  it('incrementQueryCount increases count', () => {
    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    writer.incrementQueryCount();
    writer.incrementQueryCount();
    writer.incrementQueryCount();

    vi.advanceTimersByTime(5000);

    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)![1] as string;
    const payload: HeartbeatPayload = JSON.parse(written.trim());
    expect(payload.queryCount).toBe(3);

    writer.stop();
  });

  it('stop() writes final shutting-down heartbeat and cleans up tmp', () => {
    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    vi.mocked(fs.writeFileSync).mockClear();
    vi.mocked(fs.renameSync).mockClear();

    writer.stop();

    // Should write a final heartbeat with shutting-down phase
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const payload = JSON.parse(written.trim());
    expect(payload.phase).toBe('shutting-down');

    // Should delete tmp but NOT the heartbeat file (left for stale cleanup)
    expect(fs.unlinkSync).toHaveBeenCalledWith(TMP_PATH);
    expect(fs.unlinkSync).not.toHaveBeenCalledWith(HEARTBEAT_PATH);

    // No more writes after stop
    vi.advanceTimersByTime(10000);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it('write errors are logged but do not throw', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fs.writeFileSync).mockImplementation(() => {
      throw new Error('disk full');
    });

    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);

    // Should not throw
    expect(() => writer.start()).not.toThrow();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('disk full'),
    );

    writer.stop();
    consoleSpy.mockRestore();
  });

  it('stop() tolerates ENOENT on tmp delete', () => {
    vi.mocked(fs.unlinkSync).mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const writer = createHeartbeatWriter(HEARTBEAT_PATH, 'cambot-agent-main-123', 5000);
    writer.start();

    // Should not throw even if tmp file doesn't exist
    expect(() => writer.stop()).not.toThrow();
  });
});
