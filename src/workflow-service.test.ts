import { describe, it, expect } from 'vitest';
import { stripCodeFences } from './workflow-service.js';

describe('stripCodeFences', () => {
  it('returns plain JSON unchanged', () => {
    const json = '{"has_alerts": true, "alert_count": 2}';
    expect(stripCodeFences(json)).toBe(json);
  });

  it('strips ```json code fences', () => {
    const input = '```json\n{"has_alerts": true}\n```';
    expect(stripCodeFences(input)).toBe('{"has_alerts": true}');
  });

  it('strips bare ``` code fences', () => {
    const input = '```\n{"has_alerts": false}\n```';
    expect(stripCodeFences(input)).toBe('{"has_alerts": false}');
  });

  it('handles whitespace around fences', () => {
    const input = '  ```json\n  {"ok": true}\n  ```  ';
    expect(stripCodeFences(input)).toBe('{"ok": true}');
  });

  it('handles multiline JSON inside fences', () => {
    const input = '```json\n{\n  "report": "all clear",\n  "has_alerts": false\n}\n```';
    const result = JSON.parse(stripCodeFences(input));
    expect(result.has_alerts).toBe(false);
    expect(result.report).toBe('all clear');
  });

  it('does not strip fences that are not at start/end', () => {
    const input = 'Here is the result:\n```json\n{"ok": true}\n```\nDone.';
    // This has text before/after fences — should be returned as-is (trimmed)
    expect(stripCodeFences(input)).toBe(input.trim());
  });

  it('returns empty string for empty input', () => {
    expect(stripCodeFences('')).toBe('');
    expect(stripCodeFences('   ')).toBe('');
  });

  it('returns plain text unchanged', () => {
    const text = 'This is just a plain response with no JSON.';
    expect(stripCodeFences(text)).toBe(text);
  });
});
