import { describe, expect, it } from 'vitest';
import { createCore } from '../src/core';
import type { Dialect, Run, Schedule } from '../src/types';
import { T_DAY_GAP, T_GAP, testTz } from './helpers/fake-tz';

const core = createCore(testTz);
const at = (iso: string) => new Date(iso);
const isos = (runs: Run[]) => runs.map((r) => r.at.toISOString());

function sched(expr: string, dialect: Dialect, timezone = 'UTC'): Schedule {
  const r = core.parse(expr, { dialect, timezone });
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`);
  return r.value;
}

describe('next: basics', () => {
  it('returns the next runs after from, with local time', () => {
    const runs = core.next('0 2 * * 1', { from: at('2026-09-21T00:00:00Z'), count: 3 });
    expect(isos(runs)).toEqual(['2026-09-21T02:00:00.000Z', '2026-09-28T02:00:00.000Z', '2026-10-05T02:00:00.000Z']);
    expect(runs[0]).toEqual({ at: at('2026-09-21T02:00:00Z'), local: '2026-09-21T02:00:00+00:00' });
  });

  it('excludes from unless inclusive', () => {
    const from = at('2026-09-21T02:00:00Z');
    expect(isos(core.next('0 2 * * 1', { from, count: 1 }))).toEqual(['2026-09-28T02:00:00.000Z']);
    expect(isos(core.next('0 2 * * 1', { from, count: 1, inclusive: true }))).toEqual(['2026-09-21T02:00:00.000Z']);
  });

  it('stops at until, inclusive', () => {
    const runs = core.next('0 * * * *', { from: at('2026-09-21T00:00:00Z'), until: at('2026-09-21T02:00:00Z') });
    expect(isos(runs)).toEqual(['2026-09-21T01:00:00.000Z', '2026-09-21T02:00:00.000Z']);
  });

  it('defaults to 10 runs and gives up after the 5-year horizon', () => {
    expect(core.next('* * * * *', { from: at('2026-09-21T00:00:00Z') })).toHaveLength(10);
    expect(core.next('0 0 31 4 *', { from: at('2026-09-21T00:00:00Z') })).toEqual([]);
    expect(isos(core.next('0 0 29 2 *', { from: at('2026-09-21T00:00:00Z'), count: 3 }))).toEqual(['2028-02-29T00:00:00.000Z']);
  });

  it('computes wall time in the schedule timezone', () => {
    const runs = core.next(sched('0 9 * * *', 'vixie', 'Test/NY'), { from: at('2026-01-10T00:00:00Z'), count: 1 });
    expect(runs).toEqual([{ at: at('2026-01-10T14:00:00Z'), local: '2026-01-10T09:00:00-05:00' }]);
  });
});

describe('next: spring-forward gap', () => {
  it('vixie fixed-time: one catch-up run at the transition, tagged skipped-adjusted', () => {
    const runs = core.next(sched('30 2 * * *', 'vixie', 'Test/NY'), { from: at('2026-03-07T12:00:00Z'), count: 3 });
    expect(isos(runs)).toEqual(['2026-03-08T07:00:00.000Z', '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
    expect(runs.map((r) => r.dst)).toEqual(['skipped-adjusted', undefined, undefined]);
    expect(runs[0].local).toBe('2026-03-08T03:00:00-04:00');
    expect(runs[0].scheduled).toBe('2026-03-08T02:30:00');
  });

  it('vixie fixed-time: one catch-up run per skipped matching minute (H2)', () => {
    const runs = core.next(sched('0,30 2 * * *', 'vixie', 'Test/NY'), { from: at('2026-03-08T00:00:00Z'), count: 3 });
    expect(isos(runs)).toEqual(['2026-03-08T07:00:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-09T06:00:00.000Z']);
    expect(runs.map((r) => r.dst)).toEqual(['skipped-adjusted', 'skipped-adjusted', undefined]);
    // The two runs share an instant and a local time; only `scheduled` tells them apart.
    expect(runs.map((r) => r.scheduled)).toEqual(['2026-03-08T02:00:00', '2026-03-08T02:30:00', undefined]);
  });

  it('vixie fixed-time: a gap wider than cronie s three-hour catch-up window gets no catch-up (H2)', () => {
    const runs = core.next(sched('0 0-23 * * *', 'vixie', 'Test/Apia'), { from: at('2011-12-30T07:30:00Z'), count: 3 });
    expect(isos(runs)).toEqual(['2011-12-30T08:00:00.000Z', '2011-12-30T09:00:00.000Z', '2011-12-30T10:00:00.000Z']);
    expect(runs.every((r) => r.dst === undefined)).toBe(true);
    // The whole skipped wall day would otherwise arrive as 24 catch-up runs at the transition instant.
    expect(runs[2].at.getTime() / 1000).toBe(T_DAY_GAP);
    expect(runs[2].local).toBe('2011-12-31T00:00:00+14:00');
  });

  it('vixie fixed-time: the natural run at the transition instant still happens after the catch-up', () => {
    const runs = core.next(sched('0 2,3 * * *', 'vixie', 'Test/NY'), { from: at('2026-03-08T00:00:00Z'), count: 3 });
    expect(isos(runs)).toEqual(['2026-03-08T07:00:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-09T06:00:00.000Z']);
    expect(runs.map((r) => r.dst)).toEqual(['skipped-adjusted', undefined, undefined]);
    expect(runs.map((r) => r.scheduled)).toEqual(['2026-03-08T02:00:00', undefined, undefined]);
  });

  it('vixie wildcard: skipped wall times simply do not occur', () => {
    const runs = core.next(sched('*/30 * * * *', 'vixie', 'Test/NY'), { from: at('2026-03-08T06:00:00Z'), count: 4 });
    expect(isos(runs)).toEqual(['2026-03-08T06:30:00.000Z', '2026-03-08T07:00:00.000Z', '2026-03-08T07:30:00.000Z', '2026-03-08T08:00:00.000Z']);
    expect(runs.every((r) => r.dst === undefined)).toBe(true);
  });

  it('quartz: a run in the gap is skipped', () => {
    const runs = core.next(sched('0 30 2 * * ?', 'quartz', 'Test/NY'), { from: at('2026-03-07T12:00:00Z'), count: 2 });
    expect(isos(runs)).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
  });

  it('includes a catch-up run that falls exactly on until', () => {
    const runs = core.next(sched('30 2 * * *', 'vixie', 'Test/NY'), { from: at('2026-03-08T00:00:00Z'), until: new Date(T_GAP * 1000) });
    expect(isos(runs)).toEqual(['2026-03-08T07:00:00.000Z']);
  });
});

describe('next: fall-back overlap', () => {
  it('vixie fixed-time: runs once, at the first occurrence', () => {
    const runs = core.next(sched('30 1 * * *', 'vixie', 'Test/NY'), { from: at('2026-11-01T00:00:00Z'), count: 2 });
    expect(runs).toEqual([
      { at: at('2026-11-01T05:30:00Z'), local: '2026-11-01T01:30:00-04:00', dst: 'ambiguous-first' },
      { at: at('2026-11-02T06:30:00Z'), local: '2026-11-02T01:30:00-05:00' },
    ]);
  });

  it('vixie fixed-time: still suppressed when from is already inside the second pass', () => {
    const runs = core.next(sched('30 1 * * *', 'vixie', 'Test/NY'), { from: at('2026-11-01T06:10:00Z'), count: 1 });
    expect(isos(runs)).toEqual(['2026-11-02T06:30:00.000Z']);
  });

  it('vixie wildcard: runs through both passes', () => {
    const runs = core.next(sched('*/30 * * * *', 'vixie', 'Test/NY'), { from: at('2026-11-01T05:00:00Z'), count: 5 });
    expect(isos(runs)).toEqual([
      '2026-11-01T05:30:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T06:30:00.000Z',
      '2026-11-01T07:00:00.000Z', '2026-11-01T07:30:00.000Z',
    ]);
    expect(runs.map((r) => r.dst)).toEqual(['ambiguous-first', 'ambiguous-second', 'ambiguous-second', undefined, undefined]);
    expect(runs[1].local).toBe('2026-11-01T01:00:00-05:00');
  });

  it('quartz: runs once, on the second pass, even for an hourly schedule (H6)', () => {
    const runs = core.next(sched('0 0 * * * ?', 'quartz', 'Test/NY'), { from: at('2026-11-01T04:30:00Z'), count: 3 });
    expect(isos(runs)).toEqual(['2026-11-01T06:00:00.000Z', '2026-11-01T07:00:00.000Z', '2026-11-01T08:00:00.000Z']);
    expect(runs[0]).toEqual({ at: at('2026-11-01T06:00:00Z'), local: '2026-11-01T01:00:00-05:00', dst: 'ambiguous-second' });
  });
});

describe('prev', () => {
  it('returns the most recent runs first, excluding from unless inclusive', () => {
    const from = at('2026-09-21T02:00:00Z');
    expect(isos(core.prev('0 2 * * 1', { from, count: 2 }))).toEqual(['2026-09-14T02:00:00.000Z', '2026-09-07T02:00:00.000Z']);
    expect(isos(core.prev('0 2 * * 1', { from, count: 2, inclusive: true }))).toEqual(['2026-09-21T02:00:00.000Z', '2026-09-14T02:00:00.000Z']);
  });

  it('reaches back years for sparse schedules, but not past the horizon', () => {
    expect(isos(core.prev('0 0 29 2 *', { from: at('2026-09-21T00:00:00Z'), count: 2 }))).toEqual(['2024-02-29T00:00:00.000Z']);
  });

  it('stops at until', () => {
    const runs = core.prev('0 * * * *', { from: at('2026-09-21T03:30:00Z'), until: at('2026-09-21T02:00:00Z') });
    expect(isos(runs)).toEqual(['2026-09-21T03:00:00.000Z', '2026-09-21T02:00:00.000Z']);
  });

  // Both schedules are valid and both used to be collected whole before slicing: gigabytes and
  // tens of seconds for what is three objects. The bound is wall clock, but the budget it guards
  // is memory, so it is set far above any plausible machine variation.
  it('finds the newest runs of a dense year-restricted schedule without collecting the window', () => {
    const started = Date.now();
    const runs = core.prev(sched('* * * * * ? 2022', 'quartz'), { from: at('2026-09-21T00:00:00Z'), count: 3 });
    expect(isos(runs)).toEqual(['2022-12-31T23:59:59.000Z', '2022-12-31T23:59:58.000Z', '2022-12-31T23:59:57.000Z']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('finds the newest runs of a dense month-restricted schedule without collecting the window', () => {
    const started = Date.now();
    const runs = core.prev(sched('* * * * 1 ?', 'quartz'), { from: at('2026-09-21T00:00:00Z'), count: 2 });
    expect(isos(runs)).toEqual(['2026-01-31T23:59:59.000Z', '2026-01-31T23:59:58.000Z']);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('returns the natural run before the catch-up run it shares an instant with', () => {
    const runs = core.prev(sched('0 2,3 * * *', 'vixie', 'Test/NY'), { from: at('2026-03-08T07:00:01Z'), count: 2 });
    expect(isos(runs)).toEqual(['2026-03-08T07:00:00.000Z', '2026-03-08T07:00:00.000Z']);
    expect(runs.map((r) => r.dst)).toEqual([undefined, 'skipped-adjusted']);
    expect(runs.map((r) => r.scheduled)).toEqual([undefined, '2026-03-08T02:00:00']);
  });

  it('carries the same DST tags as next', () => {
    const runs = core.prev(sched('*/30 * * * *', 'vixie', 'Test/NY'), { from: at('2026-11-01T07:00:00Z'), count: 4 });
    expect(isos(runs)).toEqual(['2026-11-01T06:30:00.000Z', '2026-11-01T06:00:00.000Z', '2026-11-01T05:30:00.000Z', '2026-11-01T05:00:00.000Z']);
    expect(runs.map((r) => r.dst)).toEqual(['ambiguous-second', 'ambiguous-second', 'ambiguous-first', 'ambiguous-first']);
  });
});

describe('matches', () => {
  it('is true exactly for instants next would emit', () => {
    expect(core.matches('0 2 * * 1', at('2026-09-21T02:00:00Z'))).toBe(true);
    expect(core.matches('0 2 * * 1', at('2026-09-21T02:01:00Z'))).toBe(false);
    expect(core.matches('0 2 * * 1', at('2026-09-21T02:00:00.500Z'))).toBe(false);
    expect(core.matches('0 0 2 ? * MON', at('2026-09-21T02:00:01Z'))).toBe(false);
  });

  it('follows the DST strategies', () => {
    const fixed = sched('30 2 * * *', 'vixie', 'Test/NY');
    expect(core.matches(fixed, at('2026-03-08T07:00:00Z'))).toBe(true);
    expect(core.matches(sched('0 30 2 * * ?', 'quartz', 'Test/NY'), at('2026-03-08T07:00:00Z'))).toBe(false);
    const daily = sched('30 1 * * *', 'vixie', 'Test/NY');
    expect(core.matches(daily, at('2026-11-01T05:30:00Z'))).toBe(true);
    expect(core.matches(daily, at('2026-11-01T06:30:00Z'))).toBe(false);
    const quartzDaily = sched('0 30 1 * * ?', 'quartz', 'Test/NY');
    expect(core.matches(quartzDaily, at('2026-11-01T05:30:00Z'))).toBe(false);
    expect(core.matches(quartzDaily, at('2026-11-01T06:30:00Z'))).toBe(true);
  });
});

describe('hostile input', () => {
  const from = at('2026-09-21T00:00:00Z');

  it('clamps count to 1..1000 and falls back to 10 for NaN (Review Focus 3)', () => {
    expect(core.next('* * * * *', { from, count: 0 })).toHaveLength(1);
    expect(core.next('* * * * *', { from, count: -5 })).toHaveLength(1);
    expect(core.next('* * * * *', { from, count: Number.NaN })).toHaveLength(10);
    expect(core.next('* * * * *', { from, count: 5000 })).toHaveLength(1000);
    expect(core.prev('* * * * *', { from, count: 5000 })).toHaveLength(1000);
  });

  it('handles an Invalid Date and a millisecond fraction in from (Review Focus 4)', () => {
    expect(core.next('0 2 * * 1', { from: new Date('nope') })).toEqual([]);
    expect(core.prev('0 2 * * 1', { from: new Date('nope') })).toEqual([]);
    expect(core.matches('0 2 * * 1', new Date('nope'))).toBe(false);
    expect(isos(core.next('0 2 * * 1', { from: at('2026-09-21T02:00:00.500Z'), count: 1 }))).toEqual(['2026-09-28T02:00:00.000Z']);
    expect(isos(core.next('0 2 * * 1', { from: at('2026-09-21T01:59:59.500Z'), count: 1 }))).toEqual(['2026-09-21T02:00:00.000Z']);
    expect(isos(core.prev('0 2 * * 1', { from: at('2026-09-21T02:00:00.500Z'), count: 1 }))).toEqual(['2026-09-21T02:00:00.000Z']);
  });

  it('returns empty results for a Schedule whose timezone this host does not know (Review Focus 5)', () => {
    const foreign = { ...sched('0 2 * * 1', 'vixie'), timezone: 'Nowhere/Land' };
    expect(core.next(foreign, { from })).toEqual([]);
    expect(core.prev(foreign, { from })).toEqual([]);
    expect(core.matches(foreign, at('2026-09-21T02:00:00Z'))).toBe(false);
  });

  it('treats a null options object as no options (Ruling 11 class)', () => {
    expect(core.next('0 2 * * 1', null as unknown as undefined)).toHaveLength(10);
    expect(core.prev('0 2 * * 1', null as unknown as undefined)).toHaveLength(10);
    expect(core.parse('0 2 * * 1', null as unknown as undefined).ok).toBe(true);
  });

  it('never returns a run whose instant a Date cannot hold', () => {
    // 8.64e15 ms is the largest instant a Date represents; every run past it used to be an Invalid Date.
    expect(core.next('* * * * *', { from: new Date(8.64e15) })).toEqual([]);
    expect(core.next('* * * * *', { from: new Date(8.64e15), inclusive: true })
      .every((r) => !Number.isNaN(r.at.getTime()))).toBe(true);
  });

  it('returns empty results for unparseable strings, @reboot and junk objects', () => {
    expect(core.next('not a cron', { from })).toEqual([]);
    expect(core.matches('not a cron', from)).toBe(false);
    expect(core.next('@reboot', { from })).toEqual([]);
    expect(core.next({} as Schedule, { from })).toEqual([]);
    expect(core.next(null as unknown as Schedule, { from })).toEqual([]);
  });

  it('never throws for a hand-built Schedule whose fields have names but no values/terms', () => {
    const real = sched('0 2 * * 1', 'vixie');
    const malformed = { ...real, fields: real.fields.map((f) => ({ name: f.name })) } as unknown as Schedule;
    expect(core.next(malformed, { from })).toEqual([]);
    expect(core.prev(malformed, { from })).toEqual([]);
    expect(core.matches(malformed, from)).toBe(false);
  });
});

describe('kubernetes DST (DERIVATION K11-K13)', () => {
  it('skips a fixed-time run that falls in a gap', () => {
    const runs = core.next(sched('30 2 * * *', 'kubernetes', 'Test/NY'), { from: at('2026-03-07T12:00:00Z'), count: 1 });
    expect(isos(runs)).toEqual(['2026-03-09T06:30:00.000Z']);
  });

  it('fires on both passes of an overlap', () => {
    const runs = core.next(sched('30 1 * * *', 'kubernetes', 'Test/NY'), { from: at('2026-10-31T12:00:00Z'), count: 2 });
    expect(runs.map((r) => [r.at.toISOString(), r.dst])).toEqual([
      ['2026-11-01T05:30:00.000Z', 'ambiguous-first'],
      ['2026-11-01T06:30:00.000Z', 'ambiguous-second'],
    ]);
  });
});
