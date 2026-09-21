import { fail, ok } from '../result';
import type { Interval, ParseError, Result, Span } from '../types';

export interface IntervalForm {
  /** True when the input (already left-trimmed) is written in this form, valid or not. */
  claims(text: string): boolean;
  /** `text` is the input without surrounding whitespace; `start` is its offset in the source. */
  read(text: string, start: number): Result<Interval, ParseError>;
}

const UNIT_NS: Record<string, number> = {
  ns: 1, us: 1e3, 'µs': 1e3, 'μs': 1e3, ms: 1e6, s: 1e9, m: 6e10, h: 3.6e12,
};
/** Go's Duration is an int64 of nanoseconds. */
const MAX_NS = 2 ** 63;

/** Go's time.ParseDuration, in nanoseconds: `[-+]?([0-9]*(\.[0-9]*)?[a-z]+)+`, or a bare 0. null = invalid. */
function goDurationNs(text: string): number | null {
  const sign = text[0] === '-' ? -1 : 1;
  let rest = text[0] === '-' || text[0] === '+' ? text.slice(1) : text;
  if (rest === '0') return 0;
  if (rest === '') return null;
  let total = 0;
  while (rest !== '') {
    const m = /^(\d*)(?:\.(\d*))?([^\d.]+)/.exec(rest);
    if (!m || (m[1] === '' && (m[2] ?? '') === '')) return null;
    if (!Object.prototype.hasOwnProperty.call(UNIT_NS, m[3])) return null;
    const unit = UNIT_NS[m[3]];
    const frac = m[2] ?? '';
    // Go adds the fraction as float64(f) * (unit / scale), truncated; this mirrors it.
    total += Number(m[1] || '0') * unit + (frac === '' ? 0 : Math.floor(Number(frac) * (unit / 10 ** frac.length)));
    if (!(total < MAX_NS)) return null;
    rest = rest.slice(m[0].length);
  }
  return sign * total;
}

const RATE_UNITS: Record<string, number> = {
  minute: 60, minutes: 60, hour: 3600, hours: 3600, day: 86400, days: 86400,
};

/** Strategy registry for the `interval` axis of corpus/strategies.json. */
export const INTERVALS: Record<string, IntervalForm> = {
  none: {
    claims: () => false,
    read: (text, start) => fail('bad-interval', 'This dialect has no interval form', [start, start + text.length]),
  },

  // robfig/cron: "@every " + time.ParseDuration; below 1s becomes 1s, then truncated to whole seconds (DERIVATION K7).
  'go-duration': {
    claims: (text) => /^@every(\s|$)/.test(text),
    read(text, start) {
      const whole: Span = [start, start + text.length];
      const m = /^@every\s+(\S+)$/.exec(text);
      if (!m) return fail('bad-interval', '@every needs one duration, such as "@every 1h30m"', whole);
      const ns = goDurationNs(m[1]);
      if (ns === null) {
        const at = start + text.length - m[1].length;
        return fail('bad-interval', `Cannot read "${m[1]}" as a duration; the units are ns, us, ms, s, m and h`, [at, at + m[1].length]);
      }
      return ok({ seconds: ns < 1e9 ? 1 : Math.floor(ns / 1e9), raw: text, span: whole });
    },
  },

  // EventBridge: rate(value unit), a positive integer, unit singular exactly when the value is 1 (DERIVATION A9).
  'aws-rate': {
    claims: (text) => text.startsWith('rate('),
    read(text, start) {
      const whole: Span = [start, start + text.length];
      if (!text.endsWith(')')) return fail('bad-wrapper', '"rate(" must be closed by one final ")"', whole);
      const inner: Span = [start + 5, start + text.length - 1];
      const m = /^rate\(\s*(\S+)\s+(\S+)\s*\)$/.exec(text);
      const value = m && /^\d{1,15}$/.test(m[1]) ? Number(m[1]) : 0;
      const unit = m && Object.prototype.hasOwnProperty.call(RATE_UNITS, m[2]) ? RATE_UNITS[m[2]] : 0;
      const seconds = value * unit;
      if (!m || seconds < 1 || !Number.isSafeInteger(seconds) || m[2].endsWith('s') !== (value !== 1)) {
        return fail('bad-interval', 'rate() needs a positive whole number and minute(s), hour(s) or day(s), plural unless the number is 1', inner);
      }
      return ok({ seconds, raw: text, span: whole });
    },
  },
};
