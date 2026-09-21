import { describe, expect, it } from 'vitest';
import { intlTz } from '../src/tz-intl';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

describe('intlTz', () => {
  it('validates zone names', () => {
    expect(intlTz.isValid('America/New_York')).toBe(true);
    expect(intlTz.isValid('UTC')).toBe(true);
    expect(intlTz.isValid('Mars/Phobos')).toBe(false);
    expect(intlTz.isValid('')).toBe(false);
    // Intl reads a non-string as "the host default", which would make a pure function host-dependent.
    expect(intlTz.isValid(undefined as unknown as string)).toBe(false);
    expect(intlTz.isValid(null as unknown as string)).toBe(false);
  });

  it('reports offsets in seconds east of UTC', () => {
    expect(intlTz.offsetAt('UTC', utc(2026, 6, 1))).toBe(0);
    expect(intlTz.offsetAt('America/New_York', utc(2026, 1, 15))).toBe(-18000);
    expect(intlTz.offsetAt('America/New_York', utc(2026, 7, 15))).toBe(-14400);
    expect(intlTz.offsetAt('Asia/Kolkata', utc(2026, 7, 15))).toBe(19800);
  });

  it('finds both 2026 New York transitions to the second', () => {
    expect(intlTz.transitions('America/New_York', utc(2026, 1, 1), utc(2027, 1, 1))).toEqual([
      { at: utc(2026, 3, 8, 7), before: -18000, after: -14400 },
      { at: utc(2026, 11, 1, 6), before: -14400, after: -18000 },
    ]);
  });

  it('finds both 2026 London transitions', () => {
    expect(intlTz.transitions('Europe/London', utc(2026, 1, 1), utc(2027, 1, 1))).toEqual([
      { at: utc(2026, 3, 29, 1), before: 0, after: 3600 },
      { at: utc(2026, 10, 25, 1), before: 3600, after: 0 },
    ]);
  });

  it('handles the southern hemisphere and a 30-minute shift', () => {
    expect(intlTz.transitions('Australia/Sydney', utc(2026, 3, 1), utc(2026, 5, 1))).toEqual([
      { at: utc(2026, 4, 4, 16), before: 39600, after: 36000 },
    ]);
    expect(intlTz.transitions('Australia/Lord_Howe', utc(2026, 3, 1), utc(2026, 5, 1))).toEqual([
      { at: utc(2026, 4, 4, 15), before: 39600, after: 37800 },
    ]);
  });

  it('returns nothing for zones without DST, and respects the (from, to] bounds', () => {
    expect(intlTz.transitions('Asia/Kolkata', utc(2026, 1, 1), utc(2027, 1, 1))).toEqual([]);
    expect(intlTz.transitions('UTC', utc(2026, 1, 1), utc(2027, 1, 1))).toEqual([]);
    const t = utc(2026, 3, 8, 7);
    expect(intlTz.transitions('America/New_York', t, t + 86400)).toEqual([]);
    expect(intlTz.transitions('America/New_York', t - 1, t)).toHaveLength(1);
  });

  it('sees the day Samoa skipped (Pacific/Apia, December 2011)', () => {
    const found = intlTz.transitions('Pacific/Apia', utc(2011, 12, 25), utc(2012, 1, 5));
    expect(found).toHaveLength(1);
    expect(found[0].after - found[0].before).toBe(86400);
  });

  it('does not throw for an unknown zone', () => {
    expect(intlTz.offsetAt('Mars/Phobos', 0)).toBe(0);
    expect(intlTz.transitions('Mars/Phobos', 0, 1e9)).toEqual([]);
  });
});
