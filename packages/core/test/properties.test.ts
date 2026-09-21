import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { intlTz, matches, next, parse, prev } from '../src/index';
import type { Dialect, DstTag, Run, Schedule } from '../src/types';

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

/**
 * Shared by the per-dialect property table below and the DST-focused block: next is ordered - equal
 * instants allowed only straight after a DST catch-up run (DERIVATION H2) - and every run matches.
 */
function assertNextOrderedAndMatches(s: Schedule, start: Date, count: number): Run[] {
  const runs = next(s, { from: start, count });
  let last = start.getTime();
  let afterCatchUp = false;
  for (const run of runs) {
    if (afterCatchUp) expect(run.at.getTime()).toBeGreaterThanOrEqual(last);
    else expect(run.at.getTime()).toBeGreaterThan(last);
    expect(matches(s, run.at)).toBe(true);
    last = run.at.getTime();
    afterCatchUp = run.dst === 'skipped-adjusted';
  }
  return runs;
}

/** prev from just after the last of `count` runs from `start` returns the same runs reversed. */
function assertPrevMirrorsNext(s: Schedule, start: Date, count: number): void {
  const firstBatch = next(s, { from: start, count });
  if (firstBatch.length === 0) return;
  // Re-query up to the last instant so a group of runs sharing that instant is never cut in half.
  const lastAt = firstBatch[firstBatch.length - 1].at;
  const runs = next(s, { from: start, until: lastAt, count: 1000 });
  const back = prev(s, { from: new Date(lastAt.getTime() + 1000), count: runs.length });
  expect(back).toEqual([...runs].reverse());
}

/** inclusive returns `start` itself exactly when `start` matches. */
function assertInclusiveAgreesWithMatches(s: Schedule, start: Date): void {
  const [first] = next(s, { from: start, count: 1, inclusive: true });
  const hit = first !== undefined && first.at.getTime() === start.getTime();
  expect(hit).toBe(matches(s, start));
}

describe.each(cases)('%s properties', (dialect, exprs) => {
  it('next is ordered, after from, and every run matches', () => {
    fc.assert(
      fc.property(exprs, zone, from, (expr, tz, start) => {
        assertNextOrderedAndMatches(schedule(expr, dialect, tz), start, 5);
      }),
      { numRuns: RUNS },
    );
  });

  it('prev from just after the last run returns the same runs reversed', () => {
    fc.assert(
      fc.property(exprs, zone, from, (expr, tz, start) => {
        assertPrevMirrorsNext(schedule(expr, dialect, tz), start, 5);
      }),
      { numRuns: RUNS },
    );
  });

  it('inclusive returns from itself exactly when from matches', () => {
    fc.assert(
      fc.property(exprs, zone, from, (expr, tz, start) => {
        assertInclusiveAgreesWithMatches(schedule(expr, dialect, tz), start);
      }),
      { numRuns: RUNS },
    );
  });
});

/**
 * Real 2026 DST transitions for zones already in `zone`, biasing generation toward the gap/overlap
 * windows the `repeat` (kubernetes), `next-valid` (github-actions) and `once-first` (aws) strategies
 * branch on - uniform random day-of-month/month/zone choices land on a transition far too rarely to
 * exercise them (measured in the Task 7 review: an expected ~0.015 hits per full suite run for
 * github-actions' catch-up path). Verified against the library's own transition finder
 * (`intlTz.transitions`, run against the built `dist/index.js`, 2026-09-21):
 *
 *   America/New_York     gap     2026-03-08T07:00:00Z  (-18000 -> -14400, local 02:00 -> 03:00)
 *   America/New_York     overlap 2026-11-01T06:00:00Z  (-14400 -> -18000, local 01:00 repeats)
 *   Europe/London        gap     2026-03-29T01:00:00Z  (0 -> 3600, local 01:00 -> 02:00)
 *   Europe/London        overlap 2026-10-25T01:00:00Z  (3600 -> 0, local 01:00 repeats)
 *   Australia/Lord_Howe  gap     2026-10-03T15:30:00Z  (37800 -> 39600, a 30-minute shift, local 02:00 -> 02:30)
 *   Australia/Lord_Howe  overlap 2026-04-04T15:00:00Z  (39600 -> 37800, local 01:30 repeats)
 *   America/Havana       gap     2026-03-08T05:00:00Z  (-18000 -> -14400, local 00:00 -> 01:00, midnight transition)
 *   America/Havana       overlap 2026-11-01T05:00:00Z  (-14400 -> -18000, local 00:00 repeats)
 */
