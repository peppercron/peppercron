# @peppercron/core

Parse cron schedules and compute when they run, correctly across timezones and DST.

- Zero runtime dependencies. Works in Node and in the browser.
- Never throws. `parse` returns a result; `next`, `prev` and `matches` return `[]` or `false` for input they cannot use.
- DST behaviour follows what each scheduler really does: derived from the cronie, Quartz and robfig/cron source where there is one, and from GitHub's and AWS's own documentation where there is not - with every remaining gap written down as an explicit assumption rather than a guess (see the corpus [Assumptions list](../../corpus/README.md#assumptions)).
- Every parsed field and term carries its character span in the source, for editors and error underlines.
- About 7 KB gzipped.

Five dialects are supported. `describe`, `lint` and `convert` are planned.

| Dialect | What it is | A run in a gap (spring forward) | A run in an overlap (fall back) |
| --- | --- | --- | --- |
| `vixie` | Linux crontab, matching cronie | A fixed-time job catches up, once per skipped wall time it matches | A fixed-time job fires once, on the first pass; a wildcard job on both |
| `kubernetes` | A CronJob's `spec.schedule` (robfig/cron v3, as pinned by Kubernetes) | Silently skipped - no run, no catch-up | Fires twice, once on each pass |
| `github-actions` | A workflow's `on.schedule` `cron:` entry | A fixed-time job advances to the next valid time, once per gap | A fixed-time job fires once, on the first pass; a wildcard job on both |
| `quartz` | Java Quartz's `CronExpression` | Skipped - no run | Fires once, on the second pass |
| `aws` | EventBridge's `cron(...)` and `rate(...)` | Skipped - no run | Fires once, on the first pass |

## Install

```sh
npm install @peppercron/core
```

The package ships ESM and CommonJS builds with type declarations. It needs a runtime with `Intl.DateTimeFormat` timezone support, which every current browser and Node version has.

## Parse

```ts
import { parse } from '@peppercron/core';

const r = parse('0 9 * * MON-FRI', { timezone: 'Europe/London' });
if (r.ok) {
  r.value.dialect;          // 'vixie' (detected)
  r.value.fields[4].values; // [1, 2, 3, 4, 5]  (Sunday is always 0)
  r.value.fields[4].span;   // [8, 15]
  r.value.candidates;       // ['vixie', 'kubernetes', 'github-actions'] - all three read this the same way
}

parse('0 25 * * *');
// { ok: false, error: { code: 'out-of-range', message: '25 is outside 0-23 for hour', span: [2, 4] } }
```

`parse(input, opts?)` takes:

| Option | Default | Meaning |
| --- | --- | --- |
| `dialect` | detected | `'vixie'`, `'kubernetes'`, `'github-actions'`, `'quartz'` or `'aws'`. When omitted, the dialect is detected from the expression; if more than one fits, `candidates` lists them. |
| `timezone` | `'UTC'` | An IANA zone name such as `'America/New_York'`. |

Detection is honest about ambiguity rather than guessing: a plain five-field expression parses
identically under several dialects, so `candidates` names all of them.

```ts
parse('0 9 * * 1');
// r.value.dialect: 'vixie', r.value.candidates: ['vixie', 'kubernetes', 'github-actions']
```

AWS expressions may be wrapped in `cron(...)`; the bare fields parse too. Spans still index the
original string, wrapper included:

```ts
const r = parse('cron(15 10 ? * 6L *)');
// r.value.dialect: 'aws'
// r.value.fields[0]: { name: 'minute', raw: '15', span: [5, 7], ... } - span skips the "cron(" prefix
```

It also understands macros such as `@daily`, and a pasted crontab line with a command on the end (the command is returned as `trailing`).

Quartz terms are parsed into structured form: `L`, `L-3`, `LW`, `15W`, `6L` and `6#3`.

Spans are `[start, end)` offsets into the untouched input string, in UTF-16 code units (the same units as JavaScript string indices).

## Run times

```ts
import { parse, next, prev, matches } from '@peppercron/core';

const s = parse('0 9 * * MON-FRI', { timezone: 'Europe/London' });
if (s.ok) {
  next(s.value, { from: new Date('2026-09-21T00:00:00Z'), count: 2 });
  // [ { at: 2026-09-21T08:00:00.000Z, local: '2026-09-21T09:00:00+01:00' },
  //   { at: 2026-09-22T08:00:00.000Z, local: '2026-09-22T09:00:00+01:00' } ]
}

prev('*/15 * * * *', { from: new Date('2026-09-21T00:00:00Z'), count: 2 });
// newest first: 23:45, then 23:30 on 2026-09-20

matches('*/15 * * * *', new Date('2026-09-21T00:15:00Z')); // true
```

`next`, `prev` and `matches` accept a parsed `Schedule` or a string. A string is parsed with the defaults above (detected dialect, UTC), so parse it yourself when you need a timezone.

| Option | Default | Meaning |
| --- | --- | --- |
| `from` | now | Where to start. Exclusive unless `inclusive` is set. |
| `count` | 10 | How many runs to return, from 1 to 1000. |
| `until` | 5 years from `from` | Stop here. The search never looks further than 5 years. |
| `inclusive` | `false` | Include a run that falls exactly on `from`. |
| `anchor` | `from` | When an interval schedule (`@every`, `rate(...)`) was created or started; its runs are `anchor + k * interval`. Ignored by calendar schedules. See Intervals below. |

Each run is `{ at, local, dst?, scheduled? }`: the instant, the wall time in the schedule's zone with its offset, and DST details when they apply.

`matches(schedule, at, opts?)` takes a third argument, `{ anchor? }`: the same `anchor` as `next`/`prev`, required for an interval schedule (there is no `from` to default it to; without one `matches` is always `false` there) and ignored by a calendar schedule.

## Intervals

Kubernetes CronJobs and AWS EventBridge also accept an interval form - "every N seconds", not a calendar expression - as their whole schedule text instead of five fields:

```ts
import { parse, next, matches } from '@peppercron/core';

parse('@every 1h30m', { dialect: 'kubernetes' });
// r.value.interval: { seconds: 5400, raw: '@every 1h30m', span: [0, 12] }, r.value.fields: []

parse('rate(5 minutes)', { dialect: 'aws' });
// r.value.interval: { seconds: 300, raw: 'rate(5 minutes)', span: [0, 15] }
```

An interval schedule's runs are pure arithmetic - `anchor + k * interval.seconds` - not a calendar walk, so `next`, `prev` and `matches` need an **anchor**: when the schedule was created. Pass one with the `anchor` option; when omitted it defaults to `from`, i.e. "if this were created right now, when would it next fire":

```ts
const k = parse('@every 5m', { dialect: 'kubernetes' });
if (k.ok) {
  next(k.value, { from: new Date('2026-09-21T10:00:00Z'), count: 2 });
  // no anchor given, so it defaults to `from`:
  // [ { at: 2026-09-21T10:05:00.000Z, local: '2026-09-21T10:05:00+00:00' },
  //   { at: 2026-09-21T10:10:00.000Z, local: '2026-09-21T10:10:00+00:00' } ]

  matches(k.value, new Date('2026-09-21T10:05:00Z'));                                    // false - no anchor
  matches(k.value, new Date('2026-09-21T10:05:00Z'), { anchor: new Date('2026-09-21T10:00:00Z') }); // true
}
```

`matches` has no `from` to default the anchor to, so without one it is always `false`. `prev` *does* default it to `from`, which makes it degenerate there: every run of the sequence is at or after the anchor, so `prev` on an interval schedule with no anchor returns `[]` - except an `at-anchor` dialect (AWS) with `inclusive: true`, which returns the anchor instant itself, since that one run is not strictly before `from`. Pass a real anchor to either when you mean it.

Kubernetes and AWS disagree on which run is first. Kubernetes's `@every` fires one interval *after* the anchor; AWS's `rate(...)` fires *at* the anchor itself:

```ts
const anchor = new Date('2026-09-21T10:00:00Z');
const k2 = parse('@every 5m', { dialect: 'kubernetes' });
const a2 = parse('rate(5 minutes)', { dialect: 'aws' });
if (k2.ok && a2.ok) {
  next(k2.value, { anchor, from: anchor, inclusive: true, count: 1 });
  // [ { at: 2026-09-21T10:05:00.000Z, local: '2026-09-21T10:05:00+00:00' } ]  -- one interval after the anchor

  next(a2.value, { anchor, from: anchor, inclusive: true, count: 1 });
  // [ { at: 2026-09-21T10:00:00.000Z, local: '2026-09-21T10:00:00+00:00' } ]  -- the anchor itself
}
```

Intervals ignore time zones and DST entirely - `rate(1 day)` is a fixed 24 hours of absolute time, not "the same wall clock time tomorrow":

```ts
const s = parse('rate(1 day)', { dialect: 'aws', timezone: 'America/New_York' });
if (s.ok) {
  const a = new Date('2026-03-07T17:00:00Z'); // 12:00 EST, the day before a spring-forward
  next(s.value, { anchor: a, from: a, count: 2 });
  // [ { at: 2026-03-08T17:00:00.000Z, local: '2026-03-08T13:00:00-04:00' },  -- 24h later, now 13:00 local (DST shifted the wall clock)
  //   { at: 2026-03-09T17:00:00.000Z, local: '2026-03-09T13:00:00-04:00' } ]
}
```

## DST

The same expression behaves differently on different schedulers, and the library models that.

**Clocks go forward (a gap).** cronie runs a fixed-time job that fell in the gap as soon as the gap ends; Quartz skips it.

```ts
const s = parse('0,30 2 * * *', { dialect: 'vixie', timezone: 'America/New_York' });
next(s.value, { from: new Date('2026-03-07T12:00:00Z'), count: 3 });
// 02:00 and 02:30 do not exist on 2026-03-08, so cronie runs both at 03:00:
// { at: 2026-03-08T07:00:00Z, local: '2026-03-08T03:00:00-04:00', dst: 'skipped-adjusted', scheduled: '2026-03-08T02:00:00' }
// { at: 2026-03-08T07:00:00Z, local: '2026-03-08T03:00:00-04:00', dst: 'skipped-adjusted', scheduled: '2026-03-08T02:30:00' }
// { at: 2026-03-09T06:00:00Z, local: '2026-03-09T02:00:00-04:00' }
```

**Clocks go back (an overlap).** A wall time happens twice. cronie runs a fixed-time job on the first pass only; Quartz fires on the second pass only. Runs in an overlap are tagged `ambiguous-first` or `ambiguous-second`.

**The other three dialects, in a sentence each.** Kubernetes silently skips a run that falls in a gap and, in an overlap, fires it twice, once on each pass. GitHub Actions advances a gap run to the next valid time (its own documented example: `2:30 -> 3:00`); its overlap behaviour is undocumented and this library's choice - a fixed-time job on the first pass only, like cronie - is an assumption, not a spec. AWS EventBridge skips a gap run and, in an overlap, fires it once, on the first pass only.

Catch-up runs can share one instant, so runs are non-decreasing rather than strictly increasing. If you page with `from: lastRun.at`, ask for a full page rather than `count: 1`, and de-duplicate on `at` plus `scheduled`.

The exact rules, and the source code and documentation they were derived from, are in the [corpus](../../corpus/README.md); its [Assumptions list](../../corpus/README.md#assumptions) names every behaviour that isn't actually documented anywhere, including GitHub's overlap and AWS's wildcard-schedule DST behaviour.

## Custom timezone data

The default build reads timezone data from `Intl`. To supply your own (for tests, or a runtime without `Intl` zones), implement the small `Tz` interface and call `createCore`:

```ts
import { createCore, type Tz } from '@peppercron/core';

const tz: Tz = {
  isValid: (zone) => zone === 'UTC',
  offsetAt: () => 0,
  transitions: () => [],
};
const { parse, next, prev, matches } = createCore(tz);
```

## Licence

MIT
