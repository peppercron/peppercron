import type { ParseError, ParseErrorCode, Result, Span } from './types';

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

export const fail = (code: ParseErrorCode, message: string, span: Span): Result<never, ParseError> =>
  ({ ok: false, error: { code, message, span } });
