# The peppercron corpus

This directory is the source of truth for what a cron dialect *means*. It is plain JSON plus
`DERIVATION.md`, with no dependency on the TypeScript implementation: a port in another language
should be able to reproduce `@peppercron/core` exactly from this directory alone, and prove it by
running the cases.

If a behaviour is not pinned by a case here, it is not a behaviour of the library. A change to
behaviour lands as a case first.

## Layout

```
corpus/
  DERIVATION.md              how each dialect behaviour was read out of cronie / Quartz source (H1..H8)
  README.md                  this file
  strategies.json            the closed list of strategy ids, per axis
  dialects/index.json        dialect ids, in dialect-detection order
  dialects/<id>.json         one dialect's data; <id> must equal the filename and appear in index.json
  schemas/*.schema.json      JSON Schema (draft-07) for every file shape above and for the case files
  cases/parse/*.json         parse cases: expression in, Schedule or ParseError out
  cases/next/*.json          run-time cases: schedule plus a window in, Run list out
```

Case files are grouped by subject, not by dialect; the filenames carry no meaning beyond that. A
runner loads every `*.json` under `cases/parse` and `cases/next`.

## Conventions that apply everywhere

**Time.** Every instant in this corpus is UTC and whole seconds: `2026-03-08T07:00:00Z`. Wall times
carry the zone's offset (`2026-03-08T03:00:00-04:00`), except `scheduled`, which carries none. A zone
is always an IANA name.

**Spans.** A `span` is `[start, end)`, a half-open pair of **character offsets into `source`**, which
is the input string exactly as the caller passed it - never trimmed, normalised or case-folded.
"Character" here means **UTF-16 code unit**, because the reference implementation is JavaScript. This
is the corpus's sharpest portability trap: a port whose strings are bytes (Go) or code points
(Python) must convert offsets at its boundary, or every span after a non-ASCII character - most
easily reached through a trailing command, which is arbitrary user text - will disagree.

**Day-of-week numbering.** After parsing, day-of-week is canonical everywhere: **Sunday = 0 through
Saturday = 6**, in `Field.values` and in the `from`, `to` and `dow` of terms, whatever the dialect
numbers Sunday as. Vixie's `7` and Quartz's `1` both become `0`. `raw` and `span` still show what the
user typed. Expansion runs *before* normalisation, in the dialect's own numbering, which is why vixie
`5-7` records `from: 5, to: 0` and yet expands to `[0, 5, 6]` rather than to nothing.

**Field resolution.** A dialect that has a `second` field resolves to the second; otherwise to the
minute. This is the unit a runner steps by in the derived checks below.

## Dialect data (`dialects/<id>.json`)

| Key | Values | Meaning |
| --- | --- | --- |
| `id` | `^[a-z][a-z-]*$` | Must equal the filename stem and be listed in `dialects/index.json`. |
| `family` | a `family` strategy id | Which grammar parses the expression. Only `cron-fields` so far. |
| `fields` | array, 5 or more | The dialect's fields **in the order they are written**. |
| `macros` | `@name` to expansion | The expansion is a field string parsed as if typed (`"@daily": "0 0 * * *"`), or `null` for a macro that carries no schedule (`"@reboot": null`). Keys match `^@[a-z]+$` and are matched case-sensitively. |
| `trailingCommand` | boolean | True: tokens past the last field become `Schedule.trailing` instead of a `field-count` error (a crontab line). False: extra tokens are an error. |
| `rangeWrap` | `error` \| `empty` \| `wrap` | What `from > to` in a range means: a `bad-range` error; an empty set; or wrapping across the field's end. |
| `singleStep` | `error` \| `to-max` | What a step after a single value (`5/15`) means: a `bad-step` error (cronie), or "5 through the field maximum, every 15" (Quartz, FreeBSD). |
| `domDow` | a `domDow` strategy id | How the day-of-month and day-of-week fields combine. |
| `dstGap` | a `dstGap` strategy id | What happens to a run whose wall time a spring-forward skipped. |
| `dstOverlap` | a `dstOverlap` strategy id | What happens to a run whose wall time a fall-back repeated. |
| `missedRuns` | `none` \| `misfire-policy` | Recorded for later work; the engine does not read it. |
| `defaultTimezone` | `host` \| `utc` | What the *reference implementation* assumes when its user names no zone. It is a fact about the dialect, not about this library: `parse` here defaults to `UTC` and a `Schedule` always carries an explicit zone. |

