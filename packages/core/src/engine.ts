import { formatLocal } from './calendar';
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
const DEFAULT_COUNT = 10;
const MAX_COUNT = 1000;

/** How many catch-up runs to emit at the transition instant. gapStart/gapEnd are wall seconds. */
export type GapStrategy = (c: Compiled, gapStart: number, gapEnd: number) => number;
export type OverlapPass = 'first' | 'second';
/** Whether a match inside an overlap is emitted on the given pass. */
export type OverlapStrategy = (c: Compiled, pass: OverlapPass) => boolean;

function countWallMatches(c: Compiled, from: number, limit: number): number {
  let n = 0;
  for (let w = nextWallMatch(c, from, limit); w !== null; w = nextWallMatch(c, w + c.resolution, limit)) n += 1;
  return n;
}

/** Strategy registry for the `dstGap` axis of corpus/strategies.json. */
export const DST_GAP: Record<string, GapStrategy> = {
  skip: () => 0,
  // cronie: fixed-time jobs run once per skipped matching minute, right after the jump (DERIVATION H2).
  'vixie-window': (c, gapStart, gapEnd) => (c.fixedTime ? countWallMatches(c, gapStart, gapEnd) : 0),
};

/** Strategy registry for the `dstOverlap` axis of corpus/strategies.json. */
export const DST_OVERLAP: Record<string, OverlapStrategy> = {
  once: (_c, pass) => pass === 'first',
  // Quartz: java.util.Calendar resolves an ambiguous wall time to standard time (DERIVATION H6).
  'once-second': (_c, pass) => pass === 'second',
  // cronie: fixed-time jobs run on the first pass only; wildcard jobs follow real time through both.
  'vixie-window': (c, pass) => pass === 'first' || !c.fixedTime,
};

interface RawRun {
  at: number;
  wall: number;
  offset: number;
  dst?: DstTag;
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
      const catchUps = onGap(c, before.at + before.before, before.at + before.after);
      for (let n = 0; n < catchUps; n++) {
        yield { at: before.at, wall: before.at + offset, offset, dst: 'skipped-adjusted' };
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

function toRun(r: RawRun): Run {
  const run: Run = { at: new Date(r.at * 1000), local: formatLocal(r.wall, r.offset) };
  if (r.dst) run.dst = r.dst;
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

  function next(s: Schedule | string, opts: RunOptions = {}): Run[] {
    const p = prepare(s);
    const fromMs = toMs(opts.from ?? new Date());
    if (!p || Number.isNaN(fromMs)) return [];

    const sec = Math.floor(fromMs / 1000);
    const start = opts.inclusive && fromMs % 1000 === 0 ? sec : sec + 1;
    let end = start + HORIZON;
    if (opts.until !== undefined) {
      const untilMs = toMs(opts.until);
      if (Number.isNaN(untilMs)) return [];
      end = Math.min(end, Math.floor(untilMs / 1000));
    }

    const count = clampCount(opts.count);
    const out: Run[] = [];
    for (const r of guarded(walk(p.c, p.spec, tz, p.zone, start, end))) {
      out.push(toRun(r));
      if (out.length >= count) break;
    }
    return out;
  }

  function prev(s: Schedule | string, opts: RunOptions = {}): Run[] {
    const p = prepare(s);
    const fromMs = toMs(opts.from ?? new Date());
    if (!p || Number.isNaN(fromMs)) return [];

    const sec = Math.floor(fromMs / 1000);
    const end = fromMs % 1000 === 0 && !opts.inclusive ? sec - 1 : sec;
    let floor = end - HORIZON;
    if (opts.until !== undefined) {
      const untilMs = toMs(opts.until);
      if (Number.isNaN(untilMs)) return [];
      floor = Math.max(floor, Math.ceil(untilMs / 1000));
    }

    // The same forward walk over windows that grow backwards, so prev agrees with next by construction.
    const count = clampCount(opts.count);
    for (let span = 3600; ; span *= 4) {
      const start = Math.max(floor, end - span + 1);
      const runs = [...guarded(walk(p.c, p.spec, tz, p.zone, start, end))];
      if (runs.length >= count || start === floor) return runs.slice(-count).reverse().map(toRun);
    }
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
