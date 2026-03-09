import { describe, it, expect } from 'vitest';
import { getMemoryInstructions } from './memory-instructions.js';

describe('getMemoryInstructions with strategyMode', () => {
  it('ephemeral returns no-memory instructions', () => {
    const result = getMemoryInstructions('both', 'ephemeral');
    expect(result).toContain('No persistent memory');
    expect(result).toContain('starts fresh');
    expect(result).not.toContain('Knowledge Database');
    expect(result).not.toContain('Markdown Memory');
  });

  it('conversation-scoped returns scoped instructions', () => {
    const result = getMemoryInstructions('both', 'conversation-scoped');
    expect(result).toContain('scoped to this conversation');
    expect(result).toContain('memory.md');
    expect(result).toContain('cleared when the conversation ends');
  });

  it('long-lived returns persistent + archive reference instructions', () => {
    const result = getMemoryInstructions('both', 'long-lived');
    expect(result).toContain('Long-term persistent memory');
    expect(result).toContain('conversations/');
  });

  it('persistent with no strategy returns default instructions', () => {
    const result = getMemoryInstructions('both');
    expect(result).toContain('Knowledge Database');
    expect(result).toContain('Markdown Memory');
  });

  it('persistent strategy returns default instructions', () => {
    const result = getMemoryInstructions('both', 'persistent');
    expect(result).toContain('Knowledge Database');
    expect(result).toContain('Markdown Memory');
  });
});
