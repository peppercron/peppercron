import { describe, expect, it } from 'vitest';
import { getDialect } from '../src/dialects';
import { parseField, STAR } from '../src/parse/field';

const star = (text: string, dialect: string, index = 2) => {
  const d = getDialect(dialect)!;
  const r = parseField({ text, span: [0, text.length] }, d.fields[index], d);
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`);
  return r.value.star;
};

describe('star strategies', () => {
  it('registers exactly the two ids', () => {
    expect(Object.keys(STAR).sort()).toEqual(['leading', 'unstepped-term']);
  });

  it('leading (cronie): the field text begins with *', () => {
    expect(star('*', 'vixie')).toBe(true);
    expect(star('*/2', 'vixie')).toBe(true);
    expect(star('5,*', 'vixie')).toBe(false);
  });

  it('unstepped-term (robfig): any term is * or ? with no step above 1 (DERIVATION K10)', () => {
    expect(star('*', 'kubernetes')).toBe(true);
    expect(star('?', 'kubernetes')).toBe(true);
    expect(star('*/1', 'kubernetes')).toBe(true);
    expect(star('*/2', 'kubernetes')).toBe(false);
    expect(star('5,*', 'kubernetes')).toBe(true);
    expect(star('5', 'kubernetes')).toBe(false);
  });
});