Each entry of `fields`:

| Key | Values | Meaning |
| --- | --- | --- |
| `name` | `second` `minute` `hour` `dayOfMonth` `month` `dayOfWeek` `year` | Which field this is. |
| `min`, `max` | integers, inclusive | The accepted range, **in the dialect's own numbering**. A value outside it is `out-of-range`. |
| `names` | `month` \| `dow` | Three-letter names are accepted here: `JAN`..`DEC`, or `SUN`..`SAT`. Matching is case-insensitive. |
| `sundayIs` | `0` \| `1` | The number this dialect writes Sunday as, in `dayOfWeek`. Drives both name resolution and canonicalisation. Absent means 0. |
| `tokens` | subset of `?` `L` `L-n` `W` `LW` `nL` `#` | The special tokens this field *supports*. **An absent key means the empty set** - the field supports none of them - so it is not a shorthand for "all". No vixie field carries the key, which is why `L` in a vixie day-of-month is flagged. A token that the grammar can parse but this list omits is **not** an error: it parses, the term gets `unsupported: true`, and the engine still evaluates it. That keeps the simulator useful on questionable input and gives a later lint pass its rule without re-parsing. |
| `optional` | boolean | This trailing field may be omitted (Quartz `year`). Fields before it are required. |

Vixie's `dayOfWeek` runs `0-7` with `sundayIs: 0`, so Sunday is both `0` and `7`. Quartz's runs `1-7`
with `sundayIs: 1`.

## Strategies (`strategies.json`)

`strategies.json` is the closed list of ids per axis. Every id a dialect names must appear in it, and
an implementation must implement exactly the listed ids - no more, no fewer. **Growth rule:** a new id
needs an evidence case that reaches it; `derived` provenance with a citation is accepted until a
capture harness exists. The rule cuts both ways, so an id no dialect references and no case can reach
is removed rather than left for every port to implement blind.

### `family`

- **`cron-fields`** - whitespace-separated fields. An expression whose first token starts with `@` is
  a macro: unknown macro names are `unknown-macro`. Otherwise the first *n* tokens are the fields, in
  the dialect's order; fewer than the required count is `field-count`. Extra tokens are `trailing`
  when `trailingCommand`, `field-count` otherwise.

### `domDow` - combining day-of-month with day-of-week

Each side reports `hit` (does this day match?) and `star` (does the field's first term begin with
`*`?). A `?` term makes its side `hit: true, star: true`.

- **`or`** (cronie) - if *either* field begins with `*`, the pair is AND; otherwise it is OR. So
  `0 0 13 * 5` fires on the 13th *and* on every Friday, while `0 0 */2 * 1` fires only on Mondays
  that fall on an odd day. DERIVATION H5.
- **`exclusive-question`** (Quartz) - plain AND. Quartz requires one side to be `?`, which always
  hits, so in practice the other field decides.

### `dstGap` - a matching wall time a spring-forward skipped

A **gap** is the set of wall times after the earlier segment's last wall second and before the later
segment's first: for a 1-hour spring forward at 02:00, the wall times `[02:00:00, 03:00:00)`.

- **`skip`** (Quartz) - no run. A wall time in the gap never produces one, and nothing is shifted into
  the hour after it. A schedule matching both the gap hour and the hour after still fires once that
  day. DERIVATION H4.
