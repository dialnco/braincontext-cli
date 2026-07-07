import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// `@core` mirrors studio/vite.config.ts so studio-side tests (e.g. the markdown
// round-trip suite, which runs under jsdom) resolve shared platform-pure modules.
export default defineConfig({
  resolve: { alias: { '@core': fileURLToPath(new URL('./src', import.meta.url)) } },
})
