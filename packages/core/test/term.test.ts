import { describe, expect, it } from 'vitest';
import { getDialect, type DialectSpec } from '../src/dialects';
import { parseTerm } from '../src/parse/term';
import type { FieldName } from '../src/types';

const v = getDialect('vixie')!;
const q = getDialect('quartz')!;
const field = (d: DialectSpec, name: FieldName) => d.fields.find((f) => f.name === name)!;

function term(piece: string, d: DialectSpec, name: FieldName) {
  const r = parseTerm(piece, [0, piece.length], field(d, name), d);
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`);
  return r.value;
}
function body(piece: string, d: DialectSpec, name: FieldName) {
  const { raw: _raw, span: _span, unsupported: _u, ...rest } = term(piece, d, name);
  return rest;
}
function code(piece: string, d: DialectSpec, name: FieldName) {
  const r = parseTerm(piece, [0, piece.length], field(d, name), d);
  return r.ok ? 'ok' : r.error.code;
}

describe('parseTerm: plain terms', () => {
  it('reads wildcards, values, ranges and steps', () => {
    expect(body('*', v, 'minute')).toEqual({ kind: 'any', step: 1 });
    expect(body('*/15', v, 'minute')).toEqual({ kind: 'any', step: 15 });
    expect(body('5', v, 'minute')).toEqual({ kind: 'range', from: 5, to: 5, step: 1 });
    expect(body('1-5/2', v, 'hour')).toEqual({ kind: 'range', from: 1, to: 5, step: 2 });
  });

  it('applies the dialect singleStep rule to "5/15"', () => {
    expect(body('5/15', q, 'minute')).toEqual({ kind: 'range', from: 5, to: 59, step: 15 });
    expect(code('5/15', v, 'minute')).toBe('bad-step');
  });

  it('resolves names in the dialect numbering', () => {
    expect(body('JAN-MAR', v, 'month')).toEqual({ kind: 'range', from: 1, to: 3, step: 1 });
    expect(body('SUN', v, 'dayOfWeek')).toEqual({ kind: 'range', from: 0, to: 0, step: 1 });
    expect(body('SUN', q, 'dayOfWeek')).toEqual({ kind: 'range', from: 1, to: 1, step: 1 });
    expect(body('MON-FRI', q, 'dayOfWeek')).toEqual({ kind: 'range', from: 2, to: 6, step: 1 });
  });

  it('accepts 7 as a Vixie day of week but not 8, and rejects 0 in Quartz', () => {
    expect(code('7', v, 'dayOfWeek')).toBe('ok');
    expect(code('8', v, 'dayOfWeek')).toBe('out-of-range');
    expect(code('0', q, 'dayOfWeek')).toBe('out-of-range');
  });
});

describe('parseTerm: special tokens', () => {
  it('reads day-of-month specials', () => {
    expect(body('?', q, 'dayOfMonth')).toEqual({ kind: 'unspecified' });
    expect(body('L', q, 'dayOfMonth')).toEqual({ kind: 'last', offset: 0 });
    expect(body('L-3', q, 'dayOfMonth')).toEqual({ kind: 'last', offset: 3 });
    expect(body('LW', q, 'dayOfMonth')).toEqual({ kind: 'lastWeekday' });
    expect(body('15W', q, 'dayOfMonth')).toEqual({ kind: 'nearestWeekday', day: 15 });
  });

  it('reads day-of-week specials', () => {
    expect(body('6#3', q, 'dayOfWeek')).toEqual({ kind: 'nthDow', dow: 6, n: 3 });
    expect(body('FRI#3', q, 'dayOfWeek')).toEqual({ kind: 'nthDow', dow: 6, n: 3 });
    expect(body('6L', q, 'dayOfWeek')).toEqual({ kind: 'lastDow', dow: 6 });
    expect(body('L', q, 'dayOfWeek')).toEqual({ kind: 'range', from: 7, to: 7, step: 1 });
  });

  it('is case-insensitive and keeps the original spelling in raw (Review Focus 2)', () => {
    expect(body('mon-fri', q, 'dayOfWeek')).toEqual(body('MON-FRI', q, 'dayOfWeek'));
    expect(body('Jan', v, 'month')).toEqual({ kind: 'range', from: 1, to: 1, step: 1 });
    expect(body('l', q, 'dayOfMonth')).toEqual({ kind: 'last', offset: 0 });
    expect(body('15w', q, 'dayOfMonth')).toEqual({ kind: 'nearestWeekday', day: 15 });
    expect(term('mon-fri', q, 'dayOfWeek').raw).toBe('mon-fri');
  });

  it('flags tokens the dialect does not allow instead of failing', () => {
    expect(term('L', v, 'dayOfMonth').unsupported).toBe(true);
    expect(term('?', v, 'dayOfMonth').unsupported).toBe(true);
    expect(term('L', q, 'dayOfMonth').unsupported).toBeUndefined();
    expect(term('5', v, 'dayOfMonth').unsupported).toBeUndefined();
  });
});

describe('parseTerm: errors', () => {
  it('reports the right code', () => {
    expect(code('?', q, 'minute')).toBe('bad-token');
    expect(code('L', q, 'minute')).toBe('bad-token');
    expect(code('FOO', v, 'month')).toBe('bad-token');
    expect(code('', v, 'minute')).toBe('bad-token');
    expect(code('1-', v, 'minute')).toBe('bad-token');
    expect(code('1/2/3', v, 'minute')).toBe('bad-token');
    expect(code('61', v, 'minute')).toBe('out-of-range');
    expect(code('6#6', q, 'dayOfWeek')).toBe('out-of-range');
    expect(code('L-31', q, 'dayOfMonth')).toBe('out-of-range');
    expect(code('32W', q, 'dayOfMonth')).toBe('out-of-range');
    expect(code('*/0', v, 'minute')).toBe('bad-step');
    expect(code('*/x', v, 'minute')).toBe('bad-step');
  });

  it('carries the span it was given', () => {
    const r = parseTerm('61', [4, 6], field(v, 'minute'), v);
    expect(r.ok ? null : r.error.span).toEqual([4, 6]);
  });
});

describe('the ?* token (robfig/cron, DERIVATION K3)', () => {
  const k8s = getDialect('kubernetes')!;
  const term = (piece: string, index: number) => parseTerm(piece, [0, piece.length], k8s.fields[index], k8s);

  it('reads ? as * in every kubernetes field, with no unsupported mark', () => {
    for (let i = 0; i < 5; i++) {
      expect(term('?', i)).toEqual({ ok: true, value: { raw: '?', span: [0, 1], kind: 'any', step: 1 } });
    }
  });

  it('allows a step after ?', () => {
    expect(term('?/15', 0)).toEqual({ ok: true, value: { raw: '?/15', span: [0, 4], kind: 'any', step: 15 } });
  });

  it('still rejects ? outside the day fields in a dialect without the token', () => {
    const vixieDialect = getDialect('vixie')!;
    const r = parseTerm('?', [0, 1], vixieDialect.fields[0], vixieDialect);
    expect(r.ok).toBe(false);
  });
});
