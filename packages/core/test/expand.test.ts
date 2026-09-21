import { describe, expect, it } from 'vitest';
import { getDialect } from '../src/dialects';
import { expandTerm } from '../src/parse/expand';
import { canonicalValue, normaliseTerm, sortedUnique } from '../src/parse/normalise';

const v = getDialect('vixie')!;
const q = getDialect('quartz')!;
const vDow = v.fields[4];
const qDow = q.fields[5];
const qHour = q.fields[2];
const vHour = v.fields[1];

describe('expandTerm', () => {
  it('expands wildcards and ranges with steps', () => {
    expect(expandTerm({ kind: 'any', step: 15 }, v.fields[0], v)).toEqual([0, 15, 30, 45]);
    expect(expandTerm({ kind: 'range', from: 1, to: 5, step: 2 }, vHour, v)).toEqual([1, 3, 5]);
    expect(expandTerm({ kind: 'any', step: 1 }, vDow, v)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('special terms contribute no static values', () => {
    expect(expandTerm({ kind: 'last', offset: 0 }, q.fields[3], q)).toEqual([]);
    expect(expandTerm({ kind: 'unspecified' }, q.fields[3], q)).toEqual([]);
  });

  it('follows the dialect rangeWrap rule when start is after end', () => {
    expect(expandTerm({ kind: 'range', from: 22, to: 2, step: 1 }, qHour, q)).toEqual([22, 23, 0, 1, 2]);
    expect(expandTerm({ kind: 'range', from: 22, to: 2, step: 2 }, qHour, q)).toEqual([22, 0, 2]);
    expect(expandTerm({ kind: 'range', from: 22, to: 2, step: 1 }, vHour, v)).toEqual([]);
    expect(expandTerm({ kind: 'range', from: 22, to: 2, step: 1 }, vHour, { ...v, rangeWrap: 'error' })).toBeNull();
  });
});

describe('normalise', () => {
  it('maps day-of-week numbers to Sunday = 0 and leaves other fields alone', () => {
    expect([0, 6, 7].map((n) => canonicalValue(n, vDow))).toEqual([0, 6, 0]);
    expect([1, 2, 7].map((n) => canonicalValue(n, qDow))).toEqual([0, 1, 6]);
    expect(canonicalValue(7, vHour)).toBe(7);
  });

  it('maps the day-of-week numbers inside terms', () => {
    const base = { raw: 'x', span: [0, 1] as [number, number] };
    expect(normaliseTerm({ ...base, kind: 'nthDow', dow: 6, n: 3 }, qDow)).toMatchObject({ dow: 5, n: 3 });
    expect(normaliseTerm({ ...base, kind: 'lastDow', dow: 6 }, qDow)).toMatchObject({ dow: 5 });
    expect(normaliseTerm({ ...base, kind: 'range', from: 5, to: 7, step: 1 }, vDow)).toMatchObject({ from: 5, to: 0 });
  });

  it('sortedUnique sorts numerically and removes duplicates', () => {
    expect(sortedUnique([10, 2, 2, 0, 10])).toEqual([0, 2, 10]);
  });
});
