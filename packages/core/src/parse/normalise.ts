import type { FieldSpec } from '../dialects';
import type { Term } from '../types';

/** Day-of-week becomes Sunday = 0 .. Saturday = 6 in every dialect; other fields are untouched. */
export function canonicalValue(n: number, f: FieldSpec): number {
  if (f.name !== 'dayOfWeek') return n;
  return (((n - (f.sundayIs ?? 0)) % 7) + 7) % 7;
}

export function normaliseTerm(t: Term, f: FieldSpec): Term {
  if (f.name !== 'dayOfWeek') return t;
  if (t.kind === 'range') return { ...t, from: canonicalValue(t.from, f), to: canonicalValue(t.to, f) };
  if (t.kind === 'lastDow' || t.kind === 'nthDow') return { ...t, dow: canonicalValue(t.dow, f) };
  return t;
}

export function sortedUnique(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}
