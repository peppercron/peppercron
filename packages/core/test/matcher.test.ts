import { describe, expect, it } from 'vitest';
import { wallSeconds as W } from '../src/calendar';
import { getDialect } from '../src/dialects';
import { compile, nextTimeOfDay, nextWallMatch } from '../src/matcher';
import { createParser } from '../src/parse/parse';
import type { Dialect } from '../src/types';
import { testTz } from './helpers/fake-tz';

const parse = createParser(testTz);
const END = W(2032, 1, 1, 0, 0, 0);

function compiled(expr: string, dialect?: Dialect) {
  const r = parse(expr, dialect ? { dialect } : {});
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`);
  const c = compile(r.value, getDialect(r.value.dialect)!);
  if (!c) throw new Error('schedule has no fields');
  return c;
}
const after = (expr: string, from: number, dialect?: Dialect) => nextWallMatch(compiled(expr, dialect), from, END);

describe('compile', () => {
  it('sets resolution and fixedTime', () => {
    expect(compiled('30 2 * * *')).toMatchObject({ resolution: 60, fixedTime: true, seconds: [0] });
    expect(compiled('*/30 * * * *').fixedTime).toBe(false);
    expect(compiled('0 * * * *').fixedTime).toBe(false);
    expect(compiled('0 30 2 * * ?')).toMatchObject({ resolution: 1, years: null });
    expect(compiled('0 0 0 1 1 ? 2028').years).toEqual([2028]);
  });

  it('returns null for a schedule with no fields', () => {
    const r = parse('@reboot');
    expect(r.ok && compile(r.value, getDialect('vixie')!)).toBeNull();
  });
});

describe('nextTimeOfDay', () => {
  it('finds the next matching second of the day', () => {
    const c = compiled('*/15 9-17 * * *');
    expect(nextTimeOfDay(c, 0)).toBe(9 * 3600);
    expect(nextTimeOfDay(c, 9 * 3600 + 1)).toBe(9 * 3600 + 900);
    expect(nextTimeOfDay(c, 17 * 3600 + 45 * 60 + 1)).toBeNull();
    expect(nextTimeOfDay(compiled('0/20 * * * * ?'), 21)).toBe(40);
  });
});

describe('nextWallMatch', () => {
  it('includes from, excludes limit', () => {
    const c = compiled('0 2 * * 1');
    expect(nextWallMatch(c, W(2026, 9, 21, 0, 0, 0), END)).toBe(W(2026, 9, 21, 2, 0, 0));
    expect(nextWallMatch(c, W(2026, 9, 21, 2, 0, 0), END)).toBe(W(2026, 9, 21, 2, 0, 0));
    expect(nextWallMatch(c, W(2026, 9, 21, 2, 0, 1), END)).toBe(W(2026, 9, 28, 2, 0, 0));
    expect(nextWallMatch(c, W(2026, 9, 21, 0, 0, 0), W(2026, 9, 21, 2, 0, 0))).toBeNull();
    expect(nextWallMatch(c, END, W(2026, 1, 1, 0, 0, 0))).toBeNull();
  });

  it('vixie: OR when both day fields are restricted', () => {
    expect(after('0 9 1 * 1', W(2026, 9, 21, 10, 0, 0))).toBe(W(2026, 9, 28, 9, 0, 0));
    expect(after('0 9 1 * 1', W(2026, 9, 28, 9, 0, 1))).toBe(W(2026, 10, 1, 9, 0, 0));
  });

  it('vixie: AND when a day field starts with * (H5)', () => {
    expect(after('0 0 */2 * 1', W(2026, 9, 21, 0, 0, 1))).toBe(W(2026, 10, 5, 0, 0, 0));
  });

  it('vixie: an unsupported "?" behaves like *', () => {
    expect(after('0 0 ? * 1', W(2026, 9, 21, 0, 0, 1), 'vixie')).toBe(W(2026, 9, 28, 0, 0, 0));
  });

  it('quartz: last day, offset from last, last weekday', () => {
    expect(after('0 0 12 L * ?', W(2026, 9, 21, 0, 0, 0))).toBe(W(2026, 9, 30, 12, 0, 0));
    expect(after('0 0 12 L * ?', W(2028, 2, 1, 0, 0, 0))).toBe(W(2028, 2, 29, 12, 0, 0));
    expect(after('0 0 12 L-3 * ?', W(2026, 9, 21, 0, 0, 0))).toBe(W(2026, 9, 27, 12, 0, 0));
    expect(after('0 0 12 LW * ?', W(2026, 10, 1, 0, 0, 0))).toBe(W(2026, 10, 30, 12, 0, 0));
    expect(after('0 0 12 LW * ?', W(2026, 5, 1, 0, 0, 0))).toBe(W(2026, 5, 29, 12, 0, 0));
  });

  it('quartz: nearest weekday, including month edges and short months (H8)', () => {
    expect(after('0 0 12 15W * ?', W(2026, 11, 1, 0, 0, 0))).toBe(W(2026, 11, 16, 12, 0, 0));
    expect(after('0 0 12 1W * ?', W(2026, 7, 20, 0, 0, 0))).toBe(W(2026, 8, 3, 12, 0, 0));
    expect(after('0 0 12 31W * ?', W(2026, 5, 1, 0, 0, 0))).toBe(W(2026, 5, 29, 12, 0, 0));
    expect(after('0 0 12 31W * ?', W(2026, 9, 1, 0, 0, 0))).toBe(W(2026, 10, 30, 12, 0, 0));
  });

  it('quartz: nth and last weekday of the month', () => {
    expect(after('0 0 12 ? * 6#3', W(2026, 9, 21, 0, 0, 0))).toBe(W(2026, 10, 16, 12, 0, 0));
    expect(after('0 0 12 ? * 6L', W(2026, 9, 21, 0, 0, 0))).toBe(W(2026, 9, 25, 12, 0, 0));
    expect(after('0 0 12 ? * 2#5', W(2026, 9, 1, 0, 0, 0))).toBe(W(2026, 11, 30, 12, 0, 0));
  });

  it('quartz: with neither day field "?", both must match', () => {
    expect(after('0 0 12 1 * MON', W(2026, 9, 21, 0, 0, 0))).toBe(W(2027, 2, 1, 12, 0, 0));
  });

  it('honours the year field and stops after the last listed year', () => {
    expect(after('0 0 0 1 1 ? 2028', W(2026, 9, 21, 0, 0, 0))).toBe(W(2028, 1, 1, 0, 0, 0));
    expect(after('0 0 0 1 1 ? 2028', W(2028, 1, 1, 0, 0, 1))).toBeNull();
  });

  it('returns null for a date that never exists', () => {
    expect(after('0 0 31 4 *', W(2026, 1, 1, 0, 0, 0))).toBeNull();
  });
});
