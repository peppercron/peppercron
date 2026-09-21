import { formatLocal, formatWall } from './calendar';
import { getDialect, type DialectSpec } from './dialects';
import { compile, nextWallMatch, type Compiled } from './matcher';
import type {
  DstTag, ParseError, ParseOptions, Result, Run, RunOptions, Schedule, Transition, Tz,
} from './types';

const HORIZON = 5 * 366 * 86400;
/**
 * Bounds how far the transitions search looks past both ends of [startSec, endSec]: backward, for a
 * transition whose overlap or gap still affects the start; forward, for one that still affects the end
 * (see the comment in walk() below). The forward side only needs to exceed the widest real gap/overlap,
 * so the same 2-day constant covers both directions.
 */
const LOOKBACK = 2 * 86400;
/** Window width at which prev's descent stops halving and just walks (see collectLatest). */
const LEAF = 3600;
const DEFAULT_COUNT = 10;
const MAX_COUNT = 1000;
/** The largest instant a Date holds (8.64e15 ms), in seconds. Past it, new Date() is an Invalid Date. */
const MAX_DATE_SEC = 8.64e12;

/**
 * The wall seconds a gap skipped that this schedule should be caught up on, ascending: one catch-up run
 * is emitted at the transition instant for each. gapStart/gapEnd are wall seconds, gapEnd exclusive.
 */
export type GapStrategy = (c: Compiled, gapStart: number, gapEnd: number) => number[];
export type OverlapPass = 'first' | 'second';
/** Whether a match inside an overlap is emitted on the given pass. */
export type OverlapStrategy = (c: Compiled, pass: OverlapPass) => boolean;

/**
 * cronie only walks the skipped minutes one by one for a jump of up to `3 * MINUTE_COUNT` = 3 hours
 * (`case medium`, DERIVATION H2); a wider jump resyncs and just runs the current minute, so a zone that
 * skips a whole wall day produces no catch-up at all rather than a day's worth at one instant.
 */
const MAX_CATCH_UP_GAP = 3 * 3600;

function wallMatches(c: Compiled, from: number, limit: number): number[] {
  const out: number[] = [];
  for (let w = nextWallMatch(c, from, limit); w !== null; w = nextWallMatch(c, w + c.resolution, limit)) out.push(w);
  return out;
}

/** Strategy registry for the `dstGap` axis of corpus/strategies.json. */
export const DST_GAP: Record<string, GapStrategy> = {
  skip: () => [],
  // cronie: fixed-time jobs run once per skipped matching minute, right after the jump (DERIVATION H2).
  'vixie-window': (c, gapStart, gapEnd) =>
    c.fixedTime && gapEnd - gapStart < MAX_CATCH_UP_GAP ? wallMatches(c, gapStart, gapEnd) : [],
  // GitHub Actions: "scheduled workflows in skipped hours advance to the next valid time" (DERIVATION G5).
  // One run per gap, for fixed-time schedules only, and none when a natural run already fires at that instant.
  'next-valid': (c, gapStart, gapEnd) => {
    if (!c.fixedTime) return [];
    const skipped = nextWallMatch(c, gapStart, gapEnd);
    if (skipped === null || nextWallMatch(c, gapEnd, gapEnd + 1) === gapEnd) return [];
    return [skipped];
  },
};

/** Strategy registry for the `dstOverlap` axis of corpus/strategies.json. */
export const DST_OVERLAP: Record<string, OverlapStrategy> = {
  // Quartz: java.util.Calendar resolves an ambiguous wall time to standard time (DERIVATION H6).
  'once-second': (_c, pass) => pass === 'second',
  // cronie: fixed-time jobs run on the first pass only; wildcard jobs follow real time through both.
  'vixie-window': (c, pass) => pass === 'first' || !c.fixedTime,
  // robfig/cron reads only the wall clock, so both passes match; Kubernetes really creates two Jobs (DERIVATION K13).
  repeat: () => true,
  // EventBridge Scheduler: "runs the schedule only once ... before the shift occurs" (DERIVATION A15).
  'once-first': (_c, pass) => pass === 'first',
};

interface RawRun {
  at: number;
  wall: number;
  offset: number;
  dst?: DstTag;
  /** Wall seconds this catch-up run stands in for; only set alongside dst 'skipped-adjusted'. */
  scheduled?: number;
}

