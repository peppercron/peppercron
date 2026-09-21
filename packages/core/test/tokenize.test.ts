import { describe, expect, it } from 'vitest';
import { tokenize } from '../src/parse/tokenize';

describe('tokenize', () => {
  it('splits on whitespace runs and records spans into the original string', () => {
    expect(tokenize('\t0 2\t*  *')).toEqual([
      { text: '0', span: [1, 2] },
      { text: '2', span: [3, 4] },
      { text: '*', span: [5, 6] },
      { text: '*', span: [8, 9] },
    ]);
  });

  it('returns no tokens for empty or blank input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   \t ')).toEqual([]);
  });
});
