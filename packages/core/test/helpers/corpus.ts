import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'corpus');

export function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(join(CORPUS, relativePath), 'utf8')) as T;
}
