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

/** A value with a step, which cronie rejects and the other four dialects read as value-max/step. */
function stepped(min: number, max: number): fc.Arbitrary<string> {
  return fc
    .tuple(fc.integer({ min, max }), fc.integer({ min: 1, max: Math.max(1, max - min) }))
    .map(([a, step]) => `${a}/${step}`);
}

const robfigField = (min: number, max: number) => fc.oneof(field(min, max), stepped(min, max), fc.constant('?'));
const kubernetesExpr = fc
  .tuple(robfigField(0, 59), robfigField(0, 23), robfigField(1, 31), robfigField(1, 12), robfigField(0, 6))
  .map((parts) => parts.join(' '));

const githubField = (min: number, max: number) => fc.oneof(field(min, max), stepped(min, max));
const githubExpr = fc
  .tuple(githubField(0, 59), githubField(0, 23), githubField(1, 31), githubField(1, 12), githubField(0, 6))
  .map((parts) => parts.join(' '));

const awsDays = fc.oneof(
  field(1, 31).map((dom) => `${dom} MONTH ?`),
  fc.constantFrom('L', '15W', '1W', '31W').map((dom) => `${dom} MONTH ?`),
  field(1, 7).map((dow) => `? MONTH ${dow}`),
  fc.constantFrom('6L', '3#2', '1#5', 'L').map((dow) => `? MONTH ${dow}`),
);
const awsExpr = fc
  .tuple(githubField(0, 59), githubField(0, 23), awsDays, field(1, 12), fc.constantFrom('*', '2025-2028', '2026', '2026/1'), fc.boolean())
  .map(([mi, h, days, month, year, wrap]) => {
    const fields = `${mi} ${h} ${days.replace('MONTH', month)} ${year}`;
    return wrap ? `cron(${fields})` : fields;
  });

const zone = fc.constantFrom('UTC', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Asia/Kolkata', 'America/Havana');

const from = fc
  .integer({ min: Date.UTC(2025, 0, 1) / 1000, max: Date.UTC(2027, 11, 31) / 1000 })
  .map((sec) => new Date(sec * 1000));

function schedule(expr: string, dialect: Dialect, timezone: string): Schedule {
  const r = parse(expr, { dialect, timezone });
  if (!r.ok) throw new Error(`generator produced an invalid expression "${expr}": ${r.error.code}`);
  return r.value;
}

const cases: [Dialect, fc.Arbitrary<string>][] = [
  ['vixie', vixieExpr], ['kubernetes', kubernetesExpr], ['github-actions', githubExpr], ['quartz', quartzExpr], ['aws', awsExpr],
];

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

const intervalCase: fc.Arbitrary<[Dialect, string]> = fc.oneof(
  fc.tuple(fc.integer({ min: 1, max: 72 }), fc.constantFrom('s', 'm', 'h')).map(([n, u]): [Dialect, string] => ['kubernetes', `@every ${n}${u}`]),
  fc.tuple(fc.integer({ min: 2, max: 90 }), fc.constantFrom('minutes', 'hours', 'days')).map(([n, u]): [Dialect, string] => ['aws', `rate(${n} ${u})`]),
);

describe('interval properties', () => {
  it('runs are evenly spaced, after from, on or after the anchor, and match', () => {
    fc.assert(
      fc.property(intervalCase, zone, from, from, ([dialect, expr], tz, anchor, start) => {
        const s = schedule(expr, dialect, tz);
        const step = s.interval!.seconds * 1000;
        const runs = next(s, { anchor, from: start, count: 5 });
        expect(runs).toHaveLength(5);
        runs.forEach((run, i) => {
          expect(run.at.getTime()).toBeGreaterThan(start.getTime());
          expect(run.at.getTime()).toBeGreaterThanOrEqual(anchor.getTime());
          expect((run.at.getTime() - anchor.getTime()) % step).toBe(0);
          if (i > 0) expect(run.at.getTime() - runs[i - 1].at.getTime()).toBe(step);
          expect(new Date(run.local).getTime()).toBe(run.at.getTime());
          expect(run.dst).toBeUndefined();
          expect(matches(s, run.at, { anchor })).toBe(true);
        });
      }),
      { numRuns: RUNS },
    );
  });

  it('the time zone changes local and nothing else', () => {
    fc.assert(
      fc.property(intervalCase, zone, zone, from, from, ([dialect, expr], tzA, tzB, anchor, start) => {
        const a = next(schedule(expr, dialect, tzA), { anchor, from: start, count: 5 });
        const b = next(schedule(expr, dialect, tzB), { anchor, from: start, count: 5 });
        expect(a.map((r) => r.at.getTime())).toEqual(b.map((r) => r.at.getTime()));
      }),
      { numRuns: RUNS },
    );
  });

  it('prev from just after the last run returns the same runs reversed', () => {
    fc.assert(
      fc.property(intervalCase, zone, from, from, ([dialect, expr], tz, anchor, start) => {
        const s = schedule(expr, dialect, tz);
        const runs = next(s, { anchor, from: start, count: 5 });
        const back = prev(s, { anchor, from: new Date(runs[4].at.getTime() + 1000), count: 5 });
        expect(back).toEqual([...runs].reverse());
      }),
      { numRuns: RUNS },
    );
  });
});

describe('never throws', () => {
  const hostile = fc.oneof(
    fc.string(),
    fc.string().map((s) => `cron(${s}`),
    fc.string().map((s) => `cron(${s})`),
    fc.string().map((s) => `rate(${s})`),
    fc.string().map((s) => `@every ${s}`),
    fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${a} cron(${b}) `),
  );

  it('parse, next, prev and matches accept any string', () => {
    fc.assert(
      fc.property(hostile, (input) => {
        expect(() => {
          const r = parse(input);
          next(input, { count: 2 });
          prev(input, { count: 2 });
          matches(input, new Date(0));
          if (r.ok) {
            next(r.value, { count: 2, anchor: new Date(Number.NaN) });
            matches(r.value, new Date(0), { anchor: new Date(0) });
          }
        }).not.toThrow();
      }),
      { numRuns: 500 },
    );
  });
});
