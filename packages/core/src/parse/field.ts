import type { DialectSpec, FieldSpec } from '../dialects';
import { fail, ok } from '../result';
import type { Field, ParseError, Result, Span, Term } from '../types';
import { expandTerm } from './expand';
import { canonicalValue, normaliseTerm, sortedUnique } from './normalise';
import { parseTerm } from './term';
import type { Token } from './tokenize';

export function parseField(token: Token, f: FieldSpec, d: DialectSpec): Result<Field, ParseError> {
  const terms: Term[] = [];
  const values: number[] = [];
  let cursor = token.span[0];

  for (const piece of token.text.split(',')) {
    const span: Span = token.fixedSpan ? token.span : [cursor, cursor + piece.length];
    cursor += piece.length + 1;

    const term = parseTerm(piece, span, f, d);
    if (!term.ok) return term;

    const expanded = expandTerm(term.value, f, d);
    if (expanded === null) {
      return fail('bad-range', `Range "${piece}" starts after it ends, which ${d.id} does not allow`, span);
    }
    terms.push(normaliseTerm(term.value, f));
    for (const n of expanded) values.push(canonicalValue(n, f));
  }

  return ok({
    name: f.name,
    raw: token.text,
    span: token.span,
    terms,
    values: sortedUnique(values),
    star: terms[0].kind === 'any',
  });
}
