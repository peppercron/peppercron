# The peppercron corpus

This directory is the source of truth for what a cron dialect *means*. It is plain JSON plus
`DERIVATION.md`, with no dependency on the TypeScript implementation: a port in another language
should be able to reproduce `peppercron` exactly from this directory alone, and prove it by
running the cases.

If a behaviour is not pinned by a case here, it is not a behaviour of the library. A change to
behaviour lands as a case first.

## Layout

```
corpus/
  DERIVATION.md              how each dialect behaviour was read out of cronie / Quartz source (H1..H8),
                              robfig/cron v3 as pinned by Kubernetes (K1..K16), GitHub Actions'
                              documentation (G1..G11) and AWS EventBridge's documentation (A1..A17)
  README.md                  this file
  strategies.json            the closed list of strategy ids, per axis
  dialects/index.json        dialect ids, in dialect-detection order
  dialects/<id>.json         one dialect's data; <id> must equal the filename and appear in index.json
                              (vixie, kubernetes, github-actions, quartz, aws)
  schemas/*.schema.json      JSON Schema (draft-07) for every file shape above and for the case files
  cases/parse/*.json         parse cases: expression in, Schedule or ParseError out
                              (basic, errors, detection, kubernetes, github-actions, aws, intervals)
  cases/next/*.json          run-time cases: schedule plus a window in, Run list out
                              (basic, dst, kubernetes, github-actions, aws, intervals)
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
| `wrapper` | a lowercase word, or `null` | A keyword the expression may be written inside, as in `cron(...)` (AWS) - the bare fields still parse too. `null` means this dialect has no wrapper. Matched **case-sensitively**: `CRON(...)` does not count as wrapped. See Forms below. |
| `rangeWrap` | `error` \| `empty` \| `wrap` | What `from > to` in a range means: a `bad-range` error; an empty set; or wrapping across the field's end. |
| `singleStep` | `error` \| `to-max` | What a step after a single value (`5/15`) means: a `bad-step` error (cronie), or "5 through the field maximum, every 15" (Quartz, FreeBSD). |
| `star` | a `star` strategy id | When a field counts as a star, for the `domDow` rule and for the engine's fixed-time test. |
| `interval` | an `interval` strategy id | How this dialect spells "every N seconds from an anchor" (`@every`, `rate(...)`), or `none` for a dialect with no such form. See Forms below. |
| `intervalFirst` | `after-anchor` \| `at-anchor` | Which run is the first: `after-anchor` = the anchor plus one interval (Kubernetes); `at-anchor` = the anchor instant itself (AWS). Required unless `interval` is `none`. |
| `domDow` | a `domDow` strategy id | How the day-of-month and day-of-week fields combine. |
| `dstGap` | a `dstGap` strategy id | What happens to a run whose wall time a spring-forward skipped. |
| `dstOverlap` | a `dstOverlap` strategy id | What happens to a run whose wall time a fall-back repeated. |
| `missedRuns` | `none` \| `misfire-policy` \| `starting-deadline` \| `best-effort` \| `flexible-window` | What the reference implementation does about a run missed while it was not running/watching: nothing special (vixie); Quartz's configurable misfire policy; Kubernetes CronJob's `startingDeadlineSeconds`, past which a missed run is skipped rather than started late; GitHub Actions' best-effort delivery, which can silently drop a run under high load (DERIVATION G7); EventBridge Scheduler's flexible time window, which may delay a run within a configured window. Recorded for later work; the engine does not read it. |
| `defaultTimezone` | `host` \| `utc` | What the *reference implementation* assumes when its user names no zone. It is a fact about the dialect, not about this library: `parse` here defaults to `UTC` and a `Schedule` always carries an explicit zone. |

Each entry of `fields`:

| Key | Values | Meaning |
| --- | --- | --- |
| `name` | `second` `minute` `hour` `dayOfMonth` `month` `dayOfWeek` `year` | Which field this is. |
| `min`, `max` | integers, inclusive | The accepted range, **in the dialect's own numbering**. A value outside it is `out-of-range`. |
| `names` | `month` \| `dow` | Three-letter names are accepted here: `JAN`..`DEC`, or `SUN`..`SAT`. Matching is case-insensitive. |
| `sundayIs` | `0` \| `1` | The number this dialect writes Sunday as, in `dayOfWeek`. Drives both name resolution and canonicalisation. Absent means 0. |
| `tokens` | subset of `?` `?*` `L` `L-n` `W` `LW` `nL` `#` | The special tokens this field *supports*. **An absent key means the empty set** - the field supports none of them - so it is not a shorthand for "all". No vixie field carries the key, which is why `L` in a vixie day-of-month is flagged. A token that the grammar can parse but this list omits is **not** an error: it parses, the term gets `unsupported: true`, and the engine still evaluates it. That keeps the simulator useful on questionable input and gives a later lint pass its rule without re-parsing. `?*` (Kubernetes, every field) means this field accepts `?` as an exact synonym for `*`: it parses to a term of kind `any`, not `unspecified`, so it counts as a star under the dialect's `star` strategy exactly as a literal `*` does, and it can never be `unsupported` (there is no separate `?` token check once `?*` applies). |
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

