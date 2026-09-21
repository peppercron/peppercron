import { describe, expect, it } from 'vitest';
import { fail, ok } from '../src/result';
import type { ParseError, Result } from '../src/types';

describe('result helpers', () => {
  it('ok wraps a value', () => {
    const r: Result<number, ParseError> = ok(42);
    expect(r).toEqual({ ok: true, value: 42 });
  });

  it('fail builds a ParseError', () => {
    const r: Result<number, ParseError> = fail('bad-token', 'nope', [3, 5]);
    expect(r).toEqual({ ok: false, error: { code: 'bad-token', message: 'nope', span: [3, 5] } });
  });
});
