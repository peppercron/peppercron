import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { getDialect } from '../src/dialects';
import { matches, next, parse, prev } from '../src/index';
import type { Dialect, Run } from '../src/types';
import { CORPUS, readJson } from './helpers/corpus';

interface Expected { at: string; local: string; dst?: string }
interface NextCase {
  id: string;
  dialect: Dialect;
  input: string;
  timezone: string;
  from: string;
  until?: string;
  count: number;
  expect: Expected[];
  notMatching?: string[];
  skipDerived?: boolean;
}

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as typeof AjvModule;
const validate = new Ajv({ allErrors: true }).compile(readJson<object>('schemas/next-case.schema.json'));

const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');
const shape = (r: Run): Expected =>
  r.dst ? { at: iso(r.at), local: r.local, dst: r.dst } : { at: iso(r.at), local: r.local };

for (const file of readdirSync(join(CORPUS, 'cases', 'next')).filter((f) => f.endsWith('.json'))) {
  describe(`corpus next: ${file}`, () => {
    const cases = readJson<NextCase[]>(`cases/next/${file}`);

    it('matches the case schema', () => {
      validate(cases);
      expect(validate.errors ?? []).toEqual([]);
    });

    it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
      const parsed = parse(c.input, { dialect: c.dialect, timezone: c.timezone });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const s = parsed.value;

      const opts = { from: new Date(c.from), count: c.count, ...(c.until ? { until: new Date(c.until) } : {}) };
      expect(next(s, opts).map(shape)).toEqual(c.expect);

      for (const instant of c.notMatching ?? []) {
        expect(matches(s, new Date(instant)), `${instant} must not match`).toBe(false);
      }
      if (c.skipDerived || c.expect.length === 0) return;

      const unit = getDialect(c.dialect)!.fields.some((f) => f.name === 'second') ? 1000 : 60000;
      let floor = new Date(c.from).getTime();
      for (const e of c.expect) {
        const at = new Date(e.at).getTime();
        expect(matches(s, new Date(at)), `${e.at} must match`).toBe(true);
        if (at - unit > floor) {
          expect(matches(s, new Date(at - unit)), `one unit before ${e.at} must not match`).toBe(false);
        }
        floor = at;
      }

      const last = new Date(c.expect[c.expect.length - 1].at).getTime();
      const back = prev(s, { from: new Date(last + 1000), count: c.expect.length });
      expect(back.map(shape)).toEqual([...c.expect].reverse());
    });
  });
}
