import { describe, it, expect } from 'vitest';

import { timingSafeEqual } from './timing.js';

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });

  it('returns false when one string is empty', () => {
    expect(timingSafeEqual('', 'a')).toBe(false);
  });

  it('handles long identical strings', () => {
    const long = 'a'.repeat(10000);
    expect(timingSafeEqual(long, long)).toBe(true);
  });

  it('detects single-bit difference in long strings', () => {
    const a = 'a'.repeat(9999) + 'a';
    const b = 'a'.repeat(9999) + 'b';
    expect(timingSafeEqual(a, b)).toBe(false);
  });

  it('handles unicode characters', () => {
    expect(timingSafeEqual('\u00e9\u00e9', '\u00e9\u00e9')).toBe(true);
    expect(timingSafeEqual('\u00e9\u00e9', '\u00e9\u00ea')).toBe(false);
  });
});