### `star`

Whether a field counts as a "star", read by two consumers: the `domDow` `or` rule below, and the
engine's fixed-time test (a schedule is fixed-time when neither its minute nor its hour field is a
star). `Field.star` is set once per field at parse time, by the *dialect's own* strategy - dialects
disagree on what counts, so the same expression can be a star under one and not under another.

- **`leading`** (vixie, GitHub Actions, Quartz, AWS) - the field's first term is `*` or `*/n` (kind
  `any`), tested purely by position: only the first comma-separated term is looked at. `*/2` **is** a
  star (its one term is `any`); `5,*` **is not** (the first term is a plain range - the trailing `*` is
  never reached). DERIVATION H1.
- **`unstepped-term`** (Kubernetes/robfig) - **any** term in the field, not only the first, that is `*`
  or `?*` with no step above 1 (kind `any`, `step: 1`); a step above 1 clears that term's contribution.
  So `*/2` is **not** a star (its one term has `step: 2`) and `5,*` **is** (its second term is an
  unstepped `any`) - the opposite of `leading` on both examples. `?*` parses to kind `any`, `step: 1`,
  so it counts exactly as a literal `*` would. DERIVATION K10.

### `domDow` - combining day-of-month with day-of-week

Each side reports `hit` (does this day match?) and `star` (the field's `Field.star`, from the
dialect's own `star` strategy above - **not** a fixed leading-`*` test). An `unspecified` (`?`) term
makes its side `hit: true, star: true` unconditionally (`matcher.ts`'s `domSide`/`dowSide` shortcut on
`kind === 'unspecified'`) - this is separate from the `star` strategies above and from the `?*` token
(Kubernetes), where `?` instead parses to an `any` term and is a star only because `any` with no step
is a star under `unstepped-term`, not because of this rule.

- **`or`** (cronie, GitHub Actions, Kubernetes) - if *either* field is a star, the pair is AND;
  otherwise it is OR. So vixie's `0 0 13 * 5` fires on the 13th *and* on every Friday, while
  `0 0 */2 * 1` fires only on Mondays that fall on an odd day - because `star` there is the `leading`
  strategy, which GitHub Actions also uses, so it agrees with vixie on both examples. Kubernetes shares
  the `or` rule but reads `star` through `unstepped-term` instead, so the same two examples can disagree
  with vixie's and GitHub's verdict on which field is a star (see the `star` examples above). DERIVATION
  H5, K10.
- **`exclusive-question`** (Quartz, AWS) - plain AND. Both dialects' *documentation* requires one side
  to be `?` (Quartz's own grammar; AWS's "can't specify both" rule, A3), which always hits, so in
  practice the other field decides - though neither dialect's `parse` actually enforces that
  requirement (see Known deviations below).

### `dstGap` - a matching wall time a spring-forward skipped

A **gap** is the set of wall times after the earlier segment's last wall second and before the later
segment's first: for a 1-hour spring forward at 02:00, the wall times `[02:00:00, 03:00:00)`.

- **`skip`** (Quartz, Kubernetes, AWS) - no run. A wall time in the gap never produces one, and nothing
  is shifted into the hour after it. A schedule matching both the gap hour and the hour after still
  fires once that day. For Kubernetes this also means **no catch-up run and no error** - the CronJob
  just quietly loses that day's run, the flat opposite of cronie's `vixie-window`. DERIVATION H4, K11,
  A14.
- **`vixie-window`** (cronie) - catch-up, under two conditions:
  1. the schedule is **fixed-time**: neither the minute nor the hour field is a star, under the
     `leading` star strategy vixie uses (H1 - a purely syntactic test, so `*/5` counts as a wildcard and
     `0-59` does not); and
  2. the gap is **shorter than 3 hours**. cronie walks the skipped minutes one at a time only in its
     `case medium`, bounded by `3 * MINUTE_COUNT` = 180 minutes; a wider jump resyncs and runs only
     the current minute (H2). So a zone that skips a whole wall day, as Pacific/Apia did on
     2011-12-30, produces **no** catch-up runs at all - not a day's worth at one instant.

  When both hold, **one run per matching wall time inside the gap**, all emitted at the transition
  instant, each tagged `skipped-adjusted` and carrying the skipped wall time in `scheduled`. So vixie
  `0,30 2 * * *` across a 1-hour spring forward produces **two** runs at the same instant. Wildcard
  schedules get no catch-up; they simply continue in the new offset.
- **`next-valid`** (GitHub Actions) - advance, for a **fixed-time** schedule only (same test as
  `vixie-window`); a wildcard schedule gets no adjustment and simply continues in the new offset,
  exactly as under `vixie-window`. At most **one** run per gap, regardless of how many wall times it
  skips: the run fires at the transition instant, tagged `skipped-adjusted`, with `scheduled` set to
  the **earliest** matching wall time in the gap - unlike `vixie-window`, later matches in the same gap
  are not each given their own run. **No** run at all when a natural run already fires at the
  transition instant - the advanced run is never a second run at an instant the schedule already
  matches (`0 2,3 * * *` across a 02:00 gap yields one **untagged** 03:00 run, not an advanced one as
  well; case `github-gap-natural-run-is-not-doubled`). GitHub's own documented example, `2:30 -> 3:00`,
  is the *other* side of the rule: `30 2 * * *` does not match 03:00, so the advanced run **is**
  emitted there, tagged `skipped-adjusted` with `scheduled: 2026-03-08T02:30:00` (case
  `github-gap-fixed-time-advances-to-the-next-valid-time`). No width limit on the gap. DERIVATION G5.

**The natural run** (`vixie-window`). Catch-up runs are *extra*. If the schedule also matches the wall
time the transition instant lands on, that run is emitted too - **after** the catch-up runs, at the
same instant, untagged and with no `scheduled`. Vixie `0 2,3 * * *` across a spring forward at 02:00
therefore yields the 02:00 catch-up and then the natural 03:00 run, both at the transition instant.
`prev` returns that pair in the mirror order: natural run first, then the catch-up. The order is
binding, and deep-comparing a `Run` list will catch a port that gets it backwards. `next-valid` folds
the same natural-run check into its own single-run rule above rather than emitting both separately.

### `dstOverlap` - a matching wall time a fall-back repeated

An **overlap** is the set of wall times present in both segments. Each matching wall time in it is
classified **first pass** (still on the pre-transition offset) or **second pass** (on the new one).

- **`once-second`** (Quartz) - emit on the second pass only, tagged `ambiguous-second`. Java's lenient
  `Calendar` resolves an ambiguous wall time to standard time, so Quartz never produces a first-pass
  fire time. DERIVATION H6.
- **`vixie-window`** (cronie, GitHub Actions) - a fixed-time schedule (same test as above) emits on the
  **first** pass only, tagged `ambiguous-first`; a wildcard schedule follows real time and emits on
  **both**, tagged `ambiguous-first` and `ambiguous-second`. DERIVATION H1, H6, G5.
- **`repeat`** (Kubernetes/robfig) - emit on **both** passes, tagged `ambiguous-first` and
  `ambiguous-second`, for a fixed-time and a wildcard schedule alike; robfig's matcher only ever reads
  the wall clock (hour, minute), so it cannot tell the second occurrence from the first and simply
  matches it again. Kubernetes creates two distinct Jobs for the pair. DERIVATION K13.
- **`once-first`** (AWS EventBridge Scheduler) - emit on the **first** pass only, tagged
  `ambiguous-first`, for every schedule - fixed-time or wildcard, since the documentation makes no
  such distinction (see the Assumptions list under Provenance below). DERIVATION A15, A16.

### `interval` - "every N seconds from an anchor"

How a dialect spells an interval schedule. A dialect whose `interval` is not `none` accepts a second
input form entirely separate from its `family` grammar: the whole expression is the interval, there are
no `fields`, and `Schedule.interval = { seconds, raw, span }` is set instead (see Forms below).
`seconds` is always a positive integer of whole seconds; the run-time semantics that turn it into actual
runs are in "Run-time semantics" further down. `none` marks a dialect with no interval form at all.

- **`go-duration`** (`@every <duration>`, Kubernetes/robfig) - `@every`, one or more whitespace
  characters, then **one whitespace-free token**, read as Go's `time.ParseDuration`:
  `[-+]?(\d*(\.\d*)?(ns|us|µs|μs|ms|s|m|h))+`, or a bare `0`. Read literally that regex also accepts a
  unit with no digit on either side of the point (`h`, `.s`); it does not - as in Go, every piece needs
  at least one digit, before or after the point, so `@every h` and `@every .s` are both `bad-interval`.
  The optional sign applies to the **whole**
  duration and may appear only at the front - `-1h30m` is legal, `1h-30m` is not (the second `-` is
  swallowed into what should be the `h` unit and fails to match any unit name). A second token
  (`@every 1h 30m`) is also `bad-interval`, not "two durations added together". There is no day or week
  unit. Each unit term contributes `intPart * unitNs` plus, for a fractional part, `floor(float64(fraction)
  * (unitNs / 10^digits))` - Go computes the fractional nanoseconds as a `float64` multiplication,
  truncated, not as exact decimal arithmetic, and this per-term computation matches Go's own (not
  simplified to an equivalent-looking integer computation) because the two can disagree by a nanosecond
  near a rounding boundary. Terms accumulate in order, as an ordinary JavaScript number rather than a
  64-bit integer (see Known deviations for where that can disagree with Go); the running total must stay
  **below 2^63 nanoseconds** (Go's `int64` duration range) after every term or the whole thing is
  `bad-interval`. Once total nanoseconds are known: a duration under 1 second is clamped **up** to 1
  second, then the result is truncated
  **down** to whole seconds (`@every 1500ms` -> 1s, not 2s; `@every -1h` -> 1s, since a negative delay is
  also clamped up). **Spans:** `@every` with no duration, or with more than one token, is `bad-interval`
  spanning the **whole trimmed input**; a single token `time.ParseDuration` cannot read is `bad-interval`
  spanning **just that token**. DERIVATION K7.
- **`aws-rate`** (`rate(value unit)`, AWS EventBridge) - `rate(`, optional whitespace, `value`, **one
  or more whitespace characters**, `unit`, optional whitespace, `)`. Whitespace inside the parens is
  tolerant on both sides: `rate( 5  minutes )` is accepted, and `raw` keeps that spacing exactly as
  typed (it is not renormalised to `rate(5 minutes)`). `value` is a run of 1-15 digits read as an
  integer, `unit` one of `minute`/`minutes`, `hour`/`hours`, `day`/`days`, **singular exactly when
  `value` is `1`** and plural otherwise (`rate(1 hours)` and `rate(5 hour)` are both `bad-interval`).
  `seconds = value * unitSeconds`; a result that is not a JavaScript safe integer (overflow), that is
  `0`, or a missing or malformed value/unit, is `bad-interval` **spanning the interior** -
  `[start + 5, end - 1)`, the text strictly between `rate(` and the final `)` - not the whole
  expression. A missing final `)` is `bad-wrapper` spanning the **whole trimmed input** instead.
  DERIVATION A9.

## `matches`

`matches(schedule, instant, opts?)` is **true exactly when `next` would emit that instant** - nothing
more. `opts.anchor` is required for an interval schedule (see the interval bullet under Run-time
semantics below); a calendar schedule ignores it. It is not a wall-clock field test. Three consequences
a port must reproduce:

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
- **Interval schedules** (`Schedule.interval` set) are pure arithmetic on an **anchor**, never a
  calendar walk: the *k*-th run is `anchor + k * interval.seconds`, for `k >= 1` when the dialect's
  `intervalFirst` is `after-anchor` (Kubernetes: the first run is one interval *after* the schedule was
  created) or `k >= 0` when it is `at-anchor` (AWS: the first run is the anchor instant itself). The
  anchor comes from `RunOptions.anchor`, **floored to a whole second**; when omitted it defaults to
  `from` - "if this schedule were created right now, when would it next fire." An interval run **never**
  carries a `dst` tag: intervals ignore time zones and DST entirely, and `local` is just that instant
  reformatted into the schedule's zone with whatever offset applies there at that moment. `from`,
  `until`, `inclusive`, the `count` clamp (1..1000, default 10) and the 5-year horizon all apply to an
  interval schedule exactly as to a calendar one.
- **`matches` on an interval schedule requires an explicit `anchor`** in its options; with none it is
  unconditionally `false` - there is no default run sequence to test the instant against, because
  `matches` takes no `from` to fall back on the way `next`/`prev` do.

## Forms

A dialect's parse tries these in order; the first one that applies wins, and later ones are never
attempted.

1. **Interval form claimed?** If `interval` is not `none`, and the input (left-trimmed of whitespace)
   matches that interval strategy's own claim test (`go-duration`: starts with `@every` followed by
   whitespace or end-of-string; `aws-rate`: starts with `rate(`), the whole input is read as an
   interval. `family` and `wrapper` are never tried: a malformed interval is always `bad-interval` (or
   `bad-wrapper` for `aws-rate` missing its closing `)`), never a field error - see the exact spans each
   failure reports under `go-duration`/`aws-rate` in Strategies above. On success `Schedule` has empty
   `fields` and a `Schedule.interval`.
