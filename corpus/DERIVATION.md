# Derivation notes

How the Vixie and Quartz behaviours that `@peppercron/core` reproduces were established.
Corpus cases with `provenance.source` pointing at this file cite the section below by its
`H` number.

Sources fetched 2026-09-21:

| Source | Path | Commit touching that file |
| --- | --- | --- |
| cronie (the Vixie cron shipped on Linux) | `src/entry.c` | `e6c2853` (2025-05-07), repo HEAD `cede1d6` |
| cronie | `src/cron.c` | `5ea5553` (2025-06-20), repo HEAD `cede1d6` |
| cronie | `src/job.c`, `src/macros.h` | repo HEAD `cede1d6` (2026-09-03) |
| Quartz | `quartz/src/main/java/org/quartz/CronExpression.java` | `ade2324` (2025-12-30), repo HEAD `0683c9f` |
| Vixie cron (upstream, Paul Vixie's own tree) | `entry.c` | `9cc8ab1` (2024-08-15) |
| Vixie cron (upstream) | `cron.c` | `6934bc3` |
| FreeBSD cron | `usr.sbin/cron/lib/entry.c` | `main` @ 2026-09-21 |

cronie's `src/entry.c` and `src/cron.c` and Quartz's `CronExpression.java` are the sources the plan
names; `src/job.c` and `src/macros.h` were needed to finish H2. The two extra
Vixie trees were fetched because cronie turned out to disagree with the plan on H3 and H7; they are
recorded so the divergence is not mistaken for a reading error, and `vixie/cron`'s `cron.c` is the
cross-check behind the second bullet under "Scope of these answers".

**Method.** Everything below is read from the source. In addition, the Quartz answers (H3, H4,
H6, H8) were executed: `CronExpression.java` compiles standalone (it imports only `java.*`), so it
was compiled and driven against real transition instants. Line numbers refer to the files as
fetched. Quoted code is verbatim.

The cronie answers (H1, H2, H5, H6-Vixie, H7) are source reading only - `crond` is a Linux daemon
and was not run.

---

## H1. cronie wildcard test for DST handling

**Provisional value in the plan:** a schedule is "wildcard" when the minute field or the hour field
begins with `*`; otherwise it is "fixed-time".

**Verdict:** confirmed

**Evidence:** `src/entry.c`, `load_entry`, lines 228-240 - the flag is set from the *first
character* of the field, before the field is parsed:

```c
		if (ch == '*')
			e->flags |= MIN_STAR;
		ch = get_list(e->minute, FIRST_MINUTE, LAST_MINUTE, PPC_NULL, ch, file);
```

(and the identical three lines for `HR_STAR` at 239-241). `src/cron.c`, `find_jobs`, lines 593-596
is the only consumer, and it tests the two flags together:

```c
				if ((doNonWild &&
						!(e->flags & (MIN_STAR | HR_STAR))) ||
					(doWild && (e->flags & (MIN_STAR | HR_STAR))))
					job_add(e, u);	/*will add job, if it isn't in queue already for NOW. */
```

Three consequences of "first character" that the phrase "begins with `*`" gets right and a
semantic reading would get wrong:

- `*/5 * * * *` **is** wildcard (`ch == '*'`), so steps do not change the classification.
- `0-59 * * * *` is **not** wildcard, although it matches every minute; only `HR_STAR` saves it.
- `@hourly` sets `HR_STAR` explicitly (`entry.c:210`) so it is wildcard;
  `@daily`, `@weekly`, `@monthly`, `@yearly` set neither flag (`entry.c:173-203`) and are
  fixed-time.

**Effect:** confirms the `vixie` dialect's wildcard predicate as a purely syntactic test on the raw
minute and hour field text, evaluated at parse time and stored on the parsed schedule - not a test
on the expanded minute/hour sets. Strategies selected by it: H2 (gap) and H6 (overlap).

---

## H2. Several matches of a fixed-time job inside one spring-forward gap (`0,30 2 * * *`)

**Provisional value in the plan:** one catch-up run at the transition instant.

**Verdict:** falsified - it is **one run per skipped matching wall minute** (so `0,30 2 * * *` runs
**twice**), all at real time just after the transition.

**Evidence:** `src/cron.c`, `main`, lines 427-455. cronie's clocks are wall-clock minutes
(`clockTime = (StartTime + GMToff) / 60`, line 624) and `GMToff` is recomputed when `tm_isdst`
flips (lines 619-623), so a one-hour spring forward shows up as `timeDiff == 61`. With
`MINUTE_COUNT == 60` (`macros.h:114`), `3 * MINUTE_COUNT` is 180 minutes, so any transition of up
to three hours lands in `case medium`:

```c
				/* run wildcard jobs for current minute */
				find_jobs(timeRunning, &database, TRUE, FALSE, GMToff);

				/* run fixed-time jobs for each minute missed */
```

and the loop that follows (lines 445-454) steps `virtualTime` through every skipped wall minute,
calling `find_jobs(virtualTime, &database, FALSE, TRUE, oldGMToff)` for each one. The queue is
drained at the top of each iteration (`if (job_runqueue()) sleep(10);`, line 446), and `job_add`
de-duplicates only against jobs *currently* in the queue (`job.c:48-51`), which `job_runqueue`
empties (`job.c:99-106`). So the 02:00 match and the 02:30 match are two separate runs.

Two further details the strategy has to carry:

- Catch-up is **best-effort**: the loop condition is
  `while (virtualTime < timeRunning && clockTime == timeRunning)`, and `set_time(FALSE)` is called
  each iteration, so if the catch-up spills past one real minute (each job that actually runs costs
  a `sleep(10)`) the remaining skipped minutes are dropped.
- Wildcard jobs are *not* caught up. Line 442 runs them once, for the current minute only
  (`doWild = TRUE, doNonWild = FALSE`), and the catch-up loop passes `doWild = FALSE`. So
  `*/5 * * * *` gets one run across the gap, not twelve.

**Effect:** changes the `vixie` spring-forward strategy from "one catch-up run" to "one run per
matching skipped wall minute, emitted at the transition instant". Corpus cases for `0,30 2 * * *`
across a spring forward must expect two run times, not one. Needs a strategy id distinct from the
provisional one (see the report).

---

## H3. `rangeWrap` when start > end

**Provisional value in the plan:** Vixie `error`, Quartz `wrap`.

**Verdict:** Quartz **confirmed** (`wrap`). Vixie **falsified against cronie**: cronie neither
errors nor wraps - it accepts the range and produces an **empty set** for it. (The provisional
value `error` is correct for upstream Vixie cron; the two implementations disagree.)

**Evidence, cronie:** `src/entry.c`, `get_range`, lines 636-648 and 689-693. `R_RANGE_NUM2` has no
`low_ > high_` rejection, and the element loop simply does not execute:

```c
	for (i = low_; i <= high_; i += step)
		if (EOF == set_element(bits, low, high, i)) {
```

So `5-1` in the minute field sets no bits, returns normally, and `load_entry` never checks a field
for emptiness - the crontab loads and the job never fires. One special case sits at lines 641-643:

```c
				if (low_ > high_ && high_ == 0) {
					high_ = 7;
				}
```

It exists for day-of-week `5-0` (Fri-Sun, with `7` folded onto `0` at lines 280-283), but
`get_range` is generic, so it applies to **every** field: `5-0` in the minute field sets minutes
5, 6 and 7.

**Evidence, upstream Vixie:** `vixie/cron` `entry.c`, `get_range`, lines 522-524:

```c
			ch = get_number(&num2, low, names, ch, file, "/, \t\n");
			if (ch == EOF || num1 > num2)
				return (EOF);
```

an explicit parse error. FreeBSD's `usr.sbin/cron/lib/entry.c` has neither the check nor the
`high_ == 0` hack (lines 609-621, 652-654), so it behaves like cronie minus the `-0` case.

**Evidence, Quartz:** `CronExpression.java`, `addToSet`, lines 1078-1094:

```java
        int max = -1;
        if (stopAt < startAt) {
          switch (type) {
```

then `stopAt += max` (line 1093) and `i % max` at 1102, with `i2 == 0` remapped to `max` for the
1-based fields (1105-1107). Executed: `0 50-10 12 * * ?` yields minutes `0..10,50..59`; `22-2` in hours yields `0,1,2,22,23`;
`FRI-MON` yields days-of-week `1,2,6,7`. Day-of-month wraps mod 31 (`30-2` yields `1,2,30,31`), and
`YEAR` is the one field that refuses to wrap - it throws
`IllegalArgumentException("Start year must be less than stop year")` (line 1090), surfaced as a
`ParseException`.

**Effect:** `quartz.rangeWrap: "wrap"` stands, with the note that the year field is `error` and that
day-of-month wraps modulo 31 rather than modulo the month length. `vixie.rangeWrap` cannot be
`error` if the dialect is cronie; it needs a third value (`empty`) plus the `end == 0 -> end = 7`
rewrite. See the report - this is a value the controller has to rule on, because it decides whether
"Vixie" means cronie or Paul Vixie's tree.

---

## H4. Quartz run whose wall time falls in a gap

**Provisional value in the plan:** skipped (no run that day).

**Verdict:** confirmed

**Evidence:** `CronExpression.java`, `setCalendarHour`, lines 1544-1549 - the only DST-aware code
in the class:

```java
        cal.set(java.util.Calendar.HOUR_OF_DAY, hour);
        if (cal.get(java.util.Calendar.HOUR_OF_DAY) != hour && hour != 24) {
            cal.set(java.util.Calendar.HOUR_OF_DAY, hour + 1);
        }
```

`getTimeAfter` builds candidate times by setting fields on a lenient `GregorianCalendar` in the
trigger's zone. A wall time inside a gap is resolved by `GregorianCalendar` with the *pre*-transition
offset, which normalises to the post-transition instant - verified directly: setting
`2027-03-14 02:30` in `America/New_York` yields `2027-03-14 03:30 EDT`. `setCalendarHour` then
re-reads the hour, sees the shift, and accepts it. On the next pass of the `while (!gotOne)` loop
the hour test at lines 1249-1256 compares the *actual* hour (3) against the hour set (`{2}`), fails,
increments the day (line 1255) and moves on. No candidate inside the gap ever survives.

Executed, `America/New_York`, spring forward 2027-03-14 (gap 02:00-03:00):

| expression | fires |
| --- | --- |
| `0 0 2 * * ?` | `03-13 02:00 EST`, then **`03-15 02:00 EDT`** - 03-14 skipped entirely |
| `0 30 2 * * ?` | `03-13 02:30 EST`, then **`03-15 02:30 EDT`** |
| `0 0 * * * ?` | `03-14 01:00 EST`, **`03-14 03:00 EDT`**, `04:00` - the 02:00 slot vanishes, 03:00 fires once |
| `0 0 2,3 * * ?` | `03-14 03:00 EDT` only - one run that day, not two |

Same result in `Europe/London` (`0 30 1 * * ?` skips 2027-03-28) and for the 30-minute transition
in `Australia/Lord_Howe` (`0 0,15,30,45 * * * ?` goes `01:45 LHST` -> `02:30 LHDT`, dropping the
02:00 and 02:15 slots). Identical output on JRE 1.8.0_503 and JDK 12.0.2, so it is not a JDK-version
artifact.

**Effect:** confirms the `quartz` spring-forward strategy as "skip": a matching wall time inside the
gap produces no run, and nothing is shifted into the following hour. Note for the corpus generator:
a schedule that matches *both* the gap hour and the hour after it still fires only once that day.

---

## H5. Vixie dom/dow rule

**Provisional value in the plan:** if either day field begins with `*`, AND; otherwise OR
(`0 0 */2 * 1` is AND).

**Verdict:** confirmed

**Evidence:** `src/cron.c`, `find_jobs`, lines 579-586:

```c
				(((e->flags & DOM_STAR) || (e->flags & DOW_STAR))
					? (bit_test(e->dow, dow) && bit_test(e->dom, dom))
						: (bit_test(e->dow, dow) || bit_test(e->dom, dom))
				)
```

with the flags set, exactly as in H1, from the first character of each field -
`entry.c:250-251` (`DOM_STAR`) and `entry.c:270-271` (`DOW_STAR`). `*/2` in day-of-month therefore
sets `DOM_STAR`, so `0 0 */2 * 1` takes the AND branch: it fires only on Mondays that fall on an
odd day of the month. The behaviour is deliberate; `cron.c:565-570` documents it ("yes, it's
bizarre. like many bizarre things, it's the standard.").

One `@`-shortcut wrinkle, harmless but worth recording: `@daily` and `@hourly` set neither day flag
(`entry.c:197-211`), so they take the OR branch - with both day sets full the result is the same.
`@weekly` sets `DOM_STAR`, `@monthly` and `@yearly` set `DOW_STAR`.

**Effect:** confirms `vixie.dayFieldCombine` as a syntactic test on the raw day-of-month and
day-of-week field text (leading `*`), matching the H1 predicate, and confirms the corpus case
`0 0 */2 * 1` as AND.

---

## H6. Overlap, fixed-time Vixie job and any Quartz job

**Provisional value in the plan:** runs once, at the first occurrence.

**Verdict:** Vixie **confirmed** (once, first occurrence). Quartz **falsified** - Quartz also runs
once, but at the **second** (standard-offset) occurrence; the first pass never produces a fire time.

**Evidence, Vixie:** `src/cron.c`, `main`, lines 457-469. A fall back makes `timeDiff` negative
(`clockTime` drops with `GMToff`), which selects `case negative`:

```c
				Debug(DSCH, ("[%ld], DST ends %d minutes to go\n",
						(long) pid, timeDiff));
				find_jobs(timeRunning, &database, TRUE, FALSE, GMToff);
```

`doNonWild` is `FALSE` and `virtualTime` is deliberately not advanced, so throughout the repeated
hour only wildcard jobs run. The fixed-time job already ran on the first pass through that wall
minute (the ordinary `timeDiff == 1` path) and is not repeated - the comment at 457-465 says so:
"The fixed-time jobs probably have already run, and should not be repeated."

**Evidence, Quartz:** the same `GregorianCalendar` resolution as H4, in the other direction. An
ambiguous wall time resolves to the **standard-time** (later) occurrence: setting
`2027-11-07 01:30` in `America/New_York` yields `01:30 EST` (epoch 1825569000), not `01:30 EDT`
(1825565400). Every candidate `getTimeAfter` constructs inside the overlap therefore lands on the
second pass. Executed, `America/New_York`, fall back 2027-11-07 (01:00-02:00 repeated):

| from | expression | fires |
| --- | --- | --- |
| `00:00 EDT` | `0 0 * * * ?` | **`01:00 EST`**, `02:00 EST`, ... - `01:00 EDT` never returned |
| `00:59 EDT` | `0 * * * * ?` | **`01:00 EST`**, `01:01 EST`, ... - a full hour of real time with no fire |
| `01:00 EDT` | `0 0 * * * ?` | `02:00 EST` - seeded *on* the first pass, it still skips to 02:00 |
| `11-06 12:00` | `0 30 1 * * ?` | `01:30 EST` once |

Same in `Europe/London` (`0 0 * * * ?` -> `01:00 GMT`, skipping `01:00 BST`) and `Europe/Berlin`
(`0 30 2 * * ?` -> `02:30 CET`, skipping `02:30 CEST`). Identical on JRE 8 and JDK 12.

A trap worth encoding: `isSatisfiedBy` disagrees with `getTimeAfter`. It is a plain field match on
the wall clock, so for `0 0 * * * ?` it returns `true` for **both** `01:00 EDT` and `01:00 EST`,
while `getTimeAfter` only ever yields the second. Quartz's own `matches` and `next` are
inconsistent across an overlap.

**Effect:** the two dialects need different overlap strategies - `vixie` fixed-time keeps
"first occurrence", `quartz` must be "last occurrence". Corpus cases for a Quartz hourly or
fixed-time job across a fall back must expect the standard-offset instant. If `matches` is intended
to agree with `next`, the Quartz `matches` corpus needs its own note, because the reference
implementation does not.

---

## H7. Vixie `5/15`

**Provisional value in the plan:** accepted, means 5 only (`singleStep: "single"`).

**Verdict:** falsified - cronie **rejects** the crontab line ("bad minute"). No implementation
checked means "5 only".

**Evidence, cronie:** `src/entry.c`, `get_range`, lines 612-626. After `get_number` consumes `5` the
machine is in `R_NUM1`, which accepts only `-`, `~` or a separator (`is_separator` is `\t`, `\n`,
space, `,` - lines 536-546); `/` falls through to the default:

```c
			case R_NUM1:
				if (ch == '-') {
					state = R_RANGE;
```

The arm ends in `return (EOF);` at line 626. `get_list` propagates it (lines 518-519) and `load_entry` turns
it into `ecode = e_minute` (lines 231-234), i.e. the line is rejected with "bad minute". This is not
a master-only regression: `R_NUM1` is present in the released tags `cronie-1.6.1`, `1.7.1` and
`1.7.2`.

**Evidence, upstream Vixie:** `vixie/cron` `entry.c` also rejects it, by a different route -
`get_range` calls `get_number` with the terminator set `",- \t\n"` (line 501), which excludes `/`,
and `get_number` fails a number whose terminator is not in that set (lines 582-584: `if
(!strchr(terms, ch)) goto bad;`).

**Evidence, divergence:** FreeBSD's `usr.sbin/cron/lib/entry.c` *does* accept it, as "from 5 to the
field maximum, step 15" - lines 601-602:

```c
		if (ch == '/')
			num2 = high;
```

Quartz agrees with FreeBSD: `checkNext` lines 842-855 reach `addToSet(5, -1, 15, MINUTE)`, whose
`stopAt == -1` becomes 59 (lines 1034-1040). Executed: `0 5/15 * * * ?` gives minutes
`5,20,35,50`.

**Effect:** `vixie.singleStep` must not be `"single"`. If the dialect is cronie or upstream Vixie it
is `"error"`; `"toMax"` is the FreeBSD/Quartz value and is what `quartz.singleStep` should be. The
corpus case for `5/15` under `vixie` changes from "matches minute 5" to "parse error". See the
report.

---

## H8. Quartz `31W` in a 30-day month

**Provisional value in the plan:** no match that month.

**Verdict:** confirmed

**Evidence:** `31W` parses without complaint - `checkNext` lines 767-776 only rejects `val > 31`,
and stores 31 in `nearestWeekdays`. The month is dropped at match time, in `findSmallestDay`,
lines 1660-1663:

```java
        SortedSet<Integer> st = set.subSet(day, LAST_DAY_OFFSET_START);
        // make sure we don't over-run a short month, such as february
        if (!st.isEmpty() && st.first() < smallestDay && st.first() <= lastDay) {
```

For April, `lastDay` is 30 and `st.first()` is 31, so the guard fails and the method returns
`Optional.empty()`. Back in `getTimeAfter`, `smallestDayForWeekday` is absent, `day` stays `-1`, and
lines 1323-1327 roll to the 1st of the next month (`day = 1; mon++;`). The weekend shifts at lines
1295-1303 are never reached, so `31W` is never nudged back to the 30th.

Executed, `America/New_York`, `0 0 12 31W * ?` from 2027-03-01: `Mar 31` (Wed), `May 31` (Mon),
`Jul 30` (Fri - Jul 31 is a Saturday, shifted back one), `Aug 31` (Tue), `Oct 29` (Fri - Oct 31 is a
Sunday and is the last day of the month, so `day -= 2`), `Dec 31` (Fri). April, June, September and
November are absent. `0 0 12 31W 4 ?` and `0 0 12 31W 2 ?` return `null` - they never fire at all.
Contrast `LW`, which does fire every month (`Mar 31`, `Apr 30`, `May 31`, `Jun 30`).

**Effect:** confirms the corpus case - `31W` yields no run in April, June, September, November, or
February, and the shift never crosses a month boundary in either direction (`day == 1` shifts
forward to the 3rd, `day == lastDay` shifts back to `lastDay - 2`).

---

## Scope of these answers

- **"Vixie" is ambiguous and this matters.** cronie, Paul Vixie's own tree and FreeBSD's cron give
  three different answers to H3, and cronie/Vixie disagree with FreeBSD on H7. Everything above is
  answered against **cronie**, as the plan directs, with the other trees quoted where they differ.
  Whichever tree the dialect claims to be, it has to say so.
- **The ambiguity is contained to H3 and H7.** H1, H2, H5 and the Vixie half of H6 were
  cross-checked against `vixie/cron` and read identically there: the star flags come from the same
  leading-`*` test (`entry.c:197-198` `MIN_STAR`, `209-210` `HR_STAR`, `230-231` `DOM_STAR`,
  `253-254` `DOW_STAR`); the dom/dow ternary and the `doWild`/`doNonWild` test are the same
  expression (`cron.c:317-324`, which adds only an `L` extension via `DOM_LAST`); the 3-hour
  `MINUTE_COUNT` classification (`cron.c:167-175`), the `medium` per-skipped-minute catch-up loop
  (`cron.c:210-222`) and the `negative` wildcard-only case (`cron.c:225-237`) are the same code.
  So a decision to read "Vixie" as one tree or the other only moves H3 and H7.
- The Quartz answers describe `CronExpression` at `ade2324`. The `nearestWeekdays` set and
  `findSmallestDay` used by H8 are recent structure; a dialect that claims to reproduce Quartz 2.3.x
  should re-derive H8 against that tag rather than assume this file applies.
- The cronie answers describe the daemon's scheduling loop, which is a wall-clock catch-up loop, not
  a "next run time" function. H2 in particular has no exact analogue in a `next()` API: the runs it
  produces are the skipped wall minutes, emitted at one real instant.

---

## Kubernetes (robfig/cron v3.0.1 as pinned by Kubernetes v1.34.0)

**Evidence grade.** Everything below is a hand trace of `github.com/robfig/cron/v3` (`v3.0.1`,
commit `ccba498c397bb90a9c84945bbb0f7af2d72b6309`) as vendored by `kubernetes/kubernetes` `v1.34.0`,
cross-checked by a line-by-line Python transcription of the same source (`gonext_sim.py`). No Go
toolchain was available on the research machine, so **nothing was run against the real library** -
every `[hand]` claim is a manual trace of quoted Go source, every `[sim]` result is that transcription
run in Python, and `[quoted]` is read directly off the source lines cited. The `[sim]` transcription
agrees with every `[hand]` trace below, but it is not robfig's own code executing; the two spring/fall
DST sections (K11-K13) in particular should be re-verified against a real Go build before shipping.
Line numbers refer to `parser.go`, `spec.go`, `constantdelay.go`, `doc.go` (robfig/cron) and
`validation.go`, `utils.go`, `cronjob_controllerv2.go` (kubernetes/kubernetes), as fetched at the pin
above.

### K1. Field count and order; seconds; year

**Verdict:** exactly 5 fields, `minute hour dom month dow`. Seconds are never accepted. There is no
year field in any robfig configuration Kubernetes uses.

**Evidence:** `parser.go:217-219` - `var standardParser = NewParser(Minute | Hour | Dom | Month | Dow
| Descriptor)`; `Second` is absent from that option set, so `normalizeFields` fixes `min == max == 5`
and fills the second slot from `defaults[0] == "0"`. **[quoted]/[hand]** Kubernetes only ever calls
`cron.ParseStandard` (`validation.go:793`, `cronjob_controllerv2.go:514`), never constructs a raw
`cron.Cron`, so the `WithSeconds`/`WithLocation` options in `option.go` are unreachable from CronJob.

### K2. Bounds per field; `7` for Sunday; names

**Verdict:** minute 0-59, hour 0-23, dom 1-31, month 1-12 (+`JAN`-`DEC`), dow 0-6 (+`SUN`-`SAT`) -
**`7` is a hard error, not an alternate Sunday.** Names are case-insensitive and accepted at either
end of a range.

**Evidence:** `spec.go:20-49` bounds table (`dow = bounds{0, 6, map[string]uint{"sun": 0, ...
"sat": 6}}`); the range-end check, `parser.go:307-309`: `if end > r.max { return 0, fmt.Errorf("end of
range (%d) above maximum (%d): %s", end, r.max, expr) }` - so `* * * * 7` fails with `end of range (7)
above maximum (6): 7`. **[quoted]/[sim]** Case-insensitivity, `parser.go:321-328`:
`parseIntOrName` looks names up via `names[strings.ToLower(expr)]` and is called for both ends of a
range (`parser.go:267,275`); the step is always parsed numerically. **[quoted]**

### K3. `?` - where accepted, what it means

**Verdict:** `?` is a plain synonym for `*`, accepted in **every one of the five fields**, not just
dom/dow as the library's own docs claim.

**Evidence:** `parser.go:261-266` - the only place `?` appears in the library: `if lowAndHigh[0] ==
"*" || lowAndHigh[0] == "?" { start = r.min; end = r.max; extra = starBit }`. There is no field-
position check anywhere. **[quoted]** **[sim]:** `?` in minute, hour and month all parse to the full
range plus the star bit; because only `lowAndHigh[0]` is tested, `*-5`, `?-5` and `*-99` all parse as
plain `*` (the text after the hyphen is silently discarded). **[hand]/[sim]**

### K4. Steps

**Verdict:** `5/15` means `5-max/15` (minutes `{5,20,35,50}`) - "single value with step" extends to
the end of the field, not "every 15 from 5 forever". `*/0` and `5/0` are errors. A step larger than
the range (`*/90`) is not an error; it yields `{min}` only.

**Evidence:** `parser.go:284-302` - `case 2: step, err = mustParseInt(...); if singleDigit { end =
r.max }; if step > 1 { extra = 0 }`, where `singleDigit` is `len(lowAndHigh) == 1` (`parser.go:257`,
i.e. no hyphen), so `5/15` extends to max but `5-5/15` does not. The zero-step guard,
`parser.go:313-315`: `if step == 0 { return 0, fmt.Errorf("step of range should be a positive number:
%s", expr) }`. The oversized-step case is simply `getBits`'s loop (`parser.go:352-356`, `for i := min;
i <= max; i += step`) running once. **[quoted]/[sim]**

### K5. Reversed ranges

**Verdict:** hard error, never empty and never wrapping. Exact text: `beginning of range (%d) beyond
end of range (%d): %s`.

**Evidence:** `parser.go:310-312` - `if start > end { return 0, fmt.Errorf("beginning of range (%d)
beyond end of range (%d): %s", start, end, expr) }`. Names are resolved to numbers before the
comparison, so `SAT-SUN` reports `beginning of range (6) beyond end of range (0): SAT-SUN`.
**[quoted]/[sim]** Kubernetes surfaces `err.Error()` verbatim at admission (`validation.go:793-795`),
so this string is what `kubectl apply` shows the user.

### K6. Descriptors

**Verdict:** exactly `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`,
`@every <duration>`. **`@reboot` is not accepted.** Matching is byte-exact: case-sensitive and
whitespace-sensitive.

**Evidence:** `parser.go:364-434` is a `switch` on the raw string; the fallthrough is `return nil,
fmt.Errorf("unrecognized descriptor: %s", descriptor)`, so `@reboot` and `@DAILY` both hit it.
**[quoted]** Whitespace, **[hand]:** a trailing space (`"@daily "`) still enters `parseDescriptor`
(only the TZ branch is `TrimSpace`d, `parser.go:102`) and fails to match any case; a leading space
(`" @daily"`) instead falls through to `strings.Fields`, producing `expected exactly 5 fields, found
1: [@daily]`. Descriptor handling is strictly less forgiving of whitespace than field handling (K9).

### K7. `@every <duration>`

**Verdict:** units `ns`, `us`/`µs`/`μs`, `ms`, `s`, `m`, `h` combine and may be fractional; there is no
day or week unit. A delay under 1s is clamped up to 1s; the result is then truncated down to a whole
second (`@every 1500ms` -> 1s, not 2s). The **first run is `anchor + delay`, never at the anchor
itself.**

**Evidence:** `parser.go:424-431` - `const every = "@every "; ... duration, err :=
time.ParseDuration(descriptor[len(every):]); ... return Every(duration), nil` (the prefix includes the
space, so `@every1h` is `unrecognized descriptor`). `constantdelay.go:11-21` -
`func Every(duration time.Duration) ConstantDelaySchedule { if duration < time.Second { duration =
time.Second }; return ConstantDelaySchedule{Delay: duration -
time.Duration(duration.Nanoseconds())%time.Second} }`. `constantdelay.go:23-27` - `Next(t) = t.Add(
schedule.Delay - time.Duration(t.Nanosecond())*time.Nanosecond)`: pure absolute-time addition, no
location and no DST correction (`ConstantDelaySchedule` has no `Location` field). **[quoted]/[sim]**
Anchor: `utils.go:102-118` - `t1 := schedule.Next(earliestTime)` where `earliestTime` is the CronJob's
`creationTimestamp` (or `status.lastScheduleTime` once set); `doc.go:25-26` says the same for the
standalone library ("starting an hour thirty from now"). **[quoted]**

### K8. `TZ=`/`CRON_TZ=` and where the timezone comes from

**Verdict:** robfig accepts both prefixes; **Kubernetes rejects them in user input** but synthesises
`TZ=` itself to implement `spec.timeZone`. Default when `spec.timeZone` is unset is the
kube-controller-manager process's own local time.

**Evidence:** robfig, `parser.go:93-103` - `if strings.HasPrefix(spec, "TZ=") ||
strings.HasPrefix(spec, "CRON_TZ=") { ... loc, err = time.LoadLocation(...) }`. Kubernetes rejection,
`validation.go:791-804`: `case !allowTZInSchedule && strings.Contains(schedule, "TZ"): ... "cannot use
TZ or CRON_TZ in schedule, use timeZone field instead"`, where `allowTZInSchedule` is only true on
update of an object whose **old** spec already contained `TZ` (`validation.go:746-750`, a grandfather
clause) - so on create, any schedule text containing the substring `TZ` anywhere is rejected.
**[quoted]** Where the zone actually comes from, `cronjob_controllerv2.go:761-779` -
`formatSchedule` returns `fmt.Sprintf("TZ=%s %s", *cj.Spec.TimeZone, cj.Spec.Schedule)` when
`spec.timeZone` is set (and just the bare schedule, with an `UnsupportedSchedule` warning event, for a
grandfathered `TZ=` line). **[quoted]** Default: `formatSchedule` returns the bare schedule, so
`parser.go:94` leaves `loc = time.Local`, and `spec.go:73-79` resolves that against the *input* time's
own location - the controller passes `time.Now()`, whose location is the container's local time.
**[hand]**

### K9. Whitespace and trailing fields

**Verdict:** split by `strings.Fields` - runs of any Unicode whitespace, leading and trailing
whitespace ignored. A 6th field is an error. There is no trailing command (a CronJob schedule is the
whole string).

**Evidence:** `parser.go:113-121` - `fields := strings.Fields(spec)`; the count check,
`parser.go:184-190` - `if count := len(fields); count < min || count > max { ... "expected exactly %d
fields, found %d: %s" ... }`. **[quoted]** **[sim]:** `'* * * *'` -> `expected exactly 5 fields, found
4: [* * * *]`; `'0\t0  *   *  *'` parses fine (tabs, runs of spaces). Within a field the comma split
(`parser.go:238`, `strings.FieldsFunc`) drops empty runs, so `1,,2` parses as `{1,2}` and a trailing
comma is accepted. **[quoted]/[hand]**

### K10. Day-of-month vs day-of-week - the star-bit rule

**Verdict:** OR unless either dom or dow carries the **star bit**, in which case AND. The star bit is
*not* a syntactic "begins with `*`" test as in cronie - it is set per comma-separated range by `*` or
`?`, **cleared again whenever that range has a step greater than 1**, and OR-accumulated across the
whole field. `*/2` does **not** count as star; `5,*` **does**.

**Evidence:** `spec.go:51-54` - `const starBit = 1 << 63`; the rule itself, `spec.go:177-188` -
`func dayMatches(...) bool { ...; if s.Dom&starBit > 0 || s.Dow&starBit > 0 { return domMatch &&
dowMatch }; return domMatch || dowMatch }`. The bit is set at `parser.go:261-266` (quoted in K3) and
cleared at `parser.go:297-299` - `if step > 1 { extra = 0 }`; a field's bits are the OR of its
comma-separated ranges (`parser.go:236-247`, `getField`). **[quoted]** This disagrees with cronie's
purely syntactic, first-character test (`corpus/DERIVATION.md` H1) in both directions: `*/2` is a star
for cronie but not for robfig, `5,*` is a star for robfig but not for cronie.

### K11. Spring-forward gap, fixed-time job

**Verdict:** for `30 2 * * *` in `America/New_York` across the 2026-03-08 spring-forward, **the job
does not run that day at all** - not at 01:30, not at 03:00, not at 03:30. It is silently skipped,
exactly once per gap, with no catch-up.

**Evidence, [hand] trace** from `Next(2026-03-07 12:00:00 EST)`: the hour loop (`spec.go:138-147`)
anchors with `time.Date` once (`added = true`) then advances purely by `t.Add(1h)`
(`go1.24.0-time.go:1166`, pure instant arithmetic); stepping through `13:00 ... 23:00, 00:00(03-08)`
wraps the day; from `00:00 EST` on 03-08 the hourly `Add(1h)` steps read `00:00, 01:00, 03:00 EDT,
04:00, ...` - **the wall clock never reads hour 2 on 2026-03-08**, because the `Add(1h)` step walks
straight from `01:00 EST` to `03:00 EDT`. **[sim]** confirms: from `2026-03-07 12:00:00 EST`, `Next`
returns `2026-03-09 02:30:00 EDT` directly, skipping 03-08 entirely, and starting the search *after*
the gap (`Next(2026-03-08 03:00 EDT)`) still returns `2026-03-09 02:30 EDT` (no same-day catch-up).
`0,30 2 * * *` loses both of 03-08's runs the same way - a flat contradiction of cronie's H2 (one run
per skipped wall minute); Kubernetes fires zero.

### K12. Spring-forward gap, wildcard-hour and every-minute jobs

**Verdict:** wildcard jobs lose exactly the runs whose wall time falls in the gap, and nothing else -
no duplication, no catch-up; the sequence stays contiguous in absolute time.

**Evidence, [sim]:** `30 * * * *` from `2026-03-08 00:45 EST` returns `01:30 EST`, then `03:30 EDT`
(02:30 never happens), then `04:30`, `05:30 EDT`, one absolute hour apart throughout. `* * * * *` from
`01:57 EST` returns `01:58`, `01:59`, then `03:00 EDT` (02:00-02:59 never happen), `03:01 EDT` - an
every-minute job loses 60 firings that day (1380 runs instead of 1440). **[hand]** traces the same
`Add(1m)`/wrap mechanism as K11, one field down.

### K13. Fall-back overlap

**Verdict:** for `America/New_York`, 2026-11-01 (`02:00 EDT -> 01:00 EST`, wall `01:00-01:59` occurs
twice), **every matching wall time inside the repeated hour fires twice**, once at each offset, one
absolute hour apart - for fixed-time, wildcard-hour and every-minute schedules alike; nothing is
special-cased. **Kubernetes creates two distinct Jobs** for the pair.

**Evidence, [sim]:** `30 1 * * *` from `2026-10-31 12:00 EDT` returns `2026-11-01 01:30:00 EDT` then
`2026-11-01 01:30:00 EST`, one hour of absolute time apart, then `2026-11-02 01:30:00 EST`.
**[hand]:** after returning the first `01:30 EDT`, the matcher only ever reads `t.Hour()`/`t.Minute()`
(`spec.go:150-171`), so it cannot tell the second occurrence from the first and matches it again once
the `Add` steps carry it there. Two Jobs: `cronjob_controllerv2.go:671-673` -
`getJobName(cj, scheduledTime) = fmt.Sprintf("%s-%d", cj.Name, getTimeHashInMinutes(scheduledTime))`,
and `utils.go:275-278` - `getTimeHashInMinutes(scheduledTime) = scheduledTime.Unix() / 60`: since the
two fires are different unix minutes, the dedup check at `cronjob_controllerv2.go:559-567` treats them
as different Jobs and both are created. **[quoted]** Compare cronie's `dstOverlap: "vixie-window"`
(suppresses the repeat for fixed-time jobs, `corpus/DERIVATION.md` H6) - Kubernetes has no suppression
at all.

### K14. The midnight-transition date-arithmetic fix

**Verdict:** in zones whose DST transition sits at 00:00 local (e.g. `America/Sao_Paulo`,
`America/Havana`), `spec.go`'s day loop corrects the *date* after a `time.Date`/`AddDate` re-anchor
lands on the wrong day - but the fix **does not force hour 0 and does not save a run that the hour
loop would otherwise lose** (K11's mechanism still applies one level up).

**Evidence:** `spec.go:112-136` - `t = t.AddDate(0, 0, 1); if t.Hour() != 0 { if t.Hour() > 12 { t =
t.Add(time.Duration(24-t.Hour()) * time.Hour) } else { t = t.Add(time.Duration(-t.Hour()) * time.Hour)
} }`, commented "Handle that by noticing when the Hour ends up != 0" for Sao Paulo. **[quoted]**
**[sim]** worked example: `America/Sao_Paulo`, spring-forward 2018-11-04 (`00:00 -03 -> 01:00 -02`),
`0 0 * * 0` from `2018-10-29 12:00` skips Sunday 2018-11-04 entirely and next fires `2018-11-11` - the
date-correction lands the day loop on the right calendar day, but the hour loop then still walks past
hour 0 (which the wall clock never reads that day) exactly as in K11. **[hand]/[sim]** `America/Havana`
is the opposite case - fall-back at midnight makes `00:00-00:59` occur twice, so `0 0 * * *` fires
**twice** on the transition day (`2026-11-01 00:00 CDT` then `00:00 CST`). **[sim]**

### K15. Search horizon

**Verdict:** five years past the starting year, then Go's zero time (`0001-01-01 00:00:00 UTC`) -
never an error.

**Evidence:** `spec.go:87-93` - `yearLimit := t.Year() + 5; WRAP: if t.Year() > yearLimit { return
time.Time{} }`. **[quoted]** **[sim]:** `59 23 31 2 *` (an impossible date) returns the zero time.
Kubernetes treats two zero-time results as `t2.Sub(t1) == 0` and reports an `InvalidSchedule` error
rather than looping, `utils.go:127-133`: `"time difference between two schedules is less than 1
second"`. **[quoted]**

### K16. How the controller uses the schedule (informational)

**Verdict:** the anchor is `creationTimestamp`, overridden by `status.lastScheduleTime` once set, and
clamped forward by `startingDeadlineSeconds` when configured; the wake-up algorithm computes
`t1, t2 = Next(anchor), Next(t1)` and, when more than 100 schedules were missed, emits a warning event
but still schedules the most recent slot (not a refusal); the next requeue is `Next(mostRecentTime) +
100ms - now`; granularity is one Job per unix minute of scheduled time.

**Evidence:** `utils.go:102-115` (anchor), `utils.go:117-125` (`t1 = Next(earliestTime)`, `t2 =
Next(t1)`), `utils.go:169-177` - `case numberOfMissedSchedules > 100: missedSchedules = manyMissed`
(a warning: `nextScheduleTime` at `utils.go:219-222` still returns `mostRecentTime`),
`cronjob_controllerv2.go:541-544` (`startingDeadlineSeconds` -> `tooLate`), `utils.go:190-207` and
`cronjob_controllerv2.go:58` (`nextScheduleDelta = 100 * time.Millisecond` requeue pad). **[quoted]**

---

## GitHub Actions (documentation)

The quotes below were re-read from the raw HTML of `docs.github.com/en/actions/using-workflows/
events-that-trigger-workflows` on 2026-09-21 (the "Raw re-check by the controller" pass in
`github-actions.md`), and are preferred over the earlier summarised pass wherever the two overlap.
Timezone support (G5) is a public preview announced 2026-03-19
(`github.blog/changelog/2026-03-19-github-actions-late-march-2026-updates/`, tracked as
`github/roadmap#1187`).

### G1. Syntax standard, field count/order, ranges

**Verdict:** POSIX cron syntax, 5 space-separated fields - minute (0-59), hour (0-23), day of the
month (1-31), month (1-12 or JAN-DEC), day of the week (0-6 or SUN-SAT). **Docs silent** on `7` as an
alternate Sunday and on reversed ranges (e.g. `SAT-SUN`); neither is mentioned anywhere in either
page.

**Evidence:** "Use POSIX cron syntax to schedule workflows to run at specific times." and the field
diagram "day of the week (0 - 6 or SUN-SAT)"
(https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows,
https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions). Pages
checked: both of the above.

**Assumption:** both `7` for Sunday and a reversed range (e.g. `SAT-SUN`) are errors.

### G2. Operators documented

**Verdict:** `*`, `,`, `-`, `/` all documented; `/` accepts a single value plus step (`20/15`, not
only `*/15`), extending to the field's maximum.

**Evidence:** "/ Step values 20/15 * * * * runs every 15 minutes starting from minute 20 through 59
(minutes 20, 35, and 50)." (https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)

### G3. Month/day names (JAN-DEC, SUN-SAT)

**Verdict:** confirmed supported, documented directly in the field diagram.

**Evidence:** "month (1 - 12 or JAN-DEC)", "day of the week (0 - 6 or SUN-SAT)"
(https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions)

### G4. Non-standard macros

**Verdict:** none accepted - explicitly rejected by name, including `@reboot`.

**Evidence:** "GitHub Actions does not support the non-standard syntax `@yearly`, `@monthly`,
`@weekly`, `@daily`, `@hourly`, and `@reboot`."
(https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)

### G5. Time zone

**Verdict:** optional `timezone` key, a sibling of `cron` in each schedule entry, taking an IANA
zone name; default is UTC. Documented DST behaviour is spring-forward only: a schedule whose wall
time falls in a gap advances to the next valid time (their example: 2:30 AM -> 3:00 AM). **Docs
silent** on fall-back (repeated local times), and on whether a wildcard schedule gets an advanced run
in a gap the way the fixed 2:30->3:00 example does.

**Evidence:** "You can optionally specify a timezone using an IANA timezone string for
timezone-aware scheduling." / "By default, scheduled workflows run in UTC." / "For schedules that set
`timezone` to a time zone that observes daylight saving time (DST), during DST spring-forward
transitions, scheduled workflows in skipped hours advance to the next valid time. For example, a 2:30
AM schedule advances to 3:00 AM."
(https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows). Pages checked:
the above, plus workflow-syntax-for-github-actions (the `timezone:` key itself).

**Assumption (fall-back overlap):** a fixed-time schedule (neither the minute nor the hour field is a
star) fires on the first pass only; a wildcard schedule follows real time and fires on both passes
(strategy `vixie-window`).

**Assumption (advanced run in a gap):** no; only fixed-time schedules advance, one run per gap, and
not at all when a natural run already exists at the transition instant (strategy `next-valid`).

### G6. Minimum interval

**Verdict:** the stated shortest interval is 5 minutes. **Docs silent** on what happens to a
more-frequent expression (reject at parse time vs. silently floor to 5 minutes).

**Evidence:** "The shortest interval you can run scheduled workflows is once every 5 minutes."
(https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows). Pages checked:
the above.

### G7. Reliability notes

**Verdict:** confirmed - delivery is best-effort, default-branch-only, and auto-disabled after
inactivity.

**Evidence:** "The `schedule` event can be delayed during periods of high loads of GitHub Actions
workflow runs. High load times include the start of every hour. If the load is sufficiently high
enough, some queued jobs may be dropped." / "Scheduled workflows run on the latest commit on the
default branch." / "In a public repository, scheduled workflows are automatically disabled when no
repository activity has occurred in 60 days."
(https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)

### G8. Day-of-month AND day-of-week - OR or AND?

**Verdict:** **docs silent** on GitHub's own pages - neither fetched page states how day-of-month and
day-of-week combine when both are restricted. The POSIX baseline GitHub cites is OR, by inference
only.

**Evidence (GitHub silence):** pages checked: events-that-trigger-workflows,
workflow-syntax-for-github-actions - neither mentions the combination rule.
**Evidence (POSIX, quoted for the inference):** "Finally, if either the month or day of the month is
specified as an element or list, and the day of week is also specified as an element or list, then
any day matching either the month and day of month, or the day of week, shall be matched."
(https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html)

### G9. Multiple schedules / `github.event.schedule`

**Verdict:** confirmed - a single workflow may have several `- cron:` entries under `on.schedule`,
and the triggering one is available as `github.event.schedule`.

**Evidence:** "A single workflow can be triggered by multiple `schedule` events. Access the
`schedule` event that triggered the workflow through the `github.event.schedule` context."
(https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows)

### G10. Seconds field, `?`, `L`, `W`, `#`

**Verdict:** **docs silent** on all five - none is mentioned as supported or explicitly rejected.
Inferred unsupported, since the field diagram shows only the 5 standard POSIX-style fields under the
"POSIX cron syntax" framing.

**Evidence:** pages checked: events-that-trigger-workflows, workflow-syntax-for-github-actions -
neither page contains the strings "second", "`?`", "`L`", "`W`" or "`#`" in a schedule-syntax context.

**Assumption:** `?`, `L`, `W`, `#` and a seconds field are unsupported in `github-actions`, so a term
using one of them parses but is flagged `unsupported: true` rather than rejected outright.

### G11. POSIX spec itself

**Verdict:** confirmed - the base POSIX crontab spec defines the 5-field ranges GitHub's table
matches; POSIX itself does not define `7` for Sunday, does not define named values, and does not
define step (`/`) values (those are a widely-adopted extension GitHub inherits along with everyone
else, not part of the strict standard).

**Evidence:** "The first five fields shall be integer patterns that specify the following: 1. Minute
[0,59] 2. Hour [0,23] 3. Day of the month [1,31] 4. Month of the year [1,12] 5. Day of the week
([0,6] with 0=Sunday)" (https://pubs.opengroup.org/onlinepubs/9699919799/utilities/crontab.html)

---

## AWS EventBridge (documentation)

Two documented cron/rate dialects share an identical field table but diverge in rate-expression and
DST detail: classic **EventBridge rules** (legacy) and **EventBridge Scheduler** (current). Both are
cited below, distinguished by URL.

### A1. Field count/order, year field required?, year range

**Verdict:** 6 fields - minutes, hours, day-of-month, month, day-of-week, year - range 1970-2199.
Every syntax line and every worked example in both docs uses all 6 fields; neither page states the
year field may be omitted, so it is treated as required.

**Evidence:** "A cron expression consists of six required fields separated by white space: minutes,
hours, day-of-month, month, day-of-week, and year." Field table row: `Year | 1970-2199 | , - * /`
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html,
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html)

### A2. Allowed values/wildcards per field; DOW numbering; SUN/JAN names; 0 or 7 handling

**Verdict:** minutes 0-59, hours 0-23, dom 1-31 (+`, - * ? / L W`), month 1-12/JAN-DEC, dow **1-7**
or SUN-SAT (+`, - * ? L #`), year 1970-2199. DOW numbering (1=Sunday) is established only by example
(`6L` glossed as "last Friday", and the `#` example stating "3 refers to Tuesday"), never stated in
prose. **Docs silent** on whether `0` or `7` is also accepted as Sunday, and on case-sensitivity of
day-of-week names.

**Evidence:** field table (identical in both docs): `Day-of-week | 1-7 or SUN-SAT | , - * ? L #`.
"the 3 refers to Tuesday because it is the third day of each week, and the 2 refers to the second day
of that type within the month" (the `#` example, establishing 3=Tuesday, hence 1=Sunday).
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html,
https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html). Pages checked: the
above two.

**Assumption:** `0` is out of range (an error), and day-of-week names are case-insensitive. `7` =
Saturday is **not** part of this assumption: it is deducible from documented text alone - the field
table's own `1-7` range together with the `#` example's "3 refers to Tuesday" (so `1` = Sunday, `2` =
Monday, `3` = Tuesday, ... `7` = Saturday) - so it needs no case in the Assumptions list.

### A3. Day-of-month/day-of-week "can't specify both" rule

**Verdict:** confirmed, and symmetric - either field may be the one holding `?`.

**Evidence:** "You can't specify the Day-of-month and Day-of-week fields in the same cron expression.
If you specify a value or a * (asterisk) in one of the fields, you must use a ? (question mark) in
the other." / "You can't use * in both the Day-of-month and Day-of-week fields. If you use it in one,
you must use ? in the other."
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html,
identical wording in https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

### A4. Exact meaning of `L`, `W`, `#`; documented forms

**Verdict:** `L` is documented as "last day of the month or week" without distinguishing the two
uses; `W` documents only the `nW` form (nearest weekday to day `n`); `#` documents `n#m` (the `m`-th
occurrence of weekday `n`) and restricts a dow field to a single `#` expression. `nL` (e.g. `6L`) is
demonstrated only by example, not spelled out in prose. **Docs silent** on `LW`, `L-n` and any
multi-`#` form.

**Evidence:** "The L wildcard in the Day-of-month or Day-of-week fields specifies the last day of the
month or week." / "The W wildcard in the Day-of-month field specifies a weekday. In the Day-of-month
field, 3W specifies the weekday closest to the third day of the month." / "The # wildcard in the
Day-of-week field specifies a certain instance of the specified day of the week within a month. For
example, 3#2 would be the second Tuesday of the month..." / "If you use a '#' character, you can
define only one expression in the day-of-week field." / example `cron(15 10 ? * 6L 2019-2022)`
captioned "runs at 10:15am UTC+0 on the last Friday of each month".
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html)

**Assumption:** `LW` and `L-n` are unsupported in `aws`, because only `L`, `nW`, `nL` and `n#m` are
documented or demonstrated; such a term parses but is flagged `unsupported: true` rather than
rejected outright.

### A5. `/` increment meaning; `*/15` documented?

**Verdict:** only the `first/step` form (e.g. `0/15`, `1/10`) is documented; `*/15` never appears in
either doc. **Docs silent** on whether it is valid.

**Evidence:** "The / (slash) wildcard specifies increments. In the Minutes field, you could enter
1/10 to specify every tenth minute, starting from the first minute of the hour (for example, the
11th, 21st, and 31st minute, and so on)."
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html,
https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html). Pages checked: the
above two.

**Assumption:** `*/n` is allowed, with the same meaning as `min/n`.

### A6. `cron(...)` wrapper always required? Whitespace rules inside?

**Verdict:** the `cron(...)` wrapper is required at the API level - every example, on both dialects,
wraps the expression in it. **Docs silent** on tolerance for multiple spaces, tabs, or leading/
trailing whitespace inside the parens.

**Evidence:** "Cron expressions have six required fields, which are separated by white space."
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html). Pages
checked: the above, plus schedule-types.html.

