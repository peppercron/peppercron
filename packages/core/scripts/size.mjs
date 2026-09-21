// Fails when the minified ESM bundle exceeds the foundation's share of the 30 KB v1 budget.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const LIMIT = 12 * 1024;
const bytes = gzipSync(readFileSync(new URL('../dist/index.js', import.meta.url))).length;
console.log(`dist/index.js: ${bytes} bytes gzipped (limit ${LIMIT})`);
if (bytes > LIMIT) {
  console.error('Size budget exceeded.');
  process.exit(1);
}