- **`vixie-window`** (cronie) - catch-up, under two conditions:
  1. the schedule is **fixed-time**: neither the minute nor the hour field begins with `*` (H1 - a
     purely syntactic test, so `*/5` counts as a wildcard and `0-59` does not); and
  2. the gap is **shorter than 3 hours**. cronie walks the skipped minutes one at a time only in its
     `case medium`, bounded by `3 * MINUTE_COUNT` = 180 minutes; a wider jump resyncs and runs only
     the current minute (H2). So a zone that skips a whole wall day, as Pacific/Apia did on
     2011-12-30, produces **no** catch-up runs at all - not a day's worth at one instant.

  When both hold, **one run per matching wall time inside the gap**, all emitted at the transition
  instant, each tagged `skipped-adjusted` and carrying the skipped wall time in `scheduled`. So vixie
  `0,30 2 * * *` across a 1-hour spring forward produces **two** runs at the same instant. Wildcard
  schedules get no catch-up; they simply continue in the new offset.

**The natural run.** Catch-up runs are *extra*. If the schedule also matches the wall time the
transition instant lands on, that run is emitted too - **after** the catch-up runs, at the same
instant, untagged and with no `scheduled`. Vixie `0 2,3 * * *` across a spring forward at 02:00
therefore yields the 02:00 catch-up and then the natural 03:00 run, both at the transition instant.
`prev` returns that pair in the mirror order: natural run first, then the catch-up. The order is
binding, and deep-comparing a `Run` list will catch a port that gets it backwards.

### `dstOverlap` - a matching wall time a fall-back repeated

An **overlap** is the set of wall times present in both segments. Each matching wall time in it is
classified **first pass** (still on the pre-transition offset) or **second pass** (on the new one).

- **`once-second`** (Quartz) - emit on the second pass only, tagged `ambiguous-second`. Java's lenient
  `Calendar` resolves an ambiguous wall time to standard time, so Quartz never produces a first-pass
  fire time. DERIVATION H6.
- **`vixie-window`** (cronie) - a fixed-time schedule (same test as above) emits on the **first** pass
  only, tagged `ambiguous-first`; a wildcard schedule follows real time and emits on **both**, tagged
  `ambiguous-first` and `ambiguous-second`. DERIVATION H1, H6.

## `matches`

`matches(schedule, instant)` is **true exactly when `next` would emit that instant** - nothing more.
It is not a wall-clock field test. Three consequences a port must reproduce:

- A second-pass instant under `vixie-window` with a fixed-time schedule does **not** match, though its
  wall time matches every field.
- A `skipped-adjusted` transition instant **does** match, though the wall time the run was scheduled
  for never occurred.
- An instant that is not a whole second never matches.

This is why `next` cases carry `notMatching`: it pins the instants where a naive field test would
disagree.

## Run-time semantics `next` and `prev` cases assume

- **`from`** is exclusive: a run exactly at `from` is not returned. (`inclusive: true` makes it
  inclusive; no case sets it.) `prev` looks strictly before `from` in the same way.
- **`until`** is **inclusive** on both `next` and `prev`: a run exactly at `until` is returned. An
  `until` on the wrong side of `from` gives no runs.
- **`count`** defaults to 10 and is clamped to **1..1000**, flooring a fraction and falling back to 10
  for a non-finite value. Case files are schema-bound to 1..1000, so the clamp never bites in a case.
- **Horizon:** the search covers at most **5 * 366 days = 158,112,000 seconds** from `from`, in either
  direction. A schedule with no run in that span returns an empty list rather than searching forever.
  A case whose `expect` is shorter than its `count` is asserting that the runs stopped before `count`
  was reached - because the schedule ran out within the horizon, **or** because an `until` closed the
  window first. The two are not distinguishable from the case file alone; read its `until`.
- **Order:** results are **non-decreasing**, not strictly increasing. Equal instants occur only in a
  group that begins with `skipped-adjusted` runs. Paging with `from: lastRun.at` and `count: 1` will
  silently drop the rest of such a group; ask for a full page and de-duplicate on `at` plus
  `scheduled`.
- Runs are never returned outside the range a platform timestamp can hold.

## Parse cases (`cases/parse/*.json`)

```jsonc
{
  "id": "vixie-weekly-explicit",          // unique across the corpus; failures are reported by it
  "input": "0 2 * * 1",                   // exactly what a user types
  "options": { "dialect": "vixie",        // omit `dialect` to exercise detection
               "timezone": "Europe/London" },   // omitted means UTC
  "expect": { /* the whole Schedule */ }, // exactly one of `expect` or `expectError`
  "provenance": { "kind": "spec" }
}
```

