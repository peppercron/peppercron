# @peppercron/core

Parse cron schedules and compute when they run, correctly across timezones and DST.

- Zero runtime dependencies. Works in Node and in the browser.
- Never throws. `parse` returns a result; `next`, `prev` and `matches` return `[]` or `false` for input they cannot use.
- DST behaviour follows what each scheduler really does, derived from the cronie and Quartz source, not a guess.
- Every parsed field and term carries its character span in the source, for editors and error underlines.
- About 6 KB gzipped.

This is an early version. It supports two dialects: `vixie` (Linux crontab, matching cronie) and `quartz` (Java Quartz). More dialects, `describe`, `lint` and `convert` are planned.

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
}

parse('0 25 * * *');
// { ok: false, error: { code: 'out-of-range', message: '25 is outside 0-23 for hour', span: [2, 4] } }
```

`parse(input, opts?)` takes:

| Option | Default | Meaning |
| --- | --- | --- |
| `dialect` | detected | `'vixie'` or `'quartz'`. When omitted, the dialect is detected from the expression; if more than one fits, `candidates` lists them. |
| `timezone` | `'UTC'` | An IANA zone name such as `'America/New_York'`. |

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

Each run is `{ at, local, dst?, scheduled? }`: the instant, the wall time in the schedule's zone with its offset, and DST details when they apply.

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

Catch-up runs can share one instant, so runs are non-decreasing rather than strictly increasing. If you page with `from: lastRun.at`, ask for a full page rather than `count: 1`, and de-duplicate on `at` plus `scheduled`.

The exact rules, and the source code they were derived from, are in the [corpus](../../corpus/README.md).

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
