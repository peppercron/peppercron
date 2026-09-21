import { DIALECT_DATA, DIALECT_ORDER, STRATEGY_IDS } from './generated/corpus';
import type { Dialect, FieldName } from './types';

export interface FieldSpec {
  name: FieldName;
  min: number;
  max: number;
  names?: 'month' | 'dow';
  /** The number this dialect uses for Sunday in the day-of-week field. */
  sundayIs?: number;
  /** Special token ids this field allows: '?', 'L', 'L-n', 'W', 'LW', 'nL', '#'. */
  tokens?: string[];
  optional?: boolean;
}

export interface DialectSpec {
  id: Dialect;
  family: string;
  fields: FieldSpec[];
  /** Macro name to its field expansion; null means a macro with no schedule. */
  macros: Record<string, string | null>;
  trailingCommand: boolean;
  rangeWrap: 'error' | 'empty' | 'wrap';
  /** What `5/15` means: a parse error (cronie), or 5 through the field maximum every 15 (Quartz). */
  singleStep: 'error' | 'to-max';
  domDow: string;
  dstGap: string;
  dstOverlap: string;
  missedRuns: string;
  defaultTimezone: string;
}

export type StrategyAxis = 'family' | 'domDow' | 'dstGap' | 'dstOverlap';

const data = DIALECT_DATA as Record<string, DialectSpec>;

export const dialectOrder: readonly string[] = DIALECT_ORDER;

export const strategyIds = STRATEGY_IDS as Record<StrategyAxis, string[]>;

export function getDialect(id: string): DialectSpec | undefined {
  return Object.prototype.hasOwnProperty.call(data, id) ? data[id] : undefined;
}
