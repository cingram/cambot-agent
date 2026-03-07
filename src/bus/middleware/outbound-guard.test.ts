import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createOutboundGuard } from './outbound-guard.js';
import { OutboundMessage } from '../events/outbound-message.js';
import { InboundMessage } from '../events/inbound-message.js';

function makeOutbound(jid: string, text = 'hello'): OutboundMessage {
  return new OutboundMessage('test', jid, text);
}

describe('outbound-guard', () => {
  describe('non-outbound events', () => {
    it('passes through non-OutboundMessage events', () => {
      const guard = createOutboundGuard();
      const event = new InboundMessage('test', 'email:test@test.com', {
        id: '1', chat_jid: 'email:test@test.com', sender: 's',
        sender_name: 'S', content: 'hi', timestamp: new Date().toISOString(),
        is_from_me: false, is_bot_message: false,
      });
      expect(guard.before!(event)).toBeUndefined();
    });
  });

  describe('per-channel rate limits', () => {
    it('allows messages within limits', () => {
      const guard = createOutboundGuard({
        channelLimits: { email: { perMinute: 3, perHour: 100, perDay: 1000 } },
      });
      expect(guard.before!(makeOutbound('email:a@b.com'))).toBeUndefined();
      expect(guard.before!(makeOutbound('email:a@b.com'))).toBeUndefined();
      expect(guard.before!(makeOutbound('email:a@b.com'))).toBeUndefined();
    });

    it('blocks messages exceeding per-minute limit', () => {
      const onLimitHit = vi.fn();
      const guard = createOutboundGuard({
        channelLimits: { email: { perMinute: 2, perHour: 100, perDay: 1000 } },
        onLimitHit,
      });

      expect(guard.before!(makeOutbound('email:a@b.com'))).toBeUndefined();
      expect(guard.before!(makeOutbound('email:c@d.com'))).toBeUndefined();
      // Third email in same minute → blocked
      expect(guard.before!(makeOutbound('email:e@f.com'))).toBe(false);
      expect(onLimitHit).toHaveBeenCalledWith('email', 'email:e@f.com', 'perMinute');
    });

    it('uses fallback limits for unknown channels', () => {
      const guard = createOutboundGuard();
      // Unknown channel uses FALLBACK_LIMITS (perMinute: 30)
      for (let i = 0; i < 30; i++) {
        expect(guard.before!(makeOutbound(`custom:user${i}`))).toBeUndefined();
      }
      expect(guard.before!(makeOutbound('custom:overflow'))).toBe(false);
    });

    it('channels are independent', () => {
      const guard = createOutboundGuard({
        channelLimits: {
          email: { perMinute: 1, perHour: 10, perDay: 100 },
          web: { perMinute: 1, perHour: 10, perDay: 100 },
        },
      });

      expect(guard.before!(makeOutbound('email:a@b.com'))).toBeUndefined();
      // Email is now at limit, but web should still work
      expect(guard.before!(makeOutbound('web:user1'))).toBeUndefined();
      // Second email → blocked
      expect(guard.before!(makeOutbound('email:c@d.com'))).toBe(false);
    });
  });

  describe('loop detection', () => {
    it('blocks rapid sends to the same JID', () => {
      const onLoopDetected = vi.fn();
      const guard = createOutboundGuard({
        loopThreshold: 3,
        loopWindowMs: 60_000,
        channelLimits: { email: { perMinute: 100, perHour: 1000, perDay: 10000 } },
        onLoopDetected,
      });

      expect(guard.before!(makeOutbound('email:loop@test.com'))).toBeUndefined();
      expect(guard.before!(makeOutbound('email:loop@test.com'))).toBeUndefined();
      expect(guard.before!(makeOutbound('email:loop@test.com'))).toBeUndefined();
      // 4th send to same JID within window → loop detected
      expect(guard.before!(makeOutbound('email:loop@test.com'))).toBe(false);
      expect(onLoopDetected).toHaveBeenCalledWith('email', 'email:loop@test.com', 3);
    });

    it('allows sends to different JIDs', () => {
      const guard = createOutboundGuard({
        loopThreshold: 2,
        channelLimits: { email: { perMinute: 100, perHour: 1000, perDay: 10000 } },
      });

      expect(guard.before!(makeOutbound('email:a@test.com'))).toBeUndefined();
      expect(guard.before!(makeOutbound('email:b@test.com'))).toBeUndefined();
      expect(guard.before!(makeOutbound('email:c@test.com'))).toBeUndefined();
    });
  });

  describe('WhatsApp JID detection', () => {
    it('recognizes WhatsApp JIDs', () => {
      const guard = createOutboundGuard({
        channelLimits: { whatsapp: { perMinute: 1, perHour: 10, perDay: 100 } },
      });

      expect(guard.before!(makeOutbound('123@s.whatsapp.net'))).toBeUndefined();
      expect(guard.before!(makeOutbound('456@s.whatsapp.net'))).toBe(false);
    });
  });
});
