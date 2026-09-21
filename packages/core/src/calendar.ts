// Pure integer calendar arithmetic (proleptic Gregorian). No Date, so every port can match it exactly.
// daysFromCivil / civilFromDays follow Howard Hinnant's public-domain algorithms.

export function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = floorDiv(yy, 400);
  const yoe = yy - era * 400;
  const doy = floorDiv(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + d - 1;
  const doe = yoe * 365 + floorDiv(yoe, 4) - floorDiv(yoe, 100) + doy;
  return era * 146097 + doe - 719468;
}

export function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = floorDiv(z, 146097);
  const doe = z - era * 146097;
  const yoe = floorDiv(doe - floorDiv(doe, 1460) + floorDiv(doe, 36524) - floorDiv(doe, 146096), 365);
  const doy = doe - (365 * yoe + floorDiv(yoe, 4) - floorDiv(yoe, 100));
  const mp = floorDiv(5 * doy + 2, 153);
  const d = doy - floorDiv(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

export function weekdayOfDays(days: number): number {
  return (((days + 4) % 7) + 7) % 7;
}

export function daysInMonth(y: number, m: number): number {
  if (m === 2) return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

export function wallSeconds(y: number, m: number, d: number, h: number, mi: number, s: number): number {
  return daysFromCivil(y, m, d) * 86400 + h * 3600 + mi * 60 + s;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** A wall time as ISO local time with no offset. Used where the wall time has none: a time a gap skipped. */
export function formatWall(wallSec: number): string {
  const days = floorDiv(wallSec, 86400);
  const tod = wallSec - days * 86400;
  const { y, m, d } = civilFromDays(days);
  return `${pad(y, 4)}-${pad(m)}-${pad(d)}T${pad(floorDiv(tod, 3600))}:${pad(floorDiv(tod % 3600, 60))}:${pad(tod % 60)}`;
}

export function formatLocal(wallSec: number, offsetSec: number): string {
  const abs = Math.abs(offsetSec);
  const offS = abs % 60;
  const offset =
    `${offsetSec < 0 ? '-' : '+'}${pad(floorDiv(abs, 3600))}:${pad(floorDiv(abs % 3600, 60))}` +
    (offS ? `:${pad(offS)}` : '');
  return `${formatWall(wallSec)}${offset}`;
}
