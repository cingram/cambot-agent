import { describe, it, expect } from 'vitest';
import { buildCorrelationId, buildWebhookCorrelationId } from './correlation.js';

describe('buildCorrelationId', () => {
  it('builds channel:chatJid:messageId when messageId is provided', () => {
    expect(buildCorrelationId('imessage', 'im:+1234', 'msg_abc'))
      .toBe('imessage:im:+1234:msg_abc');
  });

  it('builds channel:chatJid when messageId is omitted', () => {
    expect(buildCorrelationId('discord', 'dc:12345'))
      .toBe('discord:dc:12345');
  });

  it('works with WhatsApp group JIDs', () => {
    expect(buildCorrelationId('whatsapp', '120363@g.us', 'ABC123'))
      .toBe('whatsapp:120363@g.us:ABC123');
  });

  it('works with web channel', () => {
    expect(buildCorrelationId('web', 'web:ui', 'web-1234'))
      .toBe('web:web:ui:web-1234');
  });
});

describe('buildWebhookCorrelationId', () => {
  it('builds channel:webhook:webhookId format', () => {
    expect(buildWebhookCorrelationId('imessage', 'wh_abc123'))
      .toBe('imessage:webhook:wh_abc123');
  });

  it('works with web channel', () => {
    expect(buildWebhookCorrelationId('web', 'req_xyz'))
      .toBe('web:webhook:req_xyz');
  });
});
