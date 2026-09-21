import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2020',
  // tsup's dts bundler (rollup-plugin-dts) needs the classic TypeScript JS
  // compiler API (ts.sys, ts.createProgram, ...), which the installed
  // typescript@7 no longer exposes via require('typescript'). Declarations
  // are emitted separately by the `postbuild` script using `tsc` directly,
  // which still works. See tsconfig.build.json.
  dts: false,
  clean: true,
  minify: true,
  sourcemap: true,
});
