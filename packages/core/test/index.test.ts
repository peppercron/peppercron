import { describe, expect, it } from 'vitest';
import { createCore, intlTz, matches, next, parse, prev } from '../src/index';

describe('public entry point', () => {
  it('exports the four functions bound to the Intl timezone provider', () => {
    const parsed = parse('30 2 * * *', { timezone: 'America/New_York' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const [run] = next(parsed.value, { from: new Date('2026-03-07T12:00:00Z'), count: 1 });
    expect(run).toEqual({
      at: new Date('2026-03-08T07:00:00Z'),
      local: '2026-03-08T03:00:00-04:00',
      dst: 'skipped-adjusted',
      scheduled: '2026-03-08T02:30:00',
    });
    expect(matches(parsed.value, run.at)).toBe(true);
    expect(prev(parsed.value, { from: new Date('2026-03-08T07:00:01Z'), count: 1 })).toEqual([run]);
  });

  it('exports createCore and intlTz for callers that inject their own provider', () => {
    expect(typeof createCore(intlTz).next).toBe('function');
  });
});