/** Every run with startSec <= at <= endSec, in non-decreasing order, walking segments of constant UTC offset. */
function* walk(c: Compiled, spec: DialectSpec, tz: Tz, zone: string, startSec: number, endSec: number): Generator<RawRun> {
  const onGap = DST_GAP[spec.dstGap];
  const onOverlap = DST_OVERLAP[spec.dstOverlap];
  if (!onGap || !onOverlap) return;

  // Transitions strictly after endSec never end a segment or extend the walk (wallEnd stays clamped to
  // endSec), but the nearest one still classifies wall times in the tail segment as first-pass ambiguous:
  // that classification holds for the whole segment before the transition, not just near its own instant,
  // so a narrow [startSec, endSec] window (as matches() uses) must still be able to see it.
  const found = tz.transitions(zone, startSec - LOOKBACK, endSec + LOOKBACK);
  const borders = found.filter((t) => t.at <= endSec);
  const upcoming = found.find((t) => t.at > endSec) ?? null;
  let segStart = startSec - LOOKBACK;
  let offset = tz.offsetAt(zone, segStart);
  let before: Transition | null = null;

  for (let i = 0; i <= borders.length; i++) {
    const after: Transition | null = i < borders.length ? borders[i] : null;
    const wallEnd = (after ? after.at : endSec + 1) + offset;

    if (before && before.after > before.before && before.at >= startSec && before.at <= endSec) {
      for (const scheduled of onGap(c, before.at + before.before, before.at + before.after)) {
        yield { at: before.at, wall: before.at + offset, offset, dst: 'skipped-adjusted', scheduled };
      }
    }

    // Wall times below secondPassEnd were already covered by the previous segment.
    const secondPassEnd = before && before.after < before.before ? before.at + before.before : null;
    // Wall times from firstPassStart on will be seen again by the next segment (or, in the tail segment,
    // by the nearest transition past endSec).
    const boundary = after ?? upcoming;
    const firstPassStart = boundary && boundary.after < boundary.before ? boundary.at + boundary.after : null;

    let w = nextWallMatch(c, Math.max(segStart, startSec) + offset, wallEnd);
    while (w !== null) {
      const at = w - offset;
      let dst: DstTag | undefined;
      let emit = true;
      if (secondPassEnd !== null && w < secondPassEnd) {
        emit = onOverlap(c, 'second');
        dst = 'ambiguous-second';
      } else if (firstPassStart !== null && w >= firstPassStart) {
        emit = onOverlap(c, 'first');
        dst = 'ambiguous-first';
      }
      if (emit) yield dst ? { at, wall: w, offset, dst } : { at, wall: w, offset };
      w = nextWallMatch(c, w + c.resolution, wallEnd);
    }

    if (!after) break;
    before = after;
    segStart = after.at;
    offset = after.after;
  }
}

/**
 * A hand-built Schedule can carry field names with no `values`/`terms` (compile() copies them through
 * without checking); that only breaks once the matcher actually reads them mid-walk. Wrapping every
 * consumption of walk() in this makes such a throw look like "no more runs" instead of escaping to the
 * caller, keeping next/prev/matches' never-throw contract without weakening matcher.ts's assumption that
 * a Compiled it's given is well-formed.
 */
function* guarded<T>(gen: Generator<T>): Generator<T> {
  try {
    yield* gen;
  } catch {
    // Treat a malformed schedule discovered mid-walk as having no further runs.
  }
}

/** The first item of a generator, or null. Closes the generator, so nothing past it is computed. */
function firstOf<T>(gen: Generator<T>): T | null {
  for (const item of gen) return item;
  return null;
}

/** The last `need` items of a generator, in order, holding no more than `need` of them at a time. */
function lastFew<T>(gen: Generator<T>, need: number): T[] {
  const ring: T[] = [];
  let at = 0;
  let seen = 0;
  for (const item of gen) {
    if (ring.length < need) ring.push(item);
    else ring[at] = item;
    at = (at + 1) % need;
    seen += 1;
  }
  return seen <= need ? ring : [...ring.slice(at), ...ring.slice(0, at)];
}

/**
 * The last `need` runs in [start, end], ascending. Descends newest half first and stops as soon as the
 * halves seen so far cover `need`, so neither time nor memory grows with the width of the window: an
 * empty half costs one lazy peek, and only leaves that actually contribute are enumerated.
 *
 * Two facts make halving sound. walk() is window-independent - it looks a fixed distance either side of
 * its window for the transitions that classify a run - so a half yields exactly the runs of that half.
 * And windows are split by instant, so runs sharing an instant (a catch-up and the natural run behind it)
 * always land in the same half and are never counted apart.
 */