### A7. Minimum frequency/precision; delivery delay

**Verdict:** ~1-minute precision on both dialects. Classic rules explicitly reject cron expressions
implying a rate faster than 1 minute and note a possible multi-second delivery delay; Scheduler
instead documents a 0-59s invocation window with no faster-than-1-minute rejection statement of its
own (the field table's 1-minute floor still applies structurally).

**Evidence:** "All scheduled events use UTC+0 time zone, and the minimum precision for a schedule is
one minute." / "Cron expressions that lead to rates faster than 1 minute are not supported." / "Due
to the distributed nature of EventBridge and the target services, there can be a delay of several
seconds between the time the scheduled rule is triggered and the time the target service runs the
target resource."
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html,
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html) / "All
schedule types on EventBridge Scheduler invoke their targets with 60 second precision. This means
that if you set your schedule to run at 1:00, it will invoke the target API between 1:00:00 and
1:00:59, assuming that a flexible time window is not set."
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

### A8. Other limits (reversed ranges, named lists, etc.)

**Verdict:** **docs silent.** No general rule for reversed ranges is stated; one hours-field example
row uses `20-2` and its gloss ("between 10:00 pm on the starting day to 2:00 am on the following day")
implies wraparound but is never generalised. Lists mixing names and numbers, and year-field range
validation, are not discussed anywhere in either doc.

