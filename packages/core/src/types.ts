export type Dialect = 'vixie' | 'kubernetes' | 'github-actions' | 'quartz' | 'aws';

/** Character offsets [start, end) into Schedule.source. */
export type Span = [number, number];

export type FieldName =
  | 'second' | 'minute' | 'hour' | 'dayOfMonth' | 'month' | 'dayOfWeek' | 'year';

export type TermBody =
  | { kind: 'any'; step: number }                              // *  */n
  | { kind: 'unspecified' }                                    // ?
  | { kind: 'range'; from: number; to: number; step: number }  // 5  1-5  1-5/2  5/15
  | { kind: 'last'; offset: number }                           // L  L-3
  | { kind: 'lastWeekday' }                                    // LW
  | { kind: 'nearestWeekday'; day: number }                    // 15W
  | { kind: 'lastDow'; dow: number }                           // 6L
  | { kind: 'nthDow'; dow: number; n: number };                // 6#3

export type Term = { raw: string; span: Span; unsupported?: true } & TermBody;

export interface Field {
  name: FieldName;
  raw: string;
  span: Span;
  terms: Term[];
  /** Union of 'any' and 'range' terms; canonical numbering, sorted, deduped. */
  values: number[];
  /** True when the field text begins with '*'. */
  star: boolean;
}

/** A schedule that fires every `seconds` of absolute time from an anchor; time zones and DST do not move it. */
export interface Interval {
  seconds: number;
  /** The interval expression as written, e.g. `@every 1h30m` or `rate(5 minutes)`. */
  raw: string;
  span: Span;
}

export interface Schedule {
  dialect: Dialect;
  source: string;
  timezone: string;
  /** Dialect field order. Empty for a macro with no schedule (@reboot) and for an interval schedule. */
  fields: Field[];
  macro?: string;
  trailing?: { text: string; span: Span };
  candidates?: Dialect[];
  /** Present for an interval schedule (@every, rate); run times then depend on RunOptions.anchor. */
  interval?: Interval;
}

export type ParseErrorCode =
  | 'empty' | 'field-count' | 'bad-token' | 'out-of-range' | 'bad-step'
  | 'bad-range' | 'unknown-macro' | 'unknown-dialect' | 'bad-timezone' | 'bad-wrapper' | 'bad-interval';

export interface ParseError {
  code: ParseErrorCode;
  message: string;
  span: Span;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ParseOptions {
  dialect?: Dialect;
  timezone?: string;
}

export interface RunOptions {
  /**
   * Where to start, exclusive unless `inclusive`. Defaults to now.
   *
   * Paging caveat: runs are non-decreasing, not strictly increasing. After a run tagged
   * `skipped-adjusted`, other runs can share its instant, so paging with `from: lastRun.at` must ask
   * for a full page rather than `count: 1` and de-duplicate on `at` plus `scheduled`; asking for one
   * run at a time silently drops the rest of that instant's group.
   */
  from?: Date;
  count?: number;
  until?: Date;
  inclusive?: boolean;
  /**
   * When an interval schedule (`@every`, `rate(...)`) was created or started; its runs are
   * `anchor + k * interval`. Floored to a whole second. Defaults to `from`, which answers "if this were
   * created now, when would it fire". Calendar schedules ignore it.
   */
  anchor?: Date;
}

export interface MatchOptions {
  /** Required for an interval schedule: without it `matches` is false, because no run is known. */
  anchor?: Date;
}

export type DstTag = 'skipped-adjusted' | 'ambiguous-first' | 'ambiguous-second';

export interface Run {
  at: Date;
  /** ISO wall time in the schedule timezone, with offset. */
  local: string;
  dst?: DstTag;
  /**
   * Only on a `skipped-adjusted` run: the wall time this run is catching up, as ISO local time with
   * no offset (`2026-03-08T02:30:00`), because a wall time a gap skipped has no offset in the zone.
   * Several catch-up runs can share one instant and one `local`; this is what tells them apart.
   */
  scheduled?: string;
}

/** A UTC-offset change. `at` is the first epoch second that has the new offset. Offsets are seconds east of UTC. */
export interface Transition {
  at: number;
  before: number;
  after: number;
}

export interface Tz {
  isValid(zone: string): boolean;
  offsetAt(zone: string, sec: number): number;
  /** Transitions with fromSec < at <= toSec, ascending. */
  transitions(zone: string, fromSec: number, toSec: number): Transition[];
}
