import { dialectOrder, getDialect, type DialectSpec } from '../dialects';
import { fail, ok } from '../result';
import type { Field, ParseError, ParseOptions, Result, Schedule, Span, Tz } from '../types';
import { parseField } from './field';
import { claims, region, unwrap } from './forms';
import { tokenize, type Token } from './tokenize';

export type FamilyParser = (
  spec: DialectSpec, source: string, tokens: Token[], timezone: string,
) => Result<Schedule, ParseError>;

function spanOf(tokens: Token[]): Span {
  return [tokens[0].span[0], tokens[tokens.length - 1].span[1]];
}

function parseCronFields(spec: DialectSpec, source: string, tokens: Token[], timezone: string): Result<Schedule, ParseError> {
  const first = tokens[0];
  let fieldTokens = tokens;
  let rest: Token[] = [];
  let macro: string | undefined;

  if (first.text.startsWith('@')) {
    if (!Object.prototype.hasOwnProperty.call(spec.macros, first.text)) {
      return fail('unknown-macro', `${spec.id} has no macro "${first.text}"`, first.span);
    }
    macro = first.text;
    const expansion = spec.macros[macro];
    rest = tokens.slice(1);
    fieldTokens = expansion === null
      ? []
      : expansion.split(' ').map((text) => ({ text, span: first.span, fixedSpan: true }));
  } else {
    const max = spec.fields.length;
    const required = spec.fields.filter((f) => !f.optional).length;
    if (tokens.length < required) {
      const wanted = required === max ? `${max}` : `${required}-${max}`;
      return fail('field-count', `${spec.id} needs ${wanted} fields, found ${tokens.length}`, spanOf(tokens));
    }
    fieldTokens = tokens.slice(0, max);
    rest = tokens.slice(max);
  }

  if (rest.length > 0 && !spec.trailingCommand) {
    return fail('field-count', `${spec.id} takes at most ${spec.fields.length} fields, found ${tokens.length}`, spanOf(tokens));
  }

  const fields: Field[] = [];
  for (let i = 0; i < fieldTokens.length; i++) {
    const field = parseField(fieldTokens[i], spec.fields[i], spec);
    if (!field.ok) return field;
    fields.push(field.value);
  }

  const schedule: Schedule = { dialect: spec.id, source, timezone, fields };
  if (macro !== undefined) schedule.macro = macro;
  if (rest.length > 0) {
    const span = spanOf(rest);
    schedule.trailing = { text: source.slice(span[0], span[1]), span };
  }
  return ok(schedule);
}

/** Strategy registry for the `family` axis of corpus/strategies.json. */
export const FAMILIES: Record<string, FamilyParser> = {
  'cron-fields': parseCronFields,
};

function parseAs(spec: DialectSpec, source: string, timezone: string): Result<Schedule, ParseError> {
  const family = FAMILIES[spec.family];
  if (!family) return fail('unknown-dialect', `No parser for dialect family "${spec.family}"`, [0, 0]);
  const text = unwrap(spec, source);
  if (!text.ok) return text;
  const tokens = tokenize(text.value);
  if (tokens.length === 0) return fail('field-count', `${spec.id} found no fields inside the wrapper`, region(source));
  return family(spec, source, tokens, timezone);
}

const hasUnsupported = (s: Schedule) => s.fields.some((f) => f.terms.some((t) => t.unsupported));

function detect(source: string, timezone: string): Result<Schedule, ParseError> {
  // A form only some dialects have (cron(...)) is theirs alone, so its errors are theirs too.
  const claimed = dialectOrder.filter((id) => claims(getDialect(id)!, source));
  const attempts = (claimed.length > 0 ? claimed : dialectOrder).map((id) => parseAs(getDialect(id)!, source, timezone));
  const parsed = attempts.flatMap((r) => (r.ok ? [r.value] : []));
  const clean = parsed.filter((s) => !hasUnsupported(s));
  const tidy = clean.filter((s) => !s.trailing);
  const pool = tidy.length > 0 ? tidy : clean;

  if (pool.length > 0) {
    const winner = pool[0];
    return ok(pool.length > 1 ? { ...winner, candidates: pool.map((s) => s.dialect) } : winner);
  }
  if (parsed.length > 0) return ok(parsed[0]);
  return attempts.find((r) => !r.ok && r.error.code !== 'field-count') ?? attempts[0];
}

export function createParser(tz: Tz) {
  return function parse(input: string, opts?: ParseOptions | null): Result<Schedule, ParseError> {
    const o = opts ?? {};
    const tokens = tokenize(input);
    if (tokens.length === 0) return fail('empty', 'The expression is empty', [0, input.length]);

    const timezone = o.timezone ?? 'UTC';
    if (!tz.isValid(timezone)) return fail('bad-timezone', `Unknown timezone "${timezone}"`, [0, 0]);

    if (o.dialect === undefined) return detect(input, timezone);

    const spec = getDialect(o.dialect);
    if (!spec) return fail('unknown-dialect', `Unknown dialect "${String(o.dialect)}"`, [0, 0]);
    return parseAs(spec, input, timezone);
  };
}
