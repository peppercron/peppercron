import type { DialectSpec, FieldSpec } from '../dialects';
import type { TermBody } from '../types';

function stepped(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += step) out.push(n);
  return out;
}

/**
 * cronie rewrites a reversed range whose end is Sunday to end at Sunday's second number instead, so
 * `5-0` (Fri-Sun) covers Fri, Sat, Sun (DERIVATION H3, entry.c:641-643). Only day-of-week fields that
 * name Sunday twice can express it: vixie (Sunday 0, max 7) can, quartz (Sunday 1, max 7) cannot and
 * keeps its ordinary wrap. The same rewrite outside day-of-week is parked.
 */
function sundayEnd(t: { from: number; to: number }, f: FieldSpec): number | null {
  if (f.name !== 'dayOfWeek') return null;
  const sunday = f.sundayIs ?? 0;
  return t.to === sunday && f.max >= sunday + 7 ? sunday + 7 : null;
}

/** Static values of a term, in the dialect's own numbering. null = wrapped range in a dialect that forbids it. */
export function expandTerm(t: TermBody, f: FieldSpec, d: DialectSpec): number[] | null {
  if (t.kind === 'any') return stepped(f.min, f.max, t.step);
  if (t.kind !== 'range') return [];
  if (t.from <= t.to) return stepped(t.from, t.to, t.step);
  const extended = sundayEnd(t, f);
  if (extended !== null) return stepped(t.from, extended, t.step);
  if (d.rangeWrap === 'error') return null;
  if (d.rangeWrap === 'empty') return [];
  const size = f.max - f.min + 1;
  return stepped(t.from, t.to + size, t.step).map((n) => f.min + ((n - f.min) % size));
}
