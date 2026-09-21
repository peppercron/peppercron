import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matches, next, parse, prev } from '../src/index';
import type { Dialect, Schedule } from '../src/types';

const RUNS = 150;

/** One cron field over [min, max]: '*', a value, a range, or a step. */
function field(min: number, max: number): fc.Arbitrary<string> {
  const n = fc.integer({ min, max });
  return fc.oneof(
    fc.constant('*'),
    n.map(String),
    fc.tuple(n, n).map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`),
    fc.integer({ min: 1, max: Math.max(1, max - min) }).map((step) => `*/${step}`),
    fc.tuple(n, n).map(([a, b]) => `${a},${b}`),
  );
}

/** Vixie writes Sunday as 0 or 7, so reversed ranges ending on Sunday are a real class (DERIVATION H3). */
const vixieDow = fc.oneof(
  field(0, 7),
  fc.integer({ min: 1, max: 7 }).map((n) => `${n}-0`),
  fc.tuple(fc.integer({ min: 1, max: 7 }), fc.integer({ min: 1, max: 7 })).map(([n, step]) => `${n}-0/${step}`),
  fc.integer({ min: 0, max: 6 }).map((n) => `${n}-7`),
);

const vixieExpr = fc
  .tuple(field(0, 59), field(0, 23), field(1, 31), field(1, 12), vixieDow)
  .map((parts) => parts.join(' '));

const quartzDays = fc.oneof(
  field(1, 31).map((dom) => `${dom} MONTH ?`),
  fc.constantFrom('L', 'LW', '15W', 'L-2').map((dom) => `${dom} MONTH ?`),
  field(1, 7).map((dow) => `? MONTH ${dow}`),
  fc.constantFrom('6#3', '2#1', '6L', '1L').map((dow) => `? MONTH ${dow}`),
);

const quartzExpr = fc
  .tuple(field(0, 59), field(0, 59), field(0, 23), quartzDays, field(1, 12))
  .map(([s, mi, h, days, month]) => `${s} ${mi} ${h} ${days.replace('MONTH', month)}`);

const zone = fc.constantFrom('UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata');

const from = fc
  .integer({ min: Date.UTC(2025, 0, 1) / 1000, max: Date.UTC(2027, 11, 31) / 1000 })
  .map((sec) => new Date(sec * 1000));

function schedule(expr: string, dialect: Dialect, timezone: string): Schedule {
  const r = parse(expr, { dialect, timezone });
  if (!r.ok) throw new Error(`generator produced an invalid expression "${expr}": ${r.error.code}`);
  return r.value;
}

const cases: [Dialect, fc.Arbitrary<string>][] = [['vixie', vixieExpr], ['quartz', quartzExpr]];

describe.each(cases)('%s properties', (dialect, exprs) => {
  it('next is ordered, after from, and every run matches', () => {
    fc.assert(
      fc.property(exprs, zone, from, (expr, tz, start) => {
        const s = schedule(expr, dialect, tz);
        const runs = next(s, { from: start, count: 5 });
        let last = start.getTime();
        let afterCatchUp = false;
        for (const run of runs) {
          // Equal instants are allowed only straight after a DST catch-up run (DERIVATION H2).
          if (afterCatchUp) expect(run.at.getTime()).toBeGreaterThanOrEqual(last);
          else expect(run.at.getTime()).toBeGreaterThan(last);
          expect(matches(s, run.at)).toBe(true);
          last = run.at.getTime();
          afterCatchUp = run.dst === 'skipped-adjusted';
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('prev from just after the last run returns the same runs reversed', () => {
    fc.assert(
      fc.property(exprs, zone, from, (expr, tz, start) => {
        const s = schedule(expr, dialect, tz);
        const firstFive = next(s, { from: start, count: 5 });
        if (firstFive.length === 0) return;
        // Re-query up to the last instant so a group of runs sharing that instant is never cut in half.
        const lastAt = firstFive[firstFive.length - 1].at;
        const runs = next(s, { from: start, until: lastAt, count: 1000 });
        const back = prev(s, { from: new Date(lastAt.getTime() + 1000), count: runs.length });
        expect(back).toEqual([...runs].reverse());
      }),
      { numRuns: RUNS },
    );
  });

  it('inclusive returns from itself exactly when from matches', () => {
    fc.assert(
      fc.property(exprs, zone, from, (expr, tz, start) => {
        const s = schedule(expr, dialect, tz);
        const [first] = next(s, { from: start, count: 1, inclusive: true });
        const hit = first !== undefined && first.at.getTime() === start.getTime();
        expect(hit).toBe(matches(s, start));
      }),
      { numRuns: RUNS },
    );
  });
});
