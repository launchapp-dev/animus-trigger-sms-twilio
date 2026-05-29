import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  splitting: false,
  // npm bin scripts on POSIX must start with a shebang or the shell will
  // try to execute the JS as a shell script. Without this Animus's
  // plugin host fails before the manifest probe even runs.
  banner: { js: '#!/usr/bin/env node' },
  // Skip dts emission — tsup uses rollup-plugin-dts which requires a
  // typecheck pass; we already gate on `npm run typecheck` separately and
  // this plugin ships no public types.
  dts: false,
});
