/**
 * Outbound Guard — deterministic rate limiter and loop detector for outbound messages.
 *
 * Sits on the bus as middleware and gates OutboundMessage events:
 * 1. Per-channel sliding window rate limits (per-minute, per-hour, per-day)
 * 2. Per-JID loop detection (too many sends to the same recipient in a short window)
 *
 * When a limit is hit, the event is dropped (returns false from before())
 * and a warning is logged. Optionally emits a callback for security alerting.
 */

import type { BusMiddleware } from '../middleware.js';
import type { BusEvent } from '../bus-event.js';
import { OutboundMessage } from '../events/outbound-message.js';
import { logger } from '../../logger.js';

export interface ChannelLimits {
  perMinute: number;
  perHour: number;
  perDay: number;
}

export interface OutboundGuardOptions {
  /** Per-channel rate limits. Keys are channel names derived from JID prefix. */
  channelLimits?: Partial<Record<string, ChannelLimits>>;
  /** Max sends to the same JID within the loop window. Default: 5 */
  loopThreshold?: number;
  /** Loop detection window in ms. Default: 300_000 (5 min) */
  loopWindowMs?: number;
  /** Called when a rate limit is hit. */
  onLimitHit?: (channel: string, jid: string, window: string) => void;
  /** Called when a reply loop is detected. */
  onLoopDetected?: (channel: string, jid: string, count: number) => void;
}

const DEFAULT_CHANNEL_LIMITS: Record<string, ChannelLimits> = {
  email:    { perMinute: 5,  perHour: 30,  perDay: 100  },
  whatsapp: { perMinute: 20, perHour: 200, perDay: 1000 },
  web:      { perMinute: 60, perHour: 600, perDay: 5000 },
};

const FALLBACK_LIMITS: ChannelLimits = { perMinute: 30, perHour: 300, perDay: 2000 };

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface SlidingWindow {
  timestamps: number[];
}

/** Derive channel name from JID prefix (e.g. "email:foo@bar" → "email") */
function channelFromJid(jid: string): string {
  const colonIdx = jid.indexOf(':');
  if (colonIdx > 0) return jid.slice(0, colonIdx);
  if (jid.includes('@g.us') || jid.includes('@s.whatsapp.net')) return 'whatsapp';
  return 'unknown';
}

/** Prune timestamps older than the given window from the array (mutates in place). */
function pruneWindow(timestamps: number[], windowMs: number, now: number): void {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < timestamps.length && timestamps[i] < cutoff) i++;
  if (i > 0) timestamps.splice(0, i);
}

/** Count entries within the window. Assumes the array is already pruned to DAY_MS. */
function countWithin(timestamps: number[], windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  let count = 0;
  for (let i = timestamps.length - 1; i >= 0; i--) {
    if (timestamps[i] >= cutoff) count++;
    else break;
  }
  return count;
}

export function createOutboundGuard(opts: OutboundGuardOptions = {}): BusMiddleware {
  const loopThreshold = opts.loopThreshold ?? 5;
  const loopWindowMs = opts.loopWindowMs ?? 300_000;

  const mergedLimits: Record<string, ChannelLimits> = { ...DEFAULT_CHANNEL_LIMITS };
  if (opts.channelLimits) {
    for (const [k, v] of Object.entries(opts.channelLimits)) {
      if (v) mergedLimits[k] = v;
    }
  }

  /** Per-channel sliding windows (keyed by channel name). */
  const channelWindows = new Map<string, SlidingWindow>();
  /** Per-JID sliding windows for loop detection. */
  const jidWindows = new Map<string, SlidingWindow>();

  function getWindow(map: Map<string, SlidingWindow>, key: string): SlidingWindow {
    let w = map.get(key);
    if (!w) {
      w = { timestamps: [] };
      map.set(key, w);
    }
    return w;
  }

  return {
    name: 'outbound-guard',

    before(event: BusEvent): boolean | void {
      if (!(event instanceof OutboundMessage)) return;

      const now = Date.now();
      const channel = channelFromJid(event.jid);
      const limits = mergedLimits[channel] ?? FALLBACK_LIMITS;

      // --- Per-JID loop detection ---
      const jidWindow = getWindow(jidWindows, event.jid);
      pruneWindow(jidWindow.timestamps, loopWindowMs, now);
      if (jidWindow.timestamps.length >= loopThreshold) {
        logger.warn(
          { jid: event.jid, channel, count: jidWindow.timestamps.length, windowMs: loopWindowMs },
          'Outbound guard: reply loop detected, dropping message',
        );
        opts.onLoopDetected?.(channel, event.jid, jidWindow.timestamps.length);
        return false;
      }

      // --- Per-channel rate limits ---
      const chWindow = getWindow(channelWindows, channel);
      pruneWindow(chWindow.timestamps, DAY_MS, now);

      const perMinute = countWithin(chWindow.timestamps, MINUTE_MS, now);
      if (perMinute >= limits.perMinute) {
        logger.warn(
          { channel, jid: event.jid, count: perMinute, limit: limits.perMinute },
          'Outbound guard: per-minute rate limit hit, dropping message',
        );
        opts.onLimitHit?.(channel, event.jid, 'perMinute');
        return false;
      }

      const perHour = countWithin(chWindow.timestamps, HOUR_MS, now);
      if (perHour >= limits.perHour) {
        logger.warn(
          { channel, jid: event.jid, count: perHour, limit: limits.perHour },
          'Outbound guard: per-hour rate limit hit, dropping message',
        );
        opts.onLimitHit?.(channel, event.jid, 'perHour');
        return false;
      }

      const perDay = chWindow.timestamps.length;
      if (perDay >= limits.perDay) {
        logger.warn(
          { channel, jid: event.jid, count: perDay, limit: limits.perDay },
          'Outbound guard: per-day rate limit hit, dropping message',
        );
        opts.onLimitHit?.(channel, event.jid, 'perDay');
        return false;
      }

      // All checks passed — record the send
      chWindow.timestamps.push(now);
      jidWindow.timestamps.push(now);
    },
  };
}
