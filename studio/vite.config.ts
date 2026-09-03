import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Pin `root` to this file's directory so `vite build -c studio/vite.config.ts`
// resolves index.html here regardless of the cwd it is invoked from. Using
// `new URL('.', import.meta.url)` is robust to how Vite loads the TS config.
const root = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const repoSrc = fileURLToPath(new URL('../src', import.meta.url))

export default defineConfig({
  root,
  // SPA mounted at origin root; absolute /assets/... paths resolve at any client
  // route depth (server does history fallback to index.html for unknown routes).
  base: '/',
  plugins: [react()],
  // `@core/*` = the CLI's `src/*`, so ONE platform-pure module (e.g. lib/mdtable.ts)
  // is shared by both runtimes instead of a hand-mirrored copy. Rollup follows the
  // import graph on build; the dev server needs `fs.allow` to serve outside `root`.
  resolve: { alias: { '@core': repoSrc } },
  build: {
    // -> <repo>/dist/studio, served by `bctx studio`. outDir is OUTSIDE root, so
    // Vite requires emptyOutDir to clean it.
    outDir: '../dist/studio',
    emptyOutDir: true,
    // Off for the same reason as tsup.config.ts: the map shipped in the npm
    // tarball and dwarfed the bundle it described.
    sourcemap: false,
  },
  server: {
    // `pnpm studio:dev` HMR server; proxy same-origin API calls to a running
    // `bctx studio` backend so the dev SPA hits the real DB.
    port: 5173,
    fs: { allow: [repoRoot] }, // serve shared modules under ../src during dev
    proxy: { '/api': 'http://127.0.0.1:8420' },
  },
})
