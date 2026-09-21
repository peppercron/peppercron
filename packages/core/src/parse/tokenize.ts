import type { Span } from '../types';

export interface Token {
  text: string;
  span: Span;
  /** True for fields produced by a macro expansion: every term reports the macro's span. */
  fixedSpan?: boolean;
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input)) !== null) {
    tokens.push({ text: m[0], span: [m.index, m.index + m[0].length] });
  }
  return tokens;
}
