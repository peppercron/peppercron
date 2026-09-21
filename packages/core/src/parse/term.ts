import type { DialectSpec, FieldSpec } from '../dialects';
import { fail, ok } from '../result';
import type { ParseError, Result, Span, Term, TermBody } from '../types';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

type Parsed = { body: TermBody; token: string | null };

const done = (body: TermBody, token: string | null): Result<Parsed, ParseError> => ok({ body, token });

/** A number or name, returned in the dialect's own numbering. */
function readValue(text: string, f: FieldSpec, span: Span): Result<number, ParseError> {
  if (/^\d+$/.test(text)) {
    const n = Number(text);
    return n >= f.min && n <= f.max
      ? ok(n)
      : fail('out-of-range', `${n} is outside ${f.min}-${f.max} for ${f.name}`, span);
  }
  if (f.names === 'month' && MONTHS.includes(text)) return ok(MONTHS.indexOf(text) + 1);
  if (f.names === 'dow' && DAYS.includes(text)) return ok(DAYS.indexOf(text) + (f.sundayIs ?? 0));
  return fail('bad-token', `Cannot read "${text}" in ${f.name}`, span);
}

function readBody(up: string, span: Span, f: FieldSpec, d: DialectSpec): Result<Parsed, ParseError> {
  const isDom = f.name === 'dayOfMonth';
  const isDow = f.name === 'dayOfWeek';
  let m: RegExpExecArray | null;

  if (up === '?') {
    return isDom || isDow
      ? done({ kind: 'unspecified' }, '?')
      : fail('bad-token', '"?" is only valid in the day fields', span);
  }

  if (isDom) {
    if (up === 'L') return done({ kind: 'last', offset: 0 }, 'L');
    if (up === 'LW') return done({ kind: 'lastWeekday' }, 'LW');
    if ((m = /^L-(\d+)$/.exec(up))) {
      const offset = Number(m[1]);
      return offset >= 1 && offset <= 30
        ? done({ kind: 'last', offset }, 'L-n')
        : fail('out-of-range', `L-${offset} is outside L-1 to L-30`, span);
    }
    if ((m = /^(\d+)W$/.exec(up))) {
      const day = readValue(m[1], f, span);
      return day.ok ? done({ kind: 'nearestWeekday', day: day.value }, 'W') : day;
    }
  }

  if (isDow) {
    if (up === 'L') {
      const saturday = (f.sundayIs ?? 0) + 6;
      return done({ kind: 'range', from: saturday, to: saturday, step: 1 }, 'nL');
    }
    if ((m = /^(.+)L$/.exec(up))) {
      const dow = readValue(m[1], f, span);
      return dow.ok ? done({ kind: 'lastDow', dow: dow.value }, 'nL') : dow;
    }
    if ((m = /^(.+)#(\d+)$/.exec(up))) {
      const dow = readValue(m[1], f, span);
      if (!dow.ok) return dow;
      const n = Number(m[2]);
      return n >= 1 && n <= 5
        ? done({ kind: 'nthDow', dow: dow.value, n }, '#')
        : fail('out-of-range', `#${n} is outside #1 to #5`, span);
    }
  }

  const parts = up.split('/');
  if (parts.length > 2) return fail('bad-token', `Cannot read "${up}" in ${f.name}`, span);
  let step = 1;
  if (parts.length === 2) {
    if (!/^\d+$/.test(parts[1]) || Number(parts[1]) < 1) {
      return fail('bad-step', `Step "${parts[1]}" must be a whole number of 1 or more`, span);
    }
    step = Number(parts[1]);
  }

  const head = parts[0];
  if (head === '*') return done({ kind: 'any', step }, null);

  const bounds = head.split('-');
  if (bounds.length > 2 || bounds.some((b) => b === '')) {
    return fail('bad-token', `Cannot read "${up}" in ${f.name}`, span);
  }
  const from = readValue(bounds[0], f, span);
  if (!from.ok) return from;
  let to = from.value;
  if (bounds.length === 2) {
    const end = readValue(bounds[1], f, span);
    if (!end.ok) return end;
    to = end.value;
  } else if (parts.length === 2) {
    if (d.singleStep === 'error') {
      return fail('bad-step', `${d.id} does not allow a step after a single value; write ${bounds[0]}-${f.max}/${step}`, span);
    }
    to = f.max;
  }
  return done({ kind: 'range', from: from.value, to, step }, null);
}

export function parseTerm(piece: string, span: Span, f: FieldSpec, d: DialectSpec): Result<Term, ParseError> {
  const parsed = readBody(piece.toUpperCase(), span, f, d);
  if (!parsed.ok) return parsed;
  const term = { raw: piece, span, ...parsed.value.body } as Term;
  if (parsed.value.token !== null && !(f.tokens ?? []).includes(parsed.value.token)) {
    term.unsupported = true;
  }
  return ok(term);
}
