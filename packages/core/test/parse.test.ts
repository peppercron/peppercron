import { describe, expect, it } from 'vitest';
import { createParser } from '../src/parse/parse';
import { testTz } from './helpers/fake-tz';

const parse = createParser(testTz);
const value = (input: string, opts = {}) => {
  const r = parse(input, opts);
  if (!r.ok) throw new Error(`unexpected ${r.error.code}`);
  return r.value;
};

describe('parse: detection', () => {
  it('detects five fields as vixie and six or seven as quartz', () => {
    expect(value('0 2 * * 1').dialect).toBe('vixie');
    expect(value('0 0 12 ? * MON').dialect).toBe('quartz');
    expect(value('0 0 12 ? * MON 2027').dialect).toBe('quartz');
  });

  it('prefers a dialect that needs no trailing text, and reports no candidates when only one fits', () => {
    const s = value('* * * * * *');
    expect(s.dialect).toBe('quartz');
    expect(s.trailing).toBeUndefined();
    expect(s.candidates).toBeUndefined();
  });

  it('falls back to the first dialect that parses when every fit has unsupported tokens', () => {
    const s = value('0 0 L * *');
    expect(s.dialect).toBe('vixie');
    expect(s.fields[2].terms[0].unsupported).toBe(true);
  });

  it('honours an explicit dialect', () => {
    const r = parse('0 2 * * 1', { dialect: 'quartz' });
    expect(r.ok ? null : r.error.code).toBe('field-count');
  });
});

describe('parse: a pasted crontab line (Review Focus 1)', () => {
  it('keeps spans relative to the untrimmed source and captures the command tail', () => {
    const source = '\t0 2\t* * *  /usr/bin/backup --full\n';
    const s = value(source);
    expect(s.dialect).toBe('vixie');
    expect(s.source).toBe(source);
    expect(s.fields.map((f) => f.span)).toEqual([[1, 2], [3, 4], [5, 6], [7, 8], [9, 10]]);
    expect(s.trailing).toEqual({ text: '/usr/bin/backup --full', span: [12, 34] });
    expect(source.slice(12, 34)).toBe('/usr/bin/backup --full');
  });
});

describe('parse: fields', () => {
  it('gives each term in a list its own span', () => {
    const s = value('0,30 9-17 * * 1-5');
    expect(s.fields[0].terms.map((t) => t.span)).toEqual([[0, 1], [2, 4]]);
    expect(s.fields[0].values).toEqual([0, 30]);
    expect(s.fields[1].values).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('merges and dedupes list values and sets star only for a leading *', () => {
    expect(value('5,1,5,1-3 * * * *').fields[0].values).toEqual([1, 2, 3, 5]);
    expect(value('*/10 * * * *').fields[0].star).toBe(true);
    expect(value('0,*/10 * * * *').fields[0].star).toBe(false);
  });

  it('defaults the timezone to UTC and validates a given one', () => {
    expect(value('0 2 * * 1').timezone).toBe('UTC');
    expect(value('0 2 * * 1', { timezone: 'Test/NY' }).timezone).toBe('Test/NY');
    const r = parse('0 2 * * 1', { timezone: 'Nowhere/Land' });
    expect(r.ok ? null : r.error).toMatchObject({ code: 'bad-timezone', span: [0, 0] });
  });

  it('rejects an unknown dialect id without throwing', () => {
    const r = parse('0 2 * * 1', { dialect: 'constructor' as never });
    expect(r.ok ? null : r.error.code).toBe('unknown-dialect');
  });
});