2. **Wrapper.** Otherwise, if `wrapper` is not `null` and the trimmed input starts with `wrapper + "("`,
   the input must close with exactly one final `)` and contain no other `(` or `)` inside; anything
   else is `bad-wrapper`, spanning the whole trimmed input. On success the wrapper keyword and its two
   parentheses are **blanked to spaces**, not cut out of the string - the text handed to the tokenizer
   is the same length as `source`, so every span the tokenizer reports still indexes the untouched
   `source`, and the wrapped fields effectively sit at the same offsets they would if typed bare. An
   interior that is empty or all whitespace (`cron()`) tokenizes to zero tokens, which is a
   `field-count` error spanning the whole trimmed input, not a `bad-wrapper`.
3. **Fields.** The (possibly unwrapped) text is tokenized and handed to the dialect's `family` parser,
   as described above.

Both `wrapper` and every interval strategy's keyword (`@every`, `rate`) are matched
**case-sensitively**: `CRON(...)`, `RATE(5 minutes)` and `@EVERY 1h` do not claim their forms at all,
and fall straight through to field parsing (where they typically fail some other way - `CRON(...)` as
an out-of-range or bad-token first field, for instance).

Trimming, and every other mention of whitespace above (left-trimming before the interval claim test,
the trimmed input the wrapper and the `family` parser both see), use the same whitespace set as
Tokenizing: JavaScript's `\s`, which includes U+FEFF. Go's `strings.TrimSpace` does not strip U+FEFF,
so a port must use the listed set, not its own language's idea of whitespace, or it will disagree on
an input that starts with a U+FEFF byte-order mark before `cron(0 12 * * ? *)`.