**Evidence:** pages checked:
https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html,
https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html

### A9. Grammar of `rate(value unit)`

**Verdict:** `rate(value unit)`, `value` a positive integer, `unit` singular for `value == 1` and
plural otherwise (`rate(1 hours)` and `rate(5 hour)` are both explicitly invalid). Scheduler's own
syntax box omits the singular unit forms, but its API reference (authoritative for the wire format)
still lists them. **Docs silent** on any upper bound for `value`.

**Evidence:** "Rate expressions have two required fields separated by white space." / "If the value
is equal to 1, then the unit must be singular. If the value is greater than 1, the unit must be
plural. For example, rate(1 hours) and rate(5 hour) aren't valid, but rate(1 hour) and rate(5 hours)
are valid."
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html) / "A rate
expression consists of a value as a positive integer."
(https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html)

**Assumption:** with no documented upper bound on `value`, this corpus rejects a rate whose resulting
`seconds` is not a JavaScript safe integer, i.e. beyond 2^53 - 1 seconds.

### A10. When does a rate schedule first fire, anchored to what?

**Verdict:** classic rules anchor to rule-creation time; Scheduler anchors to `StartDate` (or fires
immediately if unset). **Docs silent** on whether the very first invocation happens exactly at the
anchor instant or after one interval elapses; the closest wording ("starts invoking ... immediately",
"might occur on, or after, the StartDate") reads as at-anchor without stating it precisely.

