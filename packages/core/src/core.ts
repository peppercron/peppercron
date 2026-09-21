import { createEngine } from './engine';
import { createParser } from './parse/parse';
import type { Tz } from './types';

/** The whole library over an injected timezone provider. Ports and tests use this; most callers use index.ts. */
export function createCore(tz: Tz) {
  const parse = createParser(tz);
  return { parse, ...createEngine(tz, parse) };
}
