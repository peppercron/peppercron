import { describe, expect, it } from 'vitest';
import { T_GAP, T_OVERLAP, testTz } from './helpers/fake-tz';

describe('fakeTz', () => {
  it('knows only its own zones', () => {
    expect(testTz.isValid('Test/NY')).toBe(true);
    expect(testTz.isValid('America/New_York')).toBe(false);
  });

  it('applies the new offset from the transition second onwards', () => {
    expect(testTz.offsetAt('Test/NY', T_GAP - 1)).toBe(-18000);
    expect(testTz.offsetAt('Test/NY', T_GAP)).toBe(-14400);
    expect(testTz.offsetAt('Test/NY', T_OVERLAP)).toBe(-18000);
  });

  it('lists transitions with fromSec < at <= toSec', () => {
    expect(testTz.transitions('Test/NY', T_GAP, T_OVERLAP).map((t) => t.at)).toEqual([T_OVERLAP]);
    expect(testTz.transitions('Test/NY', T_GAP - 1, T_GAP).map((t) => t.at)).toEqual([T_GAP]);
    expect(testTz.transitions('UTC', 0, T_OVERLAP)).toEqual([]);
  });
});
