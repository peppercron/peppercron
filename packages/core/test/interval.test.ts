import { describe, expect, it } from 'vitest';
import { INTERVALS } from '../src/parse/interval';

const seconds = (id: string, text: string) => {
  const r = INTERVALS[id].read(text, 0);
  return r.ok ? r.value.seconds : r.error.code;
};

describe('go-duration (DERIVATION K7)', () => {
  it.each([
    ['@every 1h', 3600],
    ['@every 1h30m', 5400],
    ['@every 1h30m10s', 5410],
    ['@every 1.5h', 5400],
    ['@every .5h', 1800],
    ['@every 90s', 90],
    ['@every +90s', 90],
    ['@every 1500ms', 1],
    ['@every 2500ms', 2],
    ['@every 500ms', 1],
    ['@every 1000000us', 1],
    ['@every 1000000µs', 1],
    ['@every 0', 1],
    ['@every 0s', 1],
    ['@every -1h', 1],
    ['@every 1d', 'bad-interval'],
    ['@every 1', 'bad-interval'],
    ['@every h', 'bad-interval'],
    ['@every .h', 'bad-interval'],
    ['@every 1.5.5h', 'bad-interval'],
    ['@every 1h 30m', 'bad-interval'],
    ['@every', 'bad-interval'],
    ['@every 9999999999999h', 'bad-interval'],
    ['@every 1e3s', 'bad-interval'],
  ])('%s -> %s', (text, want) => {
    expect(seconds('go-duration', text)).toBe(want);
  });

  it('claims @every only as a whole word', () => {
    expect(INTERVALS['go-duration'].claims('@every 1h')).toBe(true);
    expect(INTERVALS['go-duration'].claims('@every')).toBe(true);
    expect(INTERVALS['go-duration'].claims('@everyday')).toBe(false);
    expect(INTERVALS['go-duration'].claims('@daily')).toBe(false);
  });
});

describe('aws-rate (DERIVATION A9)', () => {
  it.each([
    ['rate(1 minute)', 60],
    ['rate(5 minutes)', 300],
    ['rate(1 hour)', 3600],
    ['rate(12 hours)', 43200],
    ['rate(1 day)', 86400],
    ['rate(7 days)', 604800],
    ['rate( 5  minutes )', 300],
    ['rate(1 minutes)', 'bad-interval'],
    ['rate(5 minute)', 'bad-interval'],
    ['rate(0 minutes)', 'bad-interval'],
    ['rate(-5 minutes)', 'bad-interval'],
    ['rate(1.5 hours)', 'bad-interval'],
    ['rate(5 weeks)', 'bad-interval'],
    ['rate(5 Minutes)', 'bad-interval'],
    ['rate(5)', 'bad-interval'],
    ['rate()', 'bad-interval'],
    ['rate(5 minutes 3)', 'bad-interval'],
    ['rate(999999999999999 days)', 'bad-interval'],
    ['rate(9999999999999999999999 days)', 'bad-interval'],
    ['rate(5 minutes', 'bad-wrapper'],
    ['rate(5 minutes) x', 'bad-wrapper'],
  ])('%s -> %s', (text, want) => {
    expect(seconds('aws-rate', text)).toBe(want);
  });
});

describe('none', () => {
  it('claims nothing', () => {
    expect(INTERVALS.none.claims('@every 1h')).toBe(false);
    expect(INTERVALS.none.claims('rate(5 minutes)')).toBe(false);
  });
});
