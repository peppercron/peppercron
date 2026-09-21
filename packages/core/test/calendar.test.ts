import { describe, expect, it } from 'vitest';
import {
  civilFromDays, daysFromCivil, daysInMonth, floorDiv, formatLocal, wallSeconds, weekdayOfDays,
} from '../src/calendar';

describe('calendar', () => {
  it('floorDiv rounds toward negative infinity', () => {
    expect(floorDiv(7, 2)).toBe(3);
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(floorDiv(-86400, 86400)).toBe(-1);
  });

  it('daysFromCivil matches known dates', () => {
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
    expect(daysFromCivil(1969, 12, 31)).toBe(-1);
    expect(daysFromCivil(2000, 3, 1)).toBe(11017);
    expect(daysFromCivil(2026, 3, 8)).toBe(20520);
  });

  it('agrees with Date.UTC across a wide range, and round-trips', () => {
    for (let days = -1000; days <= 60000; days += 37) {
      const date = new Date(days * 86400000);
      const expected = { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
      expect(civilFromDays(days)).toEqual(expected);
      expect(daysFromCivil(expected.y, expected.m, expected.d)).toBe(days);
      expect(weekdayOfDays(days)).toBe(date.getUTCDay());
    }
  });

  it('weekdayOfDays: 1970-01-01 was a Thursday, 2026-03-08 is a Sunday', () => {
    expect(weekdayOfDays(0)).toBe(4);
    expect(weekdayOfDays(20520)).toBe(0);
  });

  it('daysInMonth handles leap years and century rules', () => {
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2000, 2)).toBe(29);
    expect(daysInMonth(2100, 2)).toBe(28);
    expect(daysInMonth(2026, 4)).toBe(30);
    expect(daysInMonth(2026, 12)).toBe(31);
  });

  it('wallSeconds equals Date.UTC in seconds', () => {
    expect(wallSeconds(2026, 3, 8, 2, 30, 0)).toBe(Date.UTC(2026, 2, 8, 2, 30, 0) / 1000);
  });

  it('formatLocal renders ISO wall time with offset', () => {
    expect(formatLocal(wallSeconds(2026, 3, 8, 3, 0, 0), -14400)).toBe('2026-03-08T03:00:00-04:00');
    expect(formatLocal(wallSeconds(2026, 9, 21, 2, 0, 0), 0)).toBe('2026-09-21T02:00:00+00:00');
    expect(formatLocal(wallSeconds(2026, 4, 5, 1, 30, 0), 37800)).toBe('2026-04-05T01:30:00+10:30');
    expect(formatLocal(wallSeconds(1900, 1, 1, 0, 0, 0), -17762)).toBe('1900-01-01T00:00:00-04:56:02');
  });
});
