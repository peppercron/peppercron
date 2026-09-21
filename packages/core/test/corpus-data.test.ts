import AjvModule from 'ajv';
import { describe, expect, it } from 'vitest';
import { dialectOrder, getDialect, strategyIds } from '../src/dialects';
import { readJson } from './helpers/corpus';

// Ajv ships CommonJS; depending on interop the class is the default export or its .default.
const Ajv = ((AjvModule as unknown as { default?: unknown }).default ?? AjvModule) as typeof AjvModule;
const ajv = new Ajv({ allErrors: true });

function expectValid(schemaPath: string, dataPath: string) {
  const validate = ajv.compile(readJson<object>(schemaPath));
  const valid = validate(readJson<unknown>(dataPath));
  expect(validate.errors ?? []).toEqual([]);
  expect(valid).toBe(true);
}

describe('corpus data', () => {
  it('strategies.json and index.json match their schemas', () => {
    expectValid('schemas/strategies.schema.json', 'strategies.json');
    expectValid('schemas/index.schema.json', 'dialects/index.json');
  });

  it('every dialect file matches the schema and its id matches its filename', () => {
    for (const id of readJson<string[]>('dialects/index.json')) {
      expectValid('schemas/dialect.schema.json', `dialects/${id}.json`);
      expect(readJson<{ id: string }>(`dialects/${id}.json`).id).toBe(id);
    }
  });

  it('every strategy id a dialect references is listed in strategies.json', () => {
    const listed = readJson<Record<string, string[]>>('strategies.json');
    for (const id of readJson<string[]>('dialects/index.json')) {
      const d = readJson<Record<string, string>>(`dialects/${id}.json`);
      for (const axis of ['family', 'domDow', 'dstGap', 'dstOverlap']) {
        expect(listed[axis], `${id}.${axis}`).toContain(d[axis]);
      }
    }
  });
});

describe('dialects module', () => {
  it('exposes the generated data', () => {
    expect(dialectOrder).toEqual(['vixie', 'quartz']);
    expect(getDialect('quartz')?.fields).toHaveLength(7);
    expect(getDialect('vixie')?.macros['@reboot']).toBeNull();
    expect(strategyIds.dstGap).toEqual(['skip', 'vixie-window']);
  });

  it('returns undefined for unknown ids, including Object.prototype keys', () => {
    expect(getDialect('nope')).toBeUndefined();
    expect(getDialect('constructor')).toBeUndefined();
  });
});