**Claimed-form detection.** A dialect *claims* an input when step 1 or step 2 above would apply to it
for that dialect: its own interval strategy claims the text, or the text is wrapped in its own
`wrapper` keyword. When `options.dialect` is omitted, if **any** dialect in `dialects/index.json` claims
the input, detection tries **only** the claiming dialects - a form that belongs to some dialects (an
interval keyword, a wrapper) is treated as theirs alone, so its errors are theirs too, and a dialect
that does not claim the form is never even attempted against it, whether or not that dialect's plain
field grammar could otherwise tokenize the same text.

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
optional `macro`, `trailing`, `candidates` and `interval`. Absent optional keys must be absent, not
null.

- `Field.values` holds the expansion of `any` and `range` terms only, canonicalised, sorted and
  de-duplicated. The dynamic kinds (`last`, `lastWeekday`, `nearestWeekday`, `lastDow`, `nthDow`) and
  `unspecified` contribute nothing; the engine evaluates them per month.
- `Field.star` is the dialect's own `star` strategy applied to the field's terms (`leading` or
  `unstepped-term` above) - **not** a fixed "first term is `*`" test; which strategy a dialect uses
  changes `Field.star` for the same input (see `star` under Strategies).
- A macro's fields all report the **macro token's** span, since they were never typed.
- `trailing.text` is sliced from `source` between the first and last trailing token, so it keeps the
  whitespace between them.
