import { defineConfig } from 'tsup'

export default defineConfig({
  entry: { cli: 'src/cli.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  dts: false,
  // No sourcemap: it embeds full sourcesContent and was 74% of the published
  // tarball. The source is public on GitHub; debug from a source checkout.
  sourcemap: false,
  // Native + heavy deps stay external (resolved from node_modules at runtime).
  // tsup externalizes package.json "dependencies" by default; better-sqlite3 is native.
  splitting: false,
})
