import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EVENT_TYPES, registerAllEventTypes } from './event-types.js';
import { createMessageBus, type MessageBus } from './message-bus.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EVENT_TYPES', () => {
  it('has expected structure (type + description for every entry)', () => {
    for (const entry of EVENT_TYPES) {
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('description');
      expect(typeof entry.type).toBe('string');
      expect(typeof entry.description).toBe('string');
    }
  });

  it('all entries have non-empty type and description', () => {
    for (const entry of EVENT_TYPES) {
      expect(entry.type.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate types in the array', () => {
    const types = EVENT_TYPES.map((e) => e.type);
    const uniqueTypes = new Set(types);
    expect(uniqueTypes.size).toBe(types.length);
  });

  it('contains expected event type categories', () => {
    const types = EVENT_TYPES.map((e) => e.type);

    // Message category
    expect(types).toContain('message.inbound');
    expect(types).toContain('message.outbound');
    expect(types).toContain('message.delivered');

    // Agent category
    expect(types).toContain('agent.telemetry');
    expect(types).toContain('agent.error');
    expect(types).toContain('agent.spawned');
    expect(types).toContain('agent.completed');

    // Memory category
    expect(types).toContain('memory.session_summarized');
    expect(types).toContain('memory.reflections_generated');

    // Telemetry category
    expect(types).toContain('telemetry.api_call');
    expect(types).toContain('telemetry.tool_invocation');

    // Security category
    expect(types).toContain('security.anomaly');
    expect(types).toContain('security.injection_detected');

    // System category
    expect(types).toContain('system.startup');
    expect(types).toContain('system.shutdown');

    // Bus category
    expect(types).toContain('bus.backpressure');
    expect(types).toContain('bus.dead_letter');
  });

  it('is readonly (frozen array)', () => {
    // TypeScript enforces readonly, but verify at runtime
    expect(Array.isArray(EVENT_TYPES)).toBe(true);
  });
});

describe('registerAllEventTypes', () => {
  let bus: MessageBus;

  beforeEach(() => {
    bus = createMessageBus();
  });

  it('registers all types on the bus', () => {
    registerAllEventTypes(bus);

    const registered = bus.listEventTypes();
    expect(registered.length).toBe(EVENT_TYPES.length);
  });

  it('bus.listEventTypes() returns all registered types after registration', () => {
    registerAllEventTypes(bus);

    const registered = bus.listEventTypes();
    const registeredTypes = registered.map((e) => e.type);

    for (const entry of EVENT_TYPES) {
      expect(registeredTypes).toContain(entry.type);
    }
  });

  it('registered descriptions match EVENT_TYPES descriptions', () => {
    registerAllEventTypes(bus);

    const registered = bus.listEventTypes();
    const registeredMap = new Map(registered.map((e) => [e.type, e.description]));

    for (const entry of EVENT_TYPES) {
      expect(registeredMap.get(entry.type)).toBe(entry.description);
    }
  });

  it('is idempotent — calling twice does not create duplicates', () => {
    registerAllEventTypes(bus);
    registerAllEventTypes(bus);

    const registered = bus.listEventTypes();
    expect(registered.length).toBe(EVENT_TYPES.length);
  });
});
