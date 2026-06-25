import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  dts: false,
  sourcemap: true,
  // Native + heavy deps stay external (resolved from node_modules at runtime).
  // tsup externalizes package.json "dependencies" by default; better-sqlite3 is native.
  splitting: false,
})
