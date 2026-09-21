import { daysFromCivil, floorDiv } from './calendar';
import type { Transition, Tz } from './types';

const DAY = 86400;
/** Transitions are discovered and cached in 64-day chunks: chunk k owns (k*CHUNK, (k+1)*CHUNK]. */
const CHUNK = 64 * DAY;

const formats = new Map<string, Intl.DateTimeFormat | null>();
const chunks = new Map<string, Transition[]>();

function format(zone: string): Intl.DateTimeFormat | null {
  let f = formats.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hourCycle: 'h23',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric',
      });
    } catch {
      f = null;
    }
    formats.set(zone, f);
  }
  return f;
}

function offsetAt(zone: string, sec: number): number {
  const f = format(zone);
  if (!f) return 0;
  let y = 0, mo = 1, d = 1, h = 0, mi = 0, s = 0;
  for (const part of f.formatToParts(new Date(sec * 1000))) {
    const n = Number(part.value);
    if (part.type === 'year') y = n;
    else if (part.type === 'month') mo = n;
    else if (part.type === 'day') d = n;
    else if (part.type === 'hour') h = n === 24 ? 0 : n;
    else if (part.type === 'minute') mi = n;
    else if (part.type === 'second') s = n;
  }
  return daysFromCivil(y, mo, d) * DAY + h * 3600 + mi * 60 + s - sec;
}

/** Probe once a day; where the offset differs, bisect to the first second with the new offset. */
function scanChunk(zone: string, k: number): Transition[] {
  const key = `${zone}|${k}`;
  const cached = chunks.get(key);
  if (cached) return cached;
  const found: Transition[] = [];
  let lo = k * CHUNK;
  let before = offsetAt(zone, lo);
  for (let hi = lo + DAY; hi <= (k + 1) * CHUNK; hi += DAY) {
    const atHi = offsetAt(zone, hi);
    if (atHi !== before) {
      let a = lo;
      let b = hi;
      while (b - a > 1) {
        const mid = a + floorDiv(b - a, 2);
        if (offsetAt(zone, mid) === before) a = mid;
        else b = mid;
      }
      found.push({ at: b, before, after: offsetAt(zone, b) });
      before = atHi;
    }
    lo = hi;
  }
  chunks.set(key, found);
  return found;
}

export const intlTz: Tz = {
  isValid: (zone) => zone !== '' && format(zone) !== null,
  offsetAt,
  transitions(zone, fromSec, toSec) {
    if (toSec <= fromSec || zone === 'UTC' || zone === 'Etc/UTC' || !format(zone)) return [];
    const out: Transition[] = [];
    for (let k = floorDiv(fromSec, CHUNK); k <= floorDiv(toSec, CHUNK); k++) {
      for (const t of scanChunk(zone, k)) if (t.at > fromSec && t.at <= toSec) out.push(t);
    }
    return out;
  },
};