function collectLatest(
  runs: (start: number, end: number) => Generator<RawRun>, start: number, end: number, need: number,
): RawRun[] {
  if (start > end || need <= 0) return [];
  if (end - start + 1 <= LEAF) return lastFew(runs(start, end), need);
  if (firstOf(runs(start, end)) === null) return [];

  const mid = start + Math.floor((end - start) / 2);
  const newer = collectLatest(runs, mid + 1, end, need);
  if (newer.length >= need) return newer;
  return [...collectLatest(runs, start, mid, need - newer.length), ...newer];
}

function toRun(r: RawRun): Run {
  const run: Run = { at: new Date(r.at * 1000), local: formatLocal(r.wall, r.offset) };
  if (r.dst) run.dst = r.dst;
  if (r.scheduled !== undefined) run.scheduled = formatWall(r.scheduled);
  return run;
}

function clampCount(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count)) return DEFAULT_COUNT;
  return Math.min(MAX_COUNT, Math.max(1, Math.floor(count)));
}

const toMs = (d: unknown): number => (d instanceof Date ? d.getTime() : Number.NaN);

export function createEngine(
  tz: Tz,
  parse: (input: string, opts?: ParseOptions) => Result<Schedule, ParseError>,
) {
  function prepare(s: Schedule | string) {
    try {
      let schedule: Schedule | null = null;
      if (typeof s === 'string') {
        const parsed = parse(s);
        if (parsed.ok) schedule = parsed.value;
      } else {
        schedule = s;
      }
      if (!schedule || !Array.isArray(schedule.fields) || !tz.isValid(schedule.timezone)) return null;
      const spec = getDialect(schedule.dialect);
      const c = spec ? compile(schedule, spec) : null;
      return spec && c ? { c, spec, zone: schedule.timezone } : null;
    } catch {
      return null;
    }
  }

  function next(s: Schedule | string, opts?: RunOptions | null): Run[] {
    const o = opts ?? {};
    const p = prepare(s);
    const fromMs = toMs(o.from ?? new Date());
    if (!p || Number.isNaN(fromMs)) return [];

    const sec = Math.floor(fromMs / 1000);
    const start = o.inclusive && fromMs % 1000 === 0 ? sec : sec + 1;
    let end = start + HORIZON;
    if (o.until !== undefined) {
      const untilMs = toMs(o.until);
      if (Number.isNaN(untilMs)) return [];
      end = Math.min(end, Math.floor(untilMs / 1000));
    }
    // Stop the walk where Date stops: a run past this would carry an Invalid Date.
    end = Math.min(end, MAX_DATE_SEC);

    const count = clampCount(o.count);
    const out: Run[] = [];
    for (const r of guarded(walk(p.c, p.spec, tz, p.zone, start, end))) {
      out.push(toRun(r));
      if (out.length >= count) break;
    }
    return out;
  }

  function prev(s: Schedule | string, opts?: RunOptions | null): Run[] {
    const o = opts ?? {};
    const p = prepare(s);
    const fromMs = toMs(o.from ?? new Date());
    if (!p || Number.isNaN(fromMs)) return [];

    const sec = Math.floor(fromMs / 1000);
    let end = fromMs % 1000 === 0 && !o.inclusive ? sec - 1 : sec;
    let floor = end - HORIZON;
    if (o.until !== undefined) {
      const untilMs = toMs(o.until);
      if (Number.isNaN(untilMs)) return [];
      floor = Math.max(floor, Math.ceil(untilMs / 1000));
    }
    // Stop the walk where Date stops: a run outside this would carry an Invalid Date.
    end = Math.min(end, MAX_DATE_SEC);
    floor = Math.max(floor, -MAX_DATE_SEC);

    // The same forward walk, over halves of [floor, end], so prev agrees with next by construction.
    const runs = (a: number, b: number) => guarded(walk(p.c, p.spec, tz, p.zone, a, b));
    return collectLatest(runs, floor, end, clampCount(o.count)).reverse().map(toRun);
  }

  function matches(s: Schedule | string, at: Date): boolean {
    const p = prepare(s);
    const ms = toMs(at);
    if (!p || Number.isNaN(ms) || ms % 1000 !== 0) return false;
    const sec = ms / 1000;
    for (const r of guarded(walk(p.c, p.spec, tz, p.zone, sec, sec))) return r.at === sec;
    return false;
  }

  return { next, prev, matches };
}