That block shows every key a parse case may carry, so it is not a copy of the file: the real
`vixie-weekly-explicit` in `cases/parse/basic.json` sets no `timezone` and so runs in UTC.

`expect` is compared **in full** against the returned `Schedule`: `dialect`, `source` (the untouched
input), `timezone`, every `Field` with its `raw`, `span`, `terms`, `values` and `star`, and the
optional `macro`, `trailing` and `candidates`. Absent optional keys must be absent, not null.

- `Field.values` holds the expansion of `any` and `range` terms only, canonicalised, sorted and
  de-duplicated. The dynamic kinds (`last`, `lastWeekday`, `nearestWeekday`, `lastDow`, `nthDow`) and
  `unspecified` contribute nothing; the engine evaluates them per month.
- `Field.star` is true when the field's first term is `*` or `*/n`. Two strategies read it.
- A macro's fields all report the **macro token's** span, since they were never typed.
- `trailing.text` is sliced from `source` between the first and last trailing token, so it keeps the
  whitespace between them.

`expectError` is `{ "code", "span" }`. The codes are a closed list: `empty`, `field-count`,
`bad-token`, `out-of-range`, `bad-step`, `bad-range`, `unknown-macro`, `unknown-dialect`,
`bad-timezone`. Parsing never throws and never returns a partial schedule.

**Detection** (`options.dialect` omitted) walks `dialects/index.json` in order. A dialect is a
candidate when it parses the input with no `unsupported` term. Candidates that needed `trailing` are
dropped as long as one without it remains, so `0 0 12 * * ?` is Quartz rather than Vixie with a stray
`?` as a command. The first survivor wins, and `candidates` is set only when more than one survived.
If nothing qualifies: the first dialect that parsed at all, else the first error that is not
`field-count`, else the first error. No detection heuristic lives anywhere but this rule.

**Tokenizing.** Fields are runs of non-whitespace, found with the JavaScript regex `/\S+/g`. A port
must match **that** whitespace set, not its own: `\s` in JavaScript is U+0009-U+000D, U+0020, U+00A0,
U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 **and U+FEFF**. Go's `strings.Fields`
adds U+0085 and omits U+FEFF; Python's `str.split()` differs again. A byte-order mark or a
non-breaking space between fields therefore separates them here, and an implementation that disagrees
will split a valid expression differently.

## Run-time cases (`cases/next/*.json`)

```jsonc
{
  "id": "vixie-gap-fixed-time-catches-up",
  "dialect": "vixie",                     // always explicit; detection is a parse-case concern
  "input": "30 2 * * *",
  "timezone": "America/New_York",
  "from": "2026-03-07T12:00:00Z",
  "until": "2026-03-09T00:00:00Z",        // optional, inclusive
  "count": 3,
  "expect": [
    { "at": "2026-03-08T07:00:00Z", "local": "2026-03-08T03:00:00-04:00",
      "dst": "skipped-adjusted", "scheduled": "2026-03-08T02:30:00" }
  ],
  "notMatching": ["2026-03-08T07:30:00Z"],   // optional
  "skipDerived": false,                      // optional
  "provenance": { "kind": "derived", "source": "corpus/DERIVATION.md H1, H2" }
}
```

That block likewise shows every optional key at once rather than copying the file: the real
`vixie-gap-fixed-time-catches-up` in `cases/next/dst.json` sets no `until`, `notMatching` or
`skipDerived`, and its `expect` holds three runs, of which only the first is shown here.

Each entry of `expect` is a `Run`:

- **`at`** - the instant, UTC, whole seconds.
- **`local`** - the wall time in `timezone`, with its UTC offset. The offset gains a seconds component
  only where the zone has one (historical LMT offsets).
- **`dst`** - `skipped-adjusted`, `ambiguous-first` or `ambiguous-second`; **absent** when the run's
  wall time is unambiguous and really occurred. Absent is not the same as any value.
- **`scheduled`** - present **only** on a `skipped-adjusted` run: the wall time the run is catching
  up, which the gap skipped. It carries no offset because that wall time does not exist in the zone.
  When several catch-up runs share one instant, this is the only field that tells them apart.