**Evidence:** "A rate expression starts when you create the scheduled event rule, and then it runs on
a defined schedule."
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-scheduled-rule-pattern.html) / "If you
do not provide a StartDate for a rate-based schedule, your schedule starts invoking the target
immediately."
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html) / "The date, in UTC,
after which the schedule can begin invoking its target. Depending on the schedule's recurrence
expression, invocations might occur on, or after, the StartDate you specify."
(https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html). Pages checked:
the above three.

**Assumption:** the first rate-schedule run fires exactly at the anchor instant (`at-anchor`).

### A11. Rate schedules and DST; is `rate(1 day)` exactly 24h?

**Verdict:** for Scheduler, confirmed - `rate(1 days)` is a fixed 24-hour duration, explicitly not
adjusted for DST. **Docs silent** on classic (legacy) rate expressions, whose DST section does not
exist (they are documented elsewhere as always UTC, where DST is moot).

**Evidence:** "For rate-based schedules that use days as the unit, such as rate(1 days), days
represents a 24-hour duration on the clock. This means that when daylight savings time causes a day
to shorten to 23 hours, or extend to 25 hours, EventBridge Scheduler still evaluates the rate
expression 24 hours after the schedule's last invocation."
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

### A12. Classic EventBridge rules: always UTC?

**Verdict:** confirmed.

