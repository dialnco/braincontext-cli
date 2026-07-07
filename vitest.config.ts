import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `@core` mirrors studio/vite.config.ts so studio-side tests (e.g. the markdown
// round-trip suite, which runs under jsdom) resolve shared platform-pure modules.
export default defineConfig({
  resolve: { alias: { '@core': fileURLToPath(new URL('./src', import.meta.url)) } },
  // Every DB-backed test spins up its own temp libSQL file + runs migrations inside the
  // test body; each is <1s locally. But CI runs all ~43 files in parallel forks on a 2-core
  // ubuntu-latest, so a trivially-fast test can be CPU-starved past the tight 5000ms default
  // and flake with a spurious "timed out" (seen on wiki_get-by-slug). Give real headroom —
  // genuine hangs still fail, just later.
  test: { testTimeout: 20000, hookTimeout: 20000 },
})