- `Schedule.interval`, present only for a dialect's interval form (see `interval` under Strategies and
  Forms above), is compared as `{ seconds, raw, span }`: `seconds` the resolved whole-second length,
  `raw` the interval expression exactly as typed (whitespace-trimmed, its own wrapper - `@every ...` or
  `rate(...)` - included), `span` its offsets into the untouched `source`. `Schedule.fields` is `[]` for
  an interval schedule, the same as for a no-schedule macro (`@reboot`).

`expectSummary` is a **partial** expectation, for a case where the whole `Schedule` would be noise.
`dialect` is always compared. `candidates`, `unsupported` and `interval` are compared **exactly**, in
**both** directions: naming one requires that exact value on the parsed `Schedule`, and **omitting one
requires it to be absent (or empty) there** - omission is an assertion, not a "don't care". `interval`
follows the same rule as the other two: it is compared as `{ seconds }`, and an `expectSummary` that
omits it requires `Schedule.interval` to be absent. Only `values` and `star` are genuinely opt-in: they
compare only the field names they list, by exact value, ignoring every other field the schedule has -
`detect-question-mark-position-separates-quartz-from-aws` (`corpus/cases/parse/aws.json`) relies on the
`candidates` rule the other way: its whole point is that *no* `candidates` came back.

`expectError` is `{ "code", "span" }`. The codes are a closed list: `empty`, `field-count`,
`bad-token`, `out-of-range`, `bad-step`, `bad-range`, `unknown-macro`, `unknown-dialect`,
`bad-timezone`, `bad-wrapper`, `bad-interval`. Parsing never throws and never returns a partial
schedule. An input that is not a string (`null`, `undefined`, a number, a plain object, an array, ...)
is reported as `empty` with span `[0, 0]`, the same code an empty string gets; a port written in a
statically typed language has no such input and need not model it.