**Evidence:** "All scheduled events use UTC+0 time zone, and the minimum precision for a schedule is
one minute."
(https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-create-rule-schedule.html)

### A13. `ScheduleExpressionTimezone`; default when unset?

**Verdict:** the parameter exists and is optional (String, Required: No). **Docs silent** on an
explicit default value - no page states "the default is UTC" in so many words, though the surrounding
language ("in Universal Coordinated Time (UTC), or in the time zone that you specify") is consistent
with UTC being what happens when it is omitted.

**Evidence:** "The timezone in which the scheduling expression is evaluated." Type: String, Required:
No, no default stated.
(https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html,
identically in https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-scheduler-schedule.html)
/ "EventBridge Scheduler supports configuring cron-based schedules in Universal Coordinated Time
(UTC), or in the time zone that you specify when you create your schedule."
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html). Pages checked: the
above three.

**Assumption:** the default time zone is UTC.

### A14. Spring forward

**Verdict:** confirmed - a schedule whose wall time falls in a gap is skipped entirely that day, and
resumes normally the next.

**Evidence:** "When time shifts forward in the Spring, if a cron expression falls on a non-existent
date and time, your schedule invocation is skipped." / "When time shifts forward in the Spring from
1:59 a.m. to 3:00 a.m., EventBridge Scheduler skips the schedule invocation on that day, and resumes
running the schedule normally the following day."
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

