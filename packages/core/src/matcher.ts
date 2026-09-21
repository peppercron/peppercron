import { civilFromDays, daysFromCivil, daysInMonth, floorDiv, weekdayOfDays } from './calendar';
import type { DialectSpec } from './dialects';
import type { Field, FieldName, Schedule } from './types';

export interface DaySide {
  hit: boolean;
  star: boolean;
}

export type DomDowStrategy = (dom: DaySide, dow: DaySide) => boolean;

/** Strategy registry for the `domDow` axis of corpus/strategies.json. */
export const DOM_DOW: Record<string, DomDowStrategy> = {
  // Vixie: a day field that starts with '*' makes the pair AND; two restricted fields are OR.
  or: (dom, dow) => (dom.star || dow.star ? dom.hit && dow.hit : dom.hit || dow.hit),
  // Quartz: '?' always hits, so this is "the other field decides"; with no '?' it is AND.
  'exclusive-question': (dom, dow) => dom.hit && dow.hit,
};

export interface Compiled {
  resolution: 1 | 60;
  seconds: number[];
  minutes: number[];
  hours: number[];
  months: number[];
  years: number[] | null;
  /** Neither field is a star under the dialect's `star` strategy (H1: `leading`, K10: `unstepped-term`). */
  fixedTime: boolean;
  dayMatches(y: number, m: number, d: number): boolean;
}

const UNSPECIFIED: DaySide = { hit: true, star: true };

function lastWeekdayOfMonth(y: number, m: number, dim: number): number {
  const wd = weekdayOfDays(daysFromCivil(y, m, dim));
  return wd === 6 ? dim - 1 : wd === 0 ? dim - 2 : dim;
}

function nearestWeekday(y: number, m: number, day: number, dim: number): number {
  const wd = weekdayOfDays(daysFromCivil(y, m, day));
  if (wd === 6) return day === 1 ? 3 : day - 1;
  if (wd === 0) return day === dim ? day - 2 : day + 1;
  return day;
}

function domSide(f: Field, y: number, m: number, d: number, dim: number): DaySide {
  if (f.terms.some((t) => t.kind === 'unspecified')) return UNSPECIFIED;
  let hit = f.values.includes(d);
  for (const t of f.terms) {
    if (hit) break;
    if (t.kind === 'last') hit = d === dim - t.offset;
    else if (t.kind === 'lastWeekday') hit = d === lastWeekdayOfMonth(y, m, dim);
    else if (t.kind === 'nearestWeekday') hit = t.day <= dim && d === nearestWeekday(y, m, t.day, dim);
  }
  return { hit, star: f.star };
}

function dowSide(f: Field, d: number, dim: number, wd: number): DaySide {
  if (f.terms.some((t) => t.kind === 'unspecified')) return UNSPECIFIED;
  let hit = f.values.includes(wd);
  for (const t of f.terms) {
    if (hit) break;
    if (t.kind === 'lastDow') hit = wd === t.dow && d + 7 > dim;
    else if (t.kind === 'nthDow') hit = wd === t.dow && floorDiv(d - 1, 7) + 1 === t.n;
  }
  return { hit, star: f.star };
}

export function compile(s: Schedule, spec: DialectSpec): Compiled | null {
  const get = (name: FieldName) => s.fields.find((f) => f.name === name);
  const minute = get('minute');
  const hour = get('hour');
  const dom = get('dayOfMonth');
  const month = get('month');
  const dow = get('dayOfWeek');
  const combine = DOM_DOW[spec.domDow];
  if (!minute || !hour || !dom || !month || !dow || !combine) return null;

  const second = get('second');
  const year = get('year');
  return {
    resolution: second ? 1 : 60,
    seconds: second ? second.values : [0],
    minutes: minute.values,
    hours: hour.values,
    months: month.values,
    years: year ? year.values : null,
    fixedTime: !(minute.star || hour.star),
    dayMatches(y, m, d) {
      const dim = daysInMonth(y, m);
      const wd = weekdayOfDays(daysFromCivil(y, m, d));
      return combine(domSide(dom, y, m, d, dim), dowSide(dow, d, dim, wd));
    },
  };
}

/** Smallest matching second-of-day >= tod. The value lists are sorted ascending. */
export function nextTimeOfDay(c: Compiled, tod: number): number | null {
  const h0 = floorDiv(tod, 3600);
  const mi0 = floorDiv(tod % 3600, 60);
  const s0 = tod % 60;
  for (const h of c.hours) {
    if (h < h0) continue;
    for (const mi of c.minutes) {
      if (h === h0 && mi < mi0) continue;
      for (const s of c.seconds) {
        if (h === h0 && mi === mi0 && s < s0) continue;
        return h * 3600 + mi * 60 + s;
      }
    }
  }
  return null;
}

/** Smallest matching wall second w with from <= w < limit. Pure integer arithmetic. */
export function nextWallMatch(c: Compiled, from: number, limit: number): number | null {
  if (from >= limit) return null;
  let day = floorDiv(from, 86400);
  let tod = from - day * 86400;
  const lastDay = floorDiv(limit - 1, 86400);

  while (day <= lastDay) {
    const { y, m, d } = civilFromDays(day);

    if (c.years && !c.years.includes(y)) {
      const nextYear = c.years.find((v) => v > y);
      if (nextYear === undefined) return null;
      day = daysFromCivil(nextYear, 1, 1);
      tod = 0;
      continue;
    }
    if (!c.months.includes(m)) {
      day = m === 12 ? daysFromCivil(y + 1, 1, 1) : daysFromCivil(y, m + 1, 1);
      tod = 0;
      continue;
    }
    if (c.dayMatches(y, m, d)) {
      const t = nextTimeOfDay(c, tod);
      if (t !== null) {
        const w = day * 86400 + t;
        return w < limit ? w : null;
      }
    }
    day += 1;
    tod = 0;
  }
  return null;
}
