import { describe, expect, it } from 'vitest';
import { getDialect } from '../src/dialects';
import { claims, region, unwrap } from '../src/parse/forms';

const aws = getDialect('aws')!;
const vixie = getDialect('vixie')!;

describe('region', () => {
  it('is the input without surrounding whitespace, as offsets', () => {
    expect(region('  0 * * * *  ')).toEqual([2, 11]);
    expect(region('0 * * * *')).toEqual([0, 9]);
    expect(region('   ')).toEqual([3, 3]);
  });
});

describe('claims', () => {
  it('is true only for a dialect whose wrapper opens the input', () => {
    expect(claims(aws, 'cron(0 12 * * ? *)')).toBe(true);
    expect(claims(aws, '  cron(0 12 * * ? *)')).toBe(true);
    expect(claims(aws, '0 12 * * ? *')).toBe(false);
    expect(claims(aws, 'CRON(0 12 * * ? *)')).toBe(false);
    expect(claims(vixie, 'cron(0 12 * * ? *)')).toBe(false);
  });

  it('is true for a dialect whose interval form opens the input', () => {
    const k8s = getDialect('kubernetes')!;
    expect(claims(k8s, '@every 1h')).toBe(true);
    expect(claims(k8s, '@daily')).toBe(false);
    expect(claims(aws, 'rate(5 minutes)')).toBe(true);
    expect(claims(vixie, '@every 1h')).toBe(false);
  });
});

describe('unwrap', () => {
  it('returns unwrapped input untouched', () => {
    expect(unwrap(aws, '0 12 * * ? *')).toEqual({ ok: true, value: '0 12 * * ? *' });
  });

  it('blanks the wrapper out, keeping every index where it was', () => {
    for (const input of ['cron(0 12 * * ? *)', ' cron( 0 12 * * ? * ) ', '\tcron(0 12 * * ? *)\n']) {
      const r = unwrap(aws, input);
      expect(r.ok, input).toBe(true);
      if (!r.ok) continue;
      expect(r.value).toHaveLength(input.length);
      expect(r.value.trim()).toBe('0 12 * * ? *');
      expect(r.value.indexOf('0 12')).toBe(input.indexOf('0 12'));
    }
  });

  it('rejects an unclosed wrapper, text after it, and stray parentheses', () => {
    for (const input of ['cron(0 12 * * ? *', 'cron(0 12 * * ? *) x', 'cron(0 12 (* * ? *)', 'cron(0 12) * * ? *)']) {
      const r = unwrap(aws, input);
      expect(r.ok, input).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('bad-wrapper');
    }
  });
});
