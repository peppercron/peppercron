import { createCore } from './core';
import { intlTz } from './tz-intl';

export type * from './types';
export { createCore, intlTz };

const core = createCore(intlTz);

export const parse = core.parse;
export const next = core.next;
export const prev = core.prev;
export const matches = core.matches;
