# braincontext-cli — Progress

Tracking project progress across milestones. Update as work lands.

## v1 — barebones (current)

Stack: ESM + TypeScript · commander · better-sqlite3 + Kysely · FTS5 · ULID · zod · tsup · vitest · Biome. Binary: `bctx`.

- [x] Project scaffolding (package.json, tsconfig, tsup, biome, .gitignore)
- [x] Shared `core/` data layer (db, paths, types, migrate)
- [x] Schema migration `0001_init` (contexts, tags, FTS5 + triggers, history, skill_files)
- [x] Context CRUD + FTS search with soft-delete and append-only history
- [x] CLI commands: `init`, `add`, `get`, `list`, `update`, `rm`, `search`
- [x] Bundled CLI skills + progressive disclosure (`bctx skills [get|path] --full`)
- [x] Strong inline help (`--help`, examples) on every command
- [x] Bundled skill docs: `skills/braincontext/SKILL.md` + `references/*`
- [x] Vitest coverage for core CRUD/search/delete (6 tests passing)
- [x] Verified end-to-end: typecheck + lint + build + smoke test of the `dist/` bundle (init/add/get/list/search/update/rm + skills progressive disclosure)

> Global linking: `pnpm link --global` needs pnpm's global bin dir. If it errors with
> `ERR_PNPM_NO_GLOBAL_BIN_DIR`, run `pnpm setup` once (sets `PNPM_HOME` + PATH), then re-link.
> Until then, run the CLI via `pnpm dev <args>` or `node dist/cli.js <args>`.

## v1.5 — deferred (next up)

These were intentionally cut from v1 to keep it barebones. The schema + shared
`core/` layer were designed so each can be added **without a breaking migration**.

- [ ] **MCP server** (`bctx mcp`) exposing tools (context_search/get/list/create/update/delete) + a resource, so Claude/Cursor/Codex read the same store natively — the literal "multiple agents" promise.
- [ ] **Markdown export** materializing `CLAUDE.md`, `AGENTS.md`, `.cursor/rules/*.mdc`, and `SKILL.md` dirs so file-only agents get context.
- [ ] **Full DB-stored SKILL.md bundles**: use the reserved `skill_files` table for sidecar scripts/assets, enforce SKILL.md frontmatter rules (kebab name == folder), add `bctx skill add/export`.
- [ ] **Semantic search**: `sqlite-vec` embeddings + hybrid FTS5 + vector retrieval (RRF reranking). Store embedding model name + dimension for portability.
- [ ] **Knowledge-graph relations** (entities/relations/observations) for connected context, à la the MCP memory server.
- [ ] **Bidirectional markdown round-trip** so edits agents make in exported files flow back into the DB.

## Notes / decisions

- **Driver:** better-sqlite3 over `node:sqlite` because the latter is still experimental on Node 22–24 and lacks migration-tool support; revisit on Node 26.
- **Query layer:** Kysely (zero-dep, whole-query type-safety, built-in migration runner) over Drizzle for a barebones tool.
- **Concurrency:** WAL mode + short transactions + history/soft-delete make multi-agent writes recoverable.
- **Anti-drift rule:** every surface calls `core/`, never raw SQL.
