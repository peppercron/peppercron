/**
 * The instants anchor + k * seconds, for k >= firstK, that fall in [startSec, endSec]: at most `count` of
 * them, the earliest ones or (fromEnd) the latest ones, ascending either way. Pure arithmetic, so the cost
 * does not depend on how far the window is from the anchor.
 */
export function intervalRuns(
  seconds: number, firstK: 0 | 1, anchorSec: number, startSec: number, endSec: number, count: number, fromEnd: boolean,
): number[] {
  const kMin = Math.max(firstK, Math.ceil((startSec - anchorSec) / seconds));
  const kMax = Math.floor((endSec - anchorSec) / seconds);
  if (!(kMax >= kMin)) return [];
  const n = Math.min(count, kMax - kMin + 1);
  const k0 = fromEnd ? kMax - n + 1 : kMin;
  return Array.from({ length: n }, (_, i) => anchorSec + (k0 + i) * seconds);
}
