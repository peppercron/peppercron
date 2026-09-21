import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { createParser } from '../src/parse/parse';
import { intlTz } from '../src/tz-intl';
import type { ParseOptions, Schedule } from '../src/types';
import { CORPUS, readJson } from './helpers/corpus';

interface ParseCase {
  id: string;
  input: string;
  options?: ParseOptions;
  expect?: Schedule;
  expectError?: { code: string; span: [number, number] };
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
      } else {
        expect(r.ok).toBe(false);
        if (!r.ok) expect({ code: r.error.code, span: r.error.span }).toEqual(c.expectError);
      }
    });
  });
}