**Detection** (`options.dialect` omitted) first narrows to the claiming dialects if any dialect claims
the input (see Forms above); within that pool (or the full `dialects/index.json` order if none claims
it), a dialect is a candidate when it parses the input with no `unsupported` term. Candidates that
needed `trailing` are dropped as long as one without it remains, so `0 0 12 * * ?` is Quartz rather than
Vixie with a stray `?` as a command. The first survivor wins, and `candidates` is set only when more
than one survived - `parse('0 9 * * 1')` (no restricted token any dialect disagrees on) gives `dialect:
'vixie'` and `candidates: ['vixie', 'kubernetes', 'github-actions']`. If nothing qualifies: the first
dialect that parsed at all, else the first error that is not `field-count`, else the first error. No
detection heuristic lives anywhere but this rule.

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
  "anchor": "2026-09-21T10:00:00Z",       // optional, RunOptions.anchor - only meaningful for an interval schedule
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
`vixie-gap-fixed-time-catches-up` in `cases/next/dst.json` sets no `until`, `anchor`, `notMatching` or
`skipDerived`, and its `expect` holds three runs, of which only the first is shown here.

**`anchor`** is `RunOptions.anchor`, passed to `next`/`prev` when the case sets it. Omitting it from a
case means `next`/`prev` are called with **no** `anchor` option at all, so the engine defaults it to
`from` - the anchor is not "there is no anchor", it is "the anchor is whatever `from` is". It only
matters for an interval schedule; a calendar schedule ignores it.

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
`next(schedule, {from, count, until, anchor?})` deep-equals `expect` (`anchor` passed only when the case
sets one, same as any other optional key), and that every `notMatching` instant does not match, a
runner must also - unless `skipDerived` is set or `expect` is empty - check:

Every derived check below passes `anchor: (case.anchor ?? case.from)` explicitly, because `matches` has
no `from` of its own to default an omitted anchor to the way `next`/`prev` do; `notMatching` checks pass
the same anchor.

1. **`matches` agrees with every expected run.** For each `e` in `expect`, `matches(schedule, e.at,
   { anchor })` is true.
2. **`matches` is false one unit earlier**, where the unit is the dialect's resolution: **1 second**
   if the schedule has a `second` field **or is an interval schedule**, **60 seconds** otherwise. Skip
   this for an `e.at` that is not more than one unit after the previous expected run - that guards the
   equal-instant groups, and the first comparison is against `from`.
3. **`prev` returns the same runs, reversed.** `prev(schedule, {from: last.at + 1 second, count:
   expect.length, anchor})` deep-equals `expect` reversed, `dst` and `scheduled` included. This is what
   pins the order inside an equal-instant group without a separate case.

Deriving three assertions from one case is deliberate: it means a port cannot satisfy the corpus by
special-casing `next`.

## Provenance

Every case carries `provenance.kind`:

- **`spec`** - the dialect's specification or its documented behaviour.
- **`derived`** - read out of reference implementation source. `source` is required and cites
  `DERIVATION.md` by section (`corpus/DERIVATION.md H2`), which in turn quotes the file, function and
  line it was read from.
- **`assumed`** - the platform's own documentation is silent on this behaviour (there is no reference
  implementation to fall back on either, for GitHub Actions and AWS EventBridge). `source` is required
  and cites the `DERIVATION.md` entry that records the silence and states the choice made. An `assumed`
  case is the corpus's own decision, not a fact read off something that runs; a port that later gets to
  test against the real platform should treat every `assumed` case as the first thing to re-check.
- **`captured`** - recorded from a running reference implementation. `platform` and `recording` are
  required. No case uses this yet; there is no capture harness.

### Assumptions

Every behaviour pinned only by an `assumed` case, in one place. Found by searching the corpus for
`"kind": "assumed"` and reading each case's `source`.

1. **G1 - `7` as Sunday, and a reversed range, in GitHub Actions.** GitHub's docs give the field ranges
   (`0-6` for day-of-week) but never say whether `7` is also accepted, and never mention reversed ranges
   at all. Assumed both are errors. Cases: `github-sunday-seven-is-an-error`,
   `github-reversed-range-is-an-error`. Two detection cases inherit this assumption, because "GitHub
   does not accept this input" is part of why the other dialect wins: `detect-sunday-seven-is-vixie-only`
   (which also cites K2, where `7` is a hard error in Kubernetes too) and
   `detect-weekend-range-is-vixie-only` (which also cites H3 and K5 for the vixie/Kubernetes side of the
   comparison).
2. **G5 (gap) - which schedules GitHub Actions advances out of a spring-forward gap.** GitHub documents
   only a single fixed-time example (`2:30 -> 3:00`). Assumed only a fixed-time schedule advances, one
   run per gap, none when a natural run already exists at the transition instant, and a wildcard
   schedule is left alone to continue in real time (strategy `next-valid`). Cases:
   `github-gap-two-skipped-times-advance-once`, `github-gap-natural-run-is-not-doubled`,
   `github-gap-wildcard-follows-real-time`.
