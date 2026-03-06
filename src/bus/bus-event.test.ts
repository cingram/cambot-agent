import { describe, it, expect } from 'vitest';
import { BusEvent } from './bus-event.js';
import type { EnvelopeOptions } from './envelope.js';

// ---------------------------------------------------------------------------
// Concrete subclass for testing the abstract BusEvent
// ---------------------------------------------------------------------------

class TestEvent extends BusEvent {
  readonly type = 'test.event';
  constructor(source: string, envelope?: EnvelopeOptions) {
    super('test.event', source, envelope);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BusEvent', () => {
  describe('id', () => {
    it('auto-generates a UUID when no id is provided', () => {
      const event = new TestEvent('unit-test');
      expect(event.id).toBeDefined();
      expect(event.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });

    it('generates unique ids across instances', () => {
      const a = new TestEvent('unit-test');
      const b = new TestEvent('unit-test');
      expect(a.id).not.toBe(b.id);
    });

    it('accepts a custom id via envelope options', () => {
      const event = new TestEvent('unit-test', { id: 'custom-id-123' });
      expect(event.id).toBe('custom-id-123');
    });
  });

  describe('type', () => {
    it('sets the type from the subclass', () => {
      const event = new TestEvent('unit-test');
      expect(event.type).toBe('test.event');
    });
  });

  describe('source', () => {
    it('sets the source from the constructor argument', () => {
      const event = new TestEvent('my-source');
      expect(event.source).toBe('my-source');
    });
  });

  describe('timestamp', () => {
    it('sets timestamp as an ISO 8601 string', () => {
      const before = new Date().toISOString();
      const event = new TestEvent('unit-test');
      const after = new Date().toISOString();

      expect(event.timestamp).toBeDefined();
      // Verify it parses as a valid date
      expect(Number.isNaN(Date.parse(event.timestamp))).toBe(false);
      // Verify it falls within the expected range
      expect(event.timestamp >= before).toBe(true);
      expect(event.timestamp <= after).toBe(true);
    });
  });

  describe('version', () => {
    it('defaults to 1 when not provided', () => {
      const event = new TestEvent('unit-test');
      expect(event.version).toBe(1);
    });

    it('can be overridden via envelope options', () => {
      const event = new TestEvent('unit-test', { version: 3 });
      expect(event.version).toBe(3);
    });
  });

  describe('correlationId', () => {
    it('is undefined by default', () => {
      const event = new TestEvent('unit-test');
      expect(event.correlationId).toBeUndefined();
    });

    it('is set when provided via envelope', () => {
      const event = new TestEvent('unit-test', { correlationId: 'corr-001' });
      expect(event.correlationId).toBe('corr-001');
    });
  });

  describe('causationId', () => {
    it('is undefined by default', () => {
      const event = new TestEvent('unit-test');
      expect(event.causationId).toBeUndefined();
    });

    it('is set when provided via envelope', () => {
      const event = new TestEvent('unit-test', { causationId: 'cause-001' });
      expect(event.causationId).toBe('cause-001');
    });
  });

  describe('target', () => {
    it('is undefined by default', () => {
      const event = new TestEvent('unit-test');
      expect(event.target).toBeUndefined();
    });

    it('is set when provided via envelope', () => {
      const event = new TestEvent('unit-test', { target: 'agent-42' });
      expect(event.target).toBe('agent-42');
    });
  });

  describe('channel', () => {
    it('is undefined by default', () => {
      const event = new TestEvent('unit-test');
      expect(event.channel).toBeUndefined();
    });

    it('is set when provided via envelope', () => {
      const event = new TestEvent('unit-test', { channel: 'web' });
      expect(event.channel).toBe('web');
    });
  });

  describe('cancelled', () => {
    it('defaults to false', () => {
      const event = new TestEvent('unit-test');
      expect(event.cancelled).toBe(false);
    });

    it('is mutable (can be set to true)', () => {
      const event = new TestEvent('unit-test');
      event.cancelled = true;
      expect(event.cancelled).toBe(true);
    });
  });

  describe('full envelope', () => {
    it('sets all envelope fields when provided together', () => {
      const envelope: EnvelopeOptions = {
        id: 'full-id',
        version: 5,
        correlationId: 'corr-full',
        causationId: 'cause-full',
        target: 'target-full',
        channel: 'email',
      };
      const event = new TestEvent('full-source', envelope);

      expect(event.id).toBe('full-id');
      expect(event.version).toBe(5);
      expect(event.correlationId).toBe('corr-full');
      expect(event.causationId).toBe('cause-full');
      expect(event.target).toBe('target-full');
      expect(event.channel).toBe('email');
      expect(event.source).toBe('full-source');
      expect(event.type).toBe('test.event');
    });
  });
});
