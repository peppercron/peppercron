import type { DialectSpec, FieldSpec } from '../dialects';
import type { TermBody } from '../types';

function stepped(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n += step) out.push(n);
  return out;
}

/** Static values of a term, in the dialect's own numbering. null = wrapped range in a dialect that forbids it. */
export function expandTerm(t: TermBody, f: FieldSpec, d: DialectSpec): number[] | null {
  if (t.kind === 'any') return stepped(f.min, f.max, t.step);
  if (t.kind !== 'range') return [];
  if (t.from <= t.to) return stepped(t.from, t.to, t.step);
  if (d.rangeWrap === 'error') return null;
  if (d.rangeWrap === 'empty') return [];
  const size = f.max - f.min + 1;
  return stepped(t.from, t.to + size, t.step).map((n) => f.min + ((n - f.min) % size));
}
