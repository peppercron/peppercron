import type { Transition, Tz } from '../../src/types';

export function fakeTz(zones: Record<string, { initial: number; transitions?: Transition[] }>): Tz {
  const has = (zone: string) => Object.prototype.hasOwnProperty.call(zones, zone);
  return {
    isValid: has,
    offsetAt(zone, sec) {
      if (!has(zone)) return 0;
      let offset = zones[zone].initial;
      for (const t of zones[zone].transitions ?? []) if (t.at <= sec) offset = t.after;
      return offset;
    },
    transitions(zone, fromSec, toSec) {
      if (!has(zone)) return [];
      return (zones[zone].transitions ?? []).filter((t) => t.at > fromSec && t.at <= toSec);
    },
  };
}

/** 2026-03-08T07:00:00Z: 02:00 EST becomes 03:00 EDT. */
export const T_GAP = Date.UTC(2026, 2, 8, 7) / 1000;
/** 2026-11-01T06:00:00Z: 02:00 EDT becomes 01:00 EST. */
export const T_OVERLAP = Date.UTC(2026, 10, 1, 6) / 1000;
/** 2011-12-30T10:00:00Z: UTC-10 becomes UTC+14, as Pacific/Apia did, skipping a whole wall day. */
export const T_DAY_GAP = Date.UTC(2011, 11, 30, 10) / 1000;

const gap: Transition = { at: T_GAP, before: -18000, after: -14400 };
const overlap: Transition = { at: T_OVERLAP, before: -14400, after: -18000 };
const dayGap: Transition = { at: T_DAY_GAP, before: -36000, after: 50400 };

export const testTz: Tz = fakeTz({
  UTC: { initial: 0 },
  'Test/Gap': { initial: -18000, transitions: [gap] },
  'Test/Overlap': { initial: -14400, transitions: [overlap] },
  'Test/NY': { initial: -18000, transitions: [gap, overlap] },
  'Test/Apia': { initial: -36000, transitions: [dayGap] },
});
