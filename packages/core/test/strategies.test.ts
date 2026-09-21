import { describe, expect, it } from 'vitest';
import { strategyIds } from '../src/dialects';
import { DST_GAP, DST_OVERLAP } from '../src/engine';
import { DOM_DOW } from '../src/matcher';
import { FAMILIES } from '../src/parse/parse';

// Exact equality covers both directions: every listed id is implemented, and nothing is implemented unlisted.
describe('strategy registries match corpus/strategies.json', () => {
  const sorted = (ids: string[]) => [...ids].sort();

  it.each([
    ['family', FAMILIES],
    ['domDow', DOM_DOW],
    ['dstGap', DST_GAP],
    ['dstOverlap', DST_OVERLAP],
  ] as const)('%s', (axis, registry) => {
    expect(sorted(Object.keys(registry))).toEqual(sorted(strategyIds[axis]));
  });
});
