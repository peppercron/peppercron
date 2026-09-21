import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { getDialect } from '../src/dialects';
import { matches, next, parse, prev } from '../src/index';
import type { Dialect, Run } from '../src/types';
import { CORPUS, readJson } from './helpers/corpus';

interface Expected { at: string; local: string; dst?: string; scheduled?: string }
interface NextCase {
  id: string;
  dialect: Dialect;
  input: string;
  timezone: string;
  from: string;
  until?: string;
  anchor?: string;
  count: number;
  expect: Expected[];
  notMatching?: string[];
  skipDerived?: boolean;
}

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as typeof AjvModule;
const validate = new Ajv({ allErrors: true }).compile(readJson<object>('schemas/next-case.schema.json'));

const iso = (d: Date) => d.toISOString().replace('.000Z', 'Z');
const shape = (r: Run): Expected => ({
  at: iso(r.at),
  local: r.local,
  ...(r.dst ? { dst: r.dst } : {}),
  ...(r.scheduled ? { scheduled: r.scheduled } : {}),
});

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

      const anchored = c.anchor ? { anchor: new Date(c.anchor) } : {};
      const opts = { from: new Date(c.from), count: c.count, ...(c.until ? { until: new Date(c.until) } : {}), ...anchored };
      expect(next(s, opts).map(shape)).toEqual(c.expect);

      // The derived checks always name the anchor: matches() has no `from` to default it to.
      const derived = { anchor: new Date(c.anchor ?? c.from) };
      for (const instant of c.notMatching ?? []) {
        expect(matches(s, new Date(instant), derived), `${instant} must not match`).toBe(false);
      }
      if (c.skipDerived || c.expect.length === 0) return;

      const bySecond = s.interval !== undefined || getDialect(c.dialect)!.fields.some((f) => f.name === 'second');
      const unit = bySecond ? 1000 : 60000;
      let floor = new Date(c.from).getTime();
      for (const e of c.expect) {
        const at = new Date(e.at).getTime();
        expect(matches(s, new Date(at), derived), `${e.at} must match`).toBe(true);
        if (at - unit > floor) {
          expect(matches(s, new Date(at - unit), derived), `one unit before ${e.at} must not match`).toBe(false);
        }
        floor = at;
      }

      const last = new Date(c.expect[c.expect.length - 1].at).getTime();
      const back = prev(s, { from: new Date(last + 1000), count: c.expect.length, ...derived });
      expect(back.map(shape)).toEqual([...c.expect].reverse());
    });
  });
}