const TRANSITIONS_2026: { zone: string; at: string; kind: 'gap' | 'overlap' }[] = [
  { zone: 'America/New_York', at: '2026-03-08T07:00:00Z', kind: 'gap' },
  { zone: 'America/New_York', at: '2026-11-01T06:00:00Z', kind: 'overlap' },
  { zone: 'Europe/London', at: '2026-03-29T01:00:00Z', kind: 'gap' },
  { zone: 'Europe/London', at: '2026-10-25T01:00:00Z', kind: 'overlap' },
  { zone: 'Australia/Lord_Howe', at: '2026-10-03T15:30:00Z', kind: 'gap' },
  { zone: 'Australia/Lord_Howe', at: '2026-04-04T15:00:00Z', kind: 'overlap' },
  { zone: 'America/Havana', at: '2026-03-08T05:00:00Z', kind: 'gap' },
  { zone: 'America/Havana', at: '2026-11-01T05:00:00Z', kind: 'overlap' },
];

// The transitions above all sit at local hour 0, 1 or 2 (Lord Howe's overlap starts at 01:30), so this
// covers every one of them. Both fixed-time (no leading '*') and wildcard forms are included, because
// vixie-window/next-valid/repeat treat them differently (DERIVATION H1; corpus/README.md dstGap/dstOverlap).
const dstMinute = fc.constantFrom('0', '30', '15,45', '*', '*/20');
const dstHour = fc.constantFrom('0', '1', '2', '3', '0-3', '*', '*/2');

/** All-star day fields, in each dialect's own spelling, so only minute/hour drive the DST behaviour. */
function dstExpr(dialect: Dialect, minute: string, hour: string, wrapAws: boolean): string {
  switch (dialect) {
    case 'quartz':
      return `0 ${minute} ${hour} * * ?`;
    case 'aws': {
      const fields = `${minute} ${hour} * * ? *`;
      return wrapAws ? `cron(${fields})` : fields;
    }
    default:
      return `${minute} ${hour} * * *`;
  }
}

interface DstCase {
  dialect: Dialect;
  expr: string;
  zone: string;
  kind: 'gap' | 'overlap';
  from: Date;
}

/** One (dialect, expression, zone) landing near one of the verified transitions above, with `from`
 *  between 1 minute and 6 hours before the transition instant. */
function dstCaseFor(dialect: Dialect): fc.Arbitrary<DstCase> {
  return fc
    .tuple(fc.constantFrom(...TRANSITIONS_2026), dstMinute, dstHour, fc.boolean(), fc.integer({ min: 60, max: 21600 }))
    .map(([t, minute, hour, wrapAws, secondsBefore]) => {
      const transitionMs = Date.parse(t.at);
      return {
        dialect,
        expr: dstExpr(dialect, minute, hour, wrapAws),
        zone: t.zone,
        kind: t.kind,
        from: new Date(transitionMs - secondsBefore * 1000),
      };
    });
}

const DIALECTS: Dialect[] = ['vixie', 'kubernetes', 'github-actions', 'quartz', 'aws'];
const dstCase: fc.Arbitrary<DstCase> = fc.constantFrom(...DIALECTS).chain(dstCaseFor);