### A15. Fall back

**Verdict:** confirmed - the schedule runs once, at the **first** (pre-shift) occurrence; the second
(post-shift) occurrence does not repeat it.

**Evidence:** "When time shifts backwards in the Fall, your schedule runs only once and does not
repeat its invocation." / "When time shifts backwards in the Fall from 2:59 a.m. to 2:00 a.m.,
EventBridge Scheduler runs the schedule only once at 2:30 a.m. before the shift occurs, but does not
repeat the schedule invocation again at 2:30 a.m. after the time shift."
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)

### A16. Does the DST text distinguish fixed-time from wildcard schedules?

**Verdict:** **docs silent** - the DST section's only worked example is the single fixed-time
schedule `cron(30 2 * * ? *)`; there is no mention of how a highly-wildcarded schedule (e.g.
`cron(0/15 * * * ? *)`) behaves across a gap or an overlap.

**Evidence:** pages checked:
https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html (Daylight savings
section).

**Assumption:** the documented fixed-time rule applies to every wall time: a wall time in a
spring-forward gap is skipped, and a wall time in a fall-back overlap fires on the first
(pre-shift) pass only.

### A17. One-time `at(...)` schedules (informational)

**Verdict:** syntax confirmed, not implemented by this dialect - noted here only so a future task
does not need to re-derive it.

**Evidence:** syntax `at(yyyy-mm-ddThh:mm:ss)`. "A one-time schedule will invoke a target only once
at the date and time that you specify using a valid date, and a timestamp." / "When you configure a
one-time schedule, EventBridge Scheduler ignores the StartDate and EndDate you specify for the
schedule."
(https://docs.aws.amazon.com/scheduler/latest/UserGuide/schedule-types.html)
