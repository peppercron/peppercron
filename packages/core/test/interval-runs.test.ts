import { describe, expect, it } from 'vitest';
import { intervalRuns } from '../src/interval-runs';

describe('intervalRuns', () => {
  it('lists anchor + k * seconds inside the window, from k = firstK', () => {
    expect(intervalRuns(60, 1, 0, 0, 300, 10, false)).toEqual([60, 120, 180, 240, 300]);
    expect(intervalRuns(60, 0, 0, 0, 300, 10, false)).toEqual([0, 60, 120, 180, 240, 300]);
  });

  it('takes the earliest or the latest `count`, ascending either way', () => {
    expect(intervalRuns(60, 1, 0, 0, 300, 2, false)).toEqual([60, 120]);
    expect(intervalRuns(60, 1, 0, 0, 300, 2, true)).toEqual([240, 300]);
  });

  it('has no runs before the anchor', () => {
    expect(intervalRuns(60, 0, 1000, 0, 999, 10, false)).toEqual([]);
    expect(intervalRuns(60, 1, 1000, 0, 1059, 10, false)).toEqual([]);
    expect(intervalRuns(60, 0, 1000, 0, 1000, 10, true)).toEqual([1000]);
  });

  it('handles a window that is not aligned to the interval', () => {
    expect(intervalRuns(90, 1, 0, 100, 400, 10, false)).toEqual([180, 270, 360]);
  });

  it('is arithmetic: a window billions of intervals from the anchor costs the same (Review Focus 3)', () => {
    const started = Date.now();
    expect(intervalRuns(1, 1, 0, 5e9, 5e9 + 2, 10, false)).toEqual([5e9, 5e9 + 1, 5e9 + 2]);
    expect(Date.now() - started).toBeLessThan(200);
  });
});
