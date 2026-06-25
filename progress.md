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

## v1.5 — multi-agent surfaces (shipped)

Stack additions: `@modelcontextprotocol/sdk@1.29.0` · `yaml@2.9.0`. Migration `0002_skill_files`. zod stays at 4.x.

- [x] **MCP server** (`bctx mcp`) — stdio server with full-CRUD tools (`search/get/list/create/update_context` + soft-only `delete_context`) + a `bctx://context/{id}` resource. stdout is protocol-only; logs to stderr; long-lived DB.
- [x] **Markdown export** (`bctx export`) — AGENTS.md (sections by kind, canonical), CLAUDE.md (`@AGENTS.md` bridge), `.cursor/rules/*.mdc` (one per rule, 3-field frontmatter). Idempotent `<!-- BEGIN/END braincontext-cli -->` fences; `--out/--targets/--dry-run/--check`.
- [x] **Full SKILL.md bundles** (`bctx skill add|export|list`) — import a SKILL.md dir into a `kind='skill'` row + `skill_files` sidecars (BLOB + exec bit); strict `name==folder` kebab validation; faithful export with binary round-trip and `chmod +x scripts/`.
- [x] `yaml`-based frontmatter parse/serialize (`src/lib/frontmatter.ts`); replaced the home-grown parser.
- [x] Vitest coverage for all three (mcp / export / skillbundle / frontmatter); 18 tests passing.
- [x] Verified end-to-end on the `dist/` bundle: export dry-run/write/check, skill add→list→export round-trip (exec bit restored), and a real `bctx mcp` stdio handshake (clean stdout, 6 tools, resource).

### Still deferred (v2)

- [ ] **Semantic search**: `sqlite-vec` embeddings + hybrid FTS5 + vector retrieval (RRF reranking). Store embedding model name + dimension for portability.
- [ ] **Knowledge-graph relations** (entities/relations/observations) for connected context, à la the MCP memory server.
- [ ] **Bidirectional markdown round-trip** so edits agents make in exported files flow back into the DB.

## Notes / decisions

- **Driver:** better-sqlite3 over `node:sqlite` because the latter is still experimental on Node 22–24 and lacks migration-tool support; revisit on Node 26.
- **Query layer:** Kysely (zero-dep, whole-query type-safety, built-in migration runner) over Drizzle for a barebones tool.
- **Concurrency:** WAL mode + short transactions + history/soft-delete make multi-agent writes recoverable.
- **Anti-drift rule:** every surface calls `core/`, never raw SQL. (MCP, export, and skill bundles all go through `core/`.)
- **MCP SDK:** `@modelcontextprotocol/sdk@1.29.0` (stable) supports zod 3 **and** zod 4 via its compat layer — kept zod 4, no pin. Avoided the `@modelcontextprotocol/server` 2.x alpha. Raw-shape `inputSchema` (not `z.object`). stdout reserved for protocol; all logs to stderr.
- **Export bridge:** AGENTS.md is canonical; CLAUDE.md only imports it (`@AGENTS.md`) since Claude Code doesn't read AGENTS.md — single source of truth, no drift. Cursor `globs` emitted as an unquoted CSV string (not a YAML list), per spec.
- **Skill storage (0002):** `skill_files.content` is BLOB + `is_executable` so binary `assets/` round-trip and `scripts/` stay executable. Table was empty everywhere → safe migration. Full frontmatter is stored losslessly in the context's `metadata` JSON.