describe('DST-focused properties', () => {
  it('next is ordered, after from, and every run matches, across a real transition', () => {
    fc.assert(
      fc.property(dstCase, (c) => {
        assertNextOrderedAndMatches(schedule(c.expr, c.dialect, c.zone), c.from, 12);
      }),
      { numRuns: RUNS },
    );
  });

  it('prev from just after the last run returns the same runs reversed, across a real transition', () => {
    fc.assert(
      fc.property(dstCase, (c) => {
        assertPrevMirrorsNext(schedule(c.expr, c.dialect, c.zone), c.from, 12);
      }),
      { numRuns: RUNS },
    );
  });

  it('inclusive returns from itself exactly when from matches, across a real transition', () => {
    fc.assert(
      fc.property(dstCase, (c) => {
        assertInclusiveAgreesWithMatches(schedule(c.expr, c.dialect, c.zone), c.from);
      }),
      { numRuns: RUNS },
    );
  });

  it("dst tags match each dialect's strategy (corpus/dialects/*.json dstGap/dstOverlap)", () => {
    fc.assert(
      fc.property(dstCase, (c) => {
        const s = schedule(c.expr, c.dialect, c.zone);
        const runs = next(s, { from: c.from, count: 12 });

        for (const run of runs) {
          // skip: kubernetes, quartz and aws never catch up a spring-forward gap.
          if (c.dialect === 'kubernetes' || c.dialect === 'quartz' || c.dialect === 'aws') {
            expect(run.dst).not.toBe('skipped-adjusted');
          }
          // once-second: quartz only ever fires on the second (standard-offset) pass of an overlap.
          if (c.dialect === 'quartz') expect(run.dst).not.toBe('ambiguous-first');
          // once-first: aws only ever fires on the first (pre-shift) pass of an overlap.
          if (c.dialect === 'aws') expect(run.dst).not.toBe('ambiguous-second');
          // `scheduled` is set exactly on a skipped-adjusted run (corpus/README.md, cases/next).
          if (run.dst === 'skipped-adjusted') expect(run.scheduled).toBeDefined();
          else expect(run.scheduled).toBeUndefined();
        }

        // next-valid: at most one catch-up run per gap, and it is never joined by another run at the
        // same instant - the strategy suppresses itself when a natural run already lands there.
        if (c.dialect === 'github-actions') {
          const caughtUp = runs.filter((run) => run.dst === 'skipped-adjusted');
          expect(caughtUp.length).toBeLessThanOrEqual(1);
          if (caughtUp.length === 1) {
            const at = caughtUp[0].at.getTime();
            expect(runs.filter((run) => run.at.getTime() === at)).toHaveLength(1);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  // A seeded, deterministic sample per dialect, so a property passing above cannot silently mean the
  // strategy it targets was never reached again (the Task 7 review's vacuity finding).
  it('every dst tag each dialect can emit is actually observed in a fixed sample', () => {
    const expected: Record<Dialect, DstTag[]> = {
      vixie: ['skipped-adjusted', 'ambiguous-first', 'ambiguous-second'],
      kubernetes: ['ambiguous-first', 'ambiguous-second'],
      'github-actions': ['skipped-adjusted', 'ambiguous-first', 'ambiguous-second'],
      quartz: ['ambiguous-second'],
      aws: ['ambiguous-first'],
    };

    for (const dialect of DIALECTS) {
      const seen = new Map<DstTag, number>();
      for (const c of fc.sample(dstCaseFor(dialect), { numRuns: 400, seed: 20260921 })) {
        const s = schedule(c.expr, c.dialect, c.zone);
        for (const run of next(s, { from: c.from, count: 12 })) {
          if (run.dst) seen.set(run.dst, (seen.get(run.dst) ?? 0) + 1);
        }
      }
      for (const tag of expected[dialect]) expect(seen.get(tag) ?? 0).toBeGreaterThan(0);
      console.info(`DST coverage ${dialect}:`, Object.fromEntries(seen));
    }
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
        // "nothing else" means local really does round-trip in both zones...
        for (const run of [...a, ...b]) expect(new Date(run.local).getTime()).toBe(run.at.getTime());
        // ...and "changes local" means it actually differs whenever the two zones' offsets differ at
        // that instant (offsets read independently from the library's own transition finder, not from
        // the `local` strings under test).
        a.forEach((run, i) => {
          const sec = Math.floor(run.at.getTime() / 1000);
          if (intlTz.offsetAt(tzA, sec) !== intlTz.offsetAt(tzB, sec)) expect(run.local).not.toBe(b[i].local);
        });
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
  // A schedule string this file's own generators would produce - the `ok` branch below is reached far
  // too rarely (measured at 0.07% in the Task 7 review) without these, since a purely random string
  // almost never happens to parse.
  const validExprs = fc.oneof(
    vixieExpr, kubernetesExpr, githubExpr, quartzExpr, awsExpr, intervalCase.map(([, expr]) => expr),
  );

  /** Delete, duplicate or replace one character, or append a token - a "near miss" of a valid expression. */
  function mutate(s: string, op: number, pos: number, token: string): string {
    if (s.length === 0) return token;
    const i = pos % s.length;
    switch (op % 4) {
      case 0: return s.slice(0, i) + s.slice(i + 1);
      case 1: return s.slice(0, i) + s[i] + s.slice(i);
      case 2: return s.slice(0, i) + token + s.slice(i + 1);
      default: return `${s}${token}`;
    }
  }

  const mutatedValid = fc
    .tuple(validExprs, fc.nat(3), fc.nat(), fc.constantFrom('(', ')', '@', '/', '-', ',', '?', '#', 'L', 'W', '*'))
    .map(([expr, op, pos, token]) => mutate(expr, op, pos, token));

  const hostile = fc.oneof(
    fc.string(),
    fc.string().map((s) => `cron(${s}`),
    fc.string().map((s) => `cron(${s})`),
    fc.string().map((s) => `rate(${s})`),
    fc.string().map((s) => `@every ${s}`),
    fc.tuple(fc.string(), fc.string()).map(([a, b]) => `${a} cron(${b}) `),
    validExprs,
    mutatedValid,
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
