import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { createParser } from '../src/parse/parse';
import { intlTz } from '../src/tz-intl';
import type { ParseOptions, Schedule } from '../src/types';
import { CORPUS, readJson } from './helpers/corpus';

interface Summary {
  dialect: string;
  candidates?: string[];
  unsupported?: string[];
  values?: Record<string, number[]>;
  star?: Record<string, boolean>;
  interval?: { seconds: number };
}

interface ParseCase {
  id: string;
  input: string;
  options?: ParseOptions;
  expect?: Schedule;
  expectSummary?: Summary;
  expectError?: { code: string; span: [number, number] };
}

/** The same shape as `want`, read off the parsed schedule, so toEqual shows a useful diff. */
function summarise(s: Schedule, want: Summary): Summary {
  const got: Summary = { dialect: s.dialect };
  if (s.candidates) got.candidates = s.candidates;
  if (s.interval) got.interval = { seconds: s.interval.seconds };
  const unsupported = s.fields.filter((f) => f.terms.some((t) => t.unsupported)).map((f) => f.name);
  if (unsupported.length > 0) got.unsupported = unsupported;
  const field = (name: string) => s.fields.find((f) => f.name === name);
  if (want.values) got.values = Object.fromEntries(Object.keys(want.values).map((n) => [n, field(n)?.values ?? []]));
  if (want.star) got.star = Object.fromEntries(Object.keys(want.star).map((n) => [n, field(n)?.star ?? false]));
  return got;
}

const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as typeof AjvModule;
const validate = new Ajv({ allErrors: true }).compile(readJson<object>('schemas/parse-case.schema.json'));
const parse = createParser(intlTz);

for (const file of readdirSync(join(CORPUS, 'cases', 'parse')).filter((f) => f.endsWith('.json'))) {
  describe(`corpus parse: ${file}`, () => {
    const cases = readJson<ParseCase[]>(`cases/parse/${file}`);

    it('matches the case schema', () => {
      validate(cases);
      expect(validate.errors ?? []).toEqual([]);
    });

    it.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
      const r = parse(c.input, c.options ?? {});
      if (c.expect) {
        expect(r).toEqual({ ok: true, value: c.expect });
      } else if (c.expectSummary) {
        expect(r.ok, r.ok ? '' : `unexpected ${r.error.code}`).toBe(true);
        if (r.ok) expect(summarise(r.value, c.expectSummary)).toEqual(c.expectSummary);
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) expect({ code: r.error.code, span: r.error.span }).toEqual(c.expectError);
      }
    });
  });
}
