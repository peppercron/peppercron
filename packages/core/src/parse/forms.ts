import type { DialectSpec } from '../dialects';
import { fail, ok } from '../result';
import type { ParseError, Result, Span } from '../types';

/** [start, end) of the input without its surrounding whitespace. */
export function region(source: string): Span {
  const start = source.length - source.trimStart().length;
  return [start, Math.max(start, source.trimEnd().length)];
}

/** True when the input is written in a form only some dialects have, so detection asks only them. */
export function claims(spec: DialectSpec, source: string): boolean {
  return spec.wrapper !== null && source.trimStart().startsWith(`${spec.wrapper}(`);
}

/**
 * The text to tokenize. For `cron(...)` it is the source with the wrapper blanked out rather than cut
 * off, so every span the tokenizer reports still indexes the untouched input.
 */
export function unwrap(spec: DialectSpec, source: string): Result<string, ParseError> {
  if (spec.wrapper === null || !claims(spec, source)) return ok(source);
  const [start, end] = region(source);
  const open = start + spec.wrapper.length + 1;
  const inner = source.slice(open, end - 1);
  if (end - 1 < open || source[end - 1] !== ')' || /[()]/.test(inner)) {
    return fail('bad-wrapper', `"${spec.wrapper}(" must be closed by one final ")"`, [start, end]);
  }
  return ok(' '.repeat(open) + inner + ' '.repeat(source.length - end + 1));
}