3. **G5 (overlap) - GitHub Actions' fall-back behaviour.** GitHub's docs describe the gap but say
   nothing about the overlap. Assumed cronie's rule: a fixed-time schedule fires on the first pass only,
   a wildcard schedule fires on both (strategy `vixie-window`). Cases:
   `github-overlap-fixed-time-runs-once-on-the-first-pass`, `github-overlap-wildcard-runs-on-both-passes`.
4. **G10 - `?`, `L`, `W`, `#` and a seconds field in GitHub Actions.** GitHub's docs are silent on all
   five - neither documented nor explicitly rejected. Assumed unsupported: such a term parses but is
   flagged `unsupported: true` rather than rejected outright. Case:
   `github-quartz-tokens-are-unsupported`. One detection case inherits this assumption, because "GitHub
   flags `?`" is part of why Kubernetes wins: `detect-question-mark-in-five-fields-is-kubernetes` (which
   also cites K3 for the Kubernetes side).
5. **A2 - whether AWS accepts `0` for Sunday.** AWS's docs establish `1` = Sunday only by example (never
   in prose), and the documented day-of-week range is `1-7`; they never say whether `0` is also accepted
   as Sunday.
   Assumed `0` is `out-of-range`, and that day-of-week names are case-insensitive. `7` = Saturday is
   **not** part of this assumption - it follows from the documented `1-7` range together with the `#`
   example's "3 refers to Tuesday" (so `1` = Sunday ... `7` = Saturday), which is deducible from
   documented text rather than a choice this corpus made. Case: `aws-zero-is-not-a-day-of-week`.
6. **A4 - `LW`, `L-n` and multi-`#` in AWS.** AWS's docs document `L`, `nW`, `nL` and `n#m`, but are
   silent on `LW`, `L-n` and any multi-`#` form. Assumed unsupported: such a term parses but is flagged
   `unsupported: true` rather than rejected outright. Case:
   `aws-undocumented-quartz-tokens-are-unsupported`.
7. **A5 - `*/n` in AWS.** AWS's docs document only the `first/step` form (`1/10`); `*/n` never appears
   in either doc. Assumed `*/n` is legal, with the same meaning as `min/n`. Case:
   `aws-star-slash-step-is-allowed`.
8. **A9 - upper bound on an AWS rate's `value`.** AWS's docs give no upper bound for `value` in
   `rate(value unit)`. Assumed the resulting `seconds` must be a JavaScript safe integer (beyond
   2^53 - 1 seconds is `bad-interval`) - this library's own safe-integer limit, not a fact read off
   AWS. Case: `aws-rate-value-too-large`.
9. **A10 - when an AWS rate schedule first fires.** AWS's docs say a rate schedule "starts when you
   create" the rule and "starts invoking ... immediately", without saying whether the very first
   invocation is at the anchor instant or one interval after it. Assumed at-anchor: the first run is the
   anchor instant itself (`intervalFirst: "at-anchor"`). Case: `aws-rate-first-run-is-the-anchor`.
10. **A13 - AWS's default time zone.** The `ScheduleExpressionTimezone`/`ScheduleExpressionTimeZone`
    parameter is documented as optional with no default value stated. Assumed UTC
    (`defaultTimezone: "utc"`). No case rests on this one: it is a fact about the *reference* platform's
    own default, recorded on the dialect for a future port to reproduce; this library's own `parse`
    always defaults every dialect's `timezone` to UTC regardless, so nothing here distinguishes AWS's
    assumed default from any other dialect's.
11. **A16 - whether AWS's DST rule is fixed-time-only.** The DST section's only worked example is a
    single fixed-time schedule; there is no wildcard example for either the gap or the overlap. Assumed
    the documented fixed-time rule applies to every schedule alike - skip a wall time in a gap, fire once
    on the first pass of an overlap (strategy `once-first`, and `dstGap: "skip"` needs no schedule-shape
    test to begin with). Case: `aws-overlap-wildcard-fires-on-the-first-pass-only`.

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
6. **robfig's descriptor matching is whitespace- and case-exact; this corpus's macros are not.**
   robfig's `parseDescriptor` matches the raw string byte-for-byte, so `"@daily "` (a trailing space)
   and `"@DAILY"` both fail there as `unrecognized descriptor` (DERIVATION K6). Here, the field
   tokenizer already discards surrounding whitespace before a macro token is even looked at (see
   Tokenizing above), so `"@daily "` and `"@daily"` parse identically; macro names remain
   case-sensitive (`macros` in dialect data), so `"@DAILY"` is still `unknown-macro`.
