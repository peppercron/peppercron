export type Dialect = 'vixie' | 'quartz';

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

export interface Schedule {
  dialect: Dialect;
  source: string;
  timezone: string;
  /** Dialect field order. Empty only for a macro with no schedule (@reboot). */
  fields: Field[];
  macro?: string;
  trailing?: { text: string; span: Span };
  candidates?: Dialect[];
}

export type ParseErrorCode =
  | 'empty' | 'field-count' | 'bad-token' | 'out-of-range' | 'bad-step'
  | 'bad-range' | 'unknown-macro' | 'unknown-dialect' | 'bad-timezone';

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
  from?: Date;
  count?: number;
  until?: Date;
  inclusive?: boolean;
}

export type DstTag = 'skipped-adjusted' | 'ambiguous-first' | 'ambiguous-second';

export interface Run {
  at: Date;
  /** ISO wall time in the schedule timezone, with offset. */
  local: string;
  dst?: DstTag;
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
