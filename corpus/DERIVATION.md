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