7. **Kubernetes rejects any schedule containing the substring `TZ` at admission; here it is an
   ordinary parse error.** `validation.go` rejects any CronJob `spec.schedule` containing `TZ` outright
   (DERIVATION K8), independently of whether it looks like a `TZ=`/`CRON_TZ=` prefix. This library has
   no `TZ=`-prefix form for any dialect, so the same text simply fails as whatever a stray `TZ...` token
   fails as in the ordinary field grammar (typically `bad-token` or `out-of-range` on the first field) -
   there is no dedicated `TZ`-rejection code path or error code.
8. **Several documented AWS/GitHub limits are not enforced by `parse`.** The GitHub Actions 5-minute
   floor (G6), AWS's "cron expressions that lead to rates faster than 1 minute are not supported" limit
   (A7), AWS's "only one `#` expression in the day-of-week field" limit (A4), and AWS's "exactly one of
   day-of-month/day-of-week must be `?`" rule (A3) are all left for a later lint pass: `parse` accepts a
   schedule that violates any of them, and no case asserts an error for any of these four rules.
9. **Classic EventBridge rules are UTC-only; this dialect accepts any zone.** Classic (legacy)
   EventBridge rules are always UTC (A12); the `aws` dialect here models EventBridge **Scheduler**'s
   zone support (`ScheduleExpressionTimezone`, A13) instead, so a `timezone` other than UTC is accepted
   even though it would be meaningless on a classic rule.
10. **AWS one-time `at(...)` schedules are not supported.** EventBridge Scheduler's `at(yyyy-mm-ddThh:mm:ss)`
    one-time form (A17) has no dialect entry, no case and no strategy id; it is out of scope for this
    corpus.
11. **The Kubernetes evidence is a hand trace, not a run of robfig/cron.** Every `K1`-`K16` verdict in
    `DERIVATION.md` is a manual reading of the quoted Go source (`[hand]`), cross-checked by a Python
    line-by-line transcription of the same source (`[sim]`) - no Go toolchain ran the real library. The
    two DST sections (K11-K13) are called out there as the ones most in need of a real-build
    re-verification before this corpus is trusted at face value for Kubernetes.
12. **robfig accepts a schedule this corpus refuses outright.** robfig's comma split drops empty runs,
    so an empty list item and a trailing comma both parse (`1,,2` -> `{1,2}`, a trailing comma is
    accepted), and, because the `*`/`?` test looks only at the part of a term before its first hyphen,
    `*-5` and `?-5` both parse as a plain `*` with the text after the hyphen silently discarded (K3, K9). Here
    all four are `bad-token` (`parse('1,,2 * * * *', {dialect:'kubernetes'})` -> `bad-token [2,2]`), so a
    schedule Kubernetes/robfig admits is refused here.
13. **robfig requires exactly `"@every "` before the duration; this corpus is tolerant of whitespace
    around and inside it.** robfig's descriptor `switch` matches `"@every "` (a single space) as a
    literal prefix and hands the rest of the string to Go's `time.ParseDuration`, so each way of writing
    it differently fails differently: `@every5m` and `@every` + a tab + `5m` never match the prefix and
    are `unrecognized descriptor`; `@every  5m` does match it, then fails inside `ParseDuration` on the
    remaining `" 5m"`; and ` @every 5m` does not start with `@` at all, so it reaches the five-field
    parser (K6, K7). Here `@every`
    accepts one or more of the same whitespace characters listed under Tokenizing both before the
    duration and around the whole macro (`@every  5m`, `@every\t5m`, `@every` + a U+00A0 non-breaking space + `5m`, ` @every 5m` and
    `@every 5m ` all parse to the same 300-second interval).
14. **AWS requires the `cron(...)` wrapper at the API level; this corpus also accepts the bare six
    fields.** Every documented example wraps the expression, and the wrapper "is required at the API
    level" (A6); the bare-fields form here (`aws-bare-fields-parse-too`) is this library's own leniency,
    not AWS behaviour - it is `spec` provenance with no `source`, because it pins a choice this library
    made, not a fact read off AWS's documentation.
15. **AWS's treatment of a leading zero in a `rate()` value is undocumented; this corpus accepts it.**
    Neither AWS doc discusses leading zeros in `rate(value unit)`'s `value`; `rate(05 minutes)` and
    `rate(01 minute)` both parse here (as 300 and 60 seconds respectively) rather than being rejected as
    malformed.
16. **`go-duration`'s running total is a JavaScript number, not Go's `int64`.** The reference accumulates
    a duration's nanoseconds in ordinary float64 arithmetic; Go accumulates in 64-bit integer nanoseconds.
    Both agree everywhere a real schedule would land, but they can differ: for a duration longer than
    about 104 days (2^53 ns) that carries odd nanoseconds, for a fractional part written with hundreds of
    digits, and within a few thousand nanoseconds of the 2^63 - 1 limit, where float64 can no longer
    represent every integer exactly. No corpus case pins behaviour in that range; a port should follow Go
    (accumulate as a 64-bit integer), not this reference implementation.