`expect` may be shorter than `count` (the schedule ran out, or `until`/the horizon cut it off); it is
never longer, and it is compared in order.

`notMatching` lists instants a runner must assert `matches` is **false** for - the cases where a plain
wall-clock field test would say true.

`skipDerived` suppresses the derived checks below. It exists for a case whose `expect` is deliberately
a partial view of its window; no case currently needs it.

### The derived checks a runner must perform

A `next` case is not only a `next` assertion. For each case, after asserting that
`next(schedule, {from, count, until})` deep-equals `expect`, and that every `notMatching` instant does
not match, a runner must also - unless `skipDerived` is set or `expect` is empty - check:

1. **`matches` agrees with every expected run.** For each `e` in `expect`, `matches(schedule, e.at)`
   is true.
2. **`matches` is false one unit earlier**, where the unit is the dialect's resolution (1 s if it has
   a `second` field, else 60 s). Skip this for an `e.at` that is not more than one unit after the
   previous expected run - that guards the equal-instant groups, and the first comparison is against
   `from`.
3. **`prev` returns the same runs, reversed.** `prev(schedule, {from: last.at + 1 second, count:
   expect.length})` deep-equals `expect` reversed, `dst` and `scheduled` included. This is what pins
   the order inside an equal-instant group without a separate case.

Deriving three assertions from one case is deliberate: it means a port cannot satisfy the corpus by
special-casing `next`.

## Provenance

Every case carries `provenance.kind`:

- **`spec`** - the dialect's specification or its documented behaviour.
- **`derived`** - read out of reference implementation source. `source` is required and cites
  `DERIVATION.md` by section (`corpus/DERIVATION.md H2`), which in turn quotes the file, function and
  line it was read from.
- **`captured`** - recorded from a running reference implementation. `platform` and `recording` are
  required. No case uses this yet; there is no capture harness.

## Known deviations from the reference implementations

Places where this corpus knowingly does not reproduce the reference. A port should match the corpus,
not the reference, and should carry this list forward.

1. **cronie's `N-0` rewrite outside day-of-week.** cronie's `get_range` rewrites a reversed range
   ending at `0` to end at `7`, and it is generic, so `5-0` in the *minute* field sets minutes 5, 6
   and 7 (DERIVATION H3, `entry.c:641-643`). Here the rewrite applies **only** in `dayOfWeek`, where
   it is what makes `SAT-SUN` and `5-0` work; in every other field `rangeWrap: "empty"` applies and a
   reversed range expands to nothing.
2. **cronie's best-effort catch-up abort.** cronie's catch-up loop runs only
   `while (virtualTime < timeRunning && clockTime == timeRunning)` and each job it starts costs a
   `sleep(10)`, so a catch-up that spills past one real minute silently drops the skipped minutes it
   has not reached. That is a property of a running daemon under load, not of a schedule, so it is not
   modelled: every matching skipped minute within the 3-hour bound is emitted.
3. **Quartz's year-field wrap rejection.** Quartz wraps a reversed range in every field except `year`,
   where it throws `Start year must be less than stop year` (H3). Here `rangeWrap` is per dialect, not
   per field, so `2030-2028` in Quartz's year field wraps across 1970-2099 instead of erroring. Parked.
4. **Quartz `isSatisfiedBy` versus `matches` in an overlap.** Quartz's own `isSatisfiedBy` is a plain
   wall-clock field test, so it returns true for *both* passes of a repeated hour, while its
   `getTimeAfter` only ever yields the second - Quartz is internally inconsistent here (H6). `matches`
   in this corpus is defined as "`next` would emit this instant", so it is false on the first pass.
   Deliberate, and the reason `quartz-overlap-*` cases carry `notMatching`.
5. **One probe per day in the transition finder.** Neither Go, Python nor JavaScript exposes a zone's
   transition list, so every port finds transitions the same way: read the offset once per day and
   bisect to the second wherever it changed. Two offset changes less than a probe day apart would
   therefore be seen as one. No case depends on such a zone, and the deviation is at least identical
   across ports because the algorithm is part of the contract. Parked.
