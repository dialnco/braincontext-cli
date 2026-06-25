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

Stack additions: `@modelcontextprotocol/sdk@1.29.0` · `yaml@2.9.0`. (skill_files BLOB schema, later folded into `0001_init` — see v2.) zod stays at 4.x.

- [x] **MCP server** (`bctx mcp`) — stdio server with full-CRUD tools (`search/get/list/create/update_context` + soft-only `delete_context`) + a `bctx://context/{id}` resource. stdout is protocol-only; logs to stderr; long-lived DB.
- [x] **Markdown export** (`bctx export`) — AGENTS.md (sections by kind, canonical), CLAUDE.md (`@AGENTS.md` bridge), `.cursor/rules/*.mdc` (one per rule, 3-field frontmatter). Idempotent `<!-- BEGIN/END braincontext-cli -->` fences; `--out/--targets/--dry-run/--check`.
- [x] **Full SKILL.md bundles** (`bctx skill add|export|list`) — import a SKILL.md dir into a `kind='skill'` row + `skill_files` sidecars (BLOB + exec bit); strict `name==folder` kebab validation; faithful export with binary round-trip and `chmod +x scripts/`.
- [x] `yaml`-based frontmatter parse/serialize (`src/lib/frontmatter.ts`); replaced the home-grown parser.
- [x] Vitest coverage for all three (mcp / export / skillbundle / frontmatter); 18 tests passing.
- [x] Verified end-to-end on the `dist/` bundle: export dry-run/write/check, skill add→list→export round-trip (exec bit restored), and a real `bctx mcp` stdio handshake (clean stdout, 6 tools, resource).

## v2 — Wiki subsystem (shipped)

Replaces the previously-deferred "semantic search (vectors)" and "knowledge-graph relations" with a Karpathy-style **LLM wiki**: interlinked markdown **pages** + typed **links** (the graph), retrieved via FTS5/BM25 + link navigation — **no embeddings**. Greenfield: the whole schema is one base `0001_init` (0002 folded in). Stack: `yaml` reused for frontmatter.

- [x] **Schema** folded into `0001_init`: `contexts.page_type` + `contexts.slug` (unique among pages), `links` (typed edges; `to_id NULL`+`to_title` = wanted link), `wiki_log`. FTS untouched.
- [x] **Default-exclude boundary**: `listContexts`/`searchContexts` default to `pageScope:'context'` (`page_type IS NULL`) — wiki pages never leak into `list`/`search`/AGENTS.md export/MCP. `--include-wiki` opts in. Regression-guarded by tests.
- [x] **`core/wiki.ts`**: createPage/recordSource/getPage(BySlug/ByTitle)/updatePage(source-immutable)/listPages/searchPages, addLink/removeLink/outbound/backlinks, `[[Title]]` auto-sync (`references` channel), appendLog/listLog, and `lint`.
- [x] **`bctx wiki`**: new/get/show/link/unlink/backlinks/search/index/log/ingest/lint/export/import. Ingest is mechanical (store source + log + checklist); the agent synthesizes.
- [x] **MCP**: `wiki_search/get/new/link/ingest/lint` (6 tools) + `bctx://wiki/{id}` resource.
- [x] **Schema-layer skill** `skills/braincontext-wiki/` (SKILL.md + references/{structure,ingest,query,lint}) — the "disciplined maintainer" doc.
- [x] **Export/import** Obsidian-compatible markdown (`[[Title]]`↔`[..](slug.md)`, index.md + log.md), idempotent round-trip.
- [x] Vitest: wiki / lint / export-import / regression-guard / mcp-wiki (31 tests passing).
- [x] Verified end-to-end on the `dist/` bundle: ingest→pages→links→lint, list regression guard, index/log, export→import, and a real `bctx mcp` wiki-tool handshake.

## v3 — Bidirectional markdown round-trip (shipped)

A **manual** files→DB sync (never auto-sync) for non-wiki contexts.

- [x] **`store` export format** — `bctx export --targets store --out ./ctx` writes one identity-bearing `.md` per context (frontmatter `id/kind/namespace/scope/title/tags/agent` + body). Reuses the `PlannedFile` diff machinery (`--dry-run`/`--check`). `store` is opt-in (not in the default targets); wiki pages + deleted are excluded by `selectContexts`.
- [x] **`bctx import <dir>`** — matches files→contexts by frontmatter **id**: edits → update (title/body/tags via add/remove diff, metadata merged), new files (no id) → create (honoring a provided id), missing files → **kept by default**, soft-deleted only with `--prune`. `--prune` is **scoped to the namespaces present in the files** (a partial export never deletes other namespaces). `--dry-run` previews; ids resolving to wiki pages are skipped.
- [x] One `core` change: optional `id` on `CreateInput` (`createContext` uses `input.id ?? ulid()`).
- [x] New files: `src/export/store.ts`, `src/sync/import.ts`, `src/commands/import.ts`; edits to `export/write.ts` (+`store` target), `commands/export.ts`, `cli.ts`.
- [x] Vitest `test/sync.test.ts` (round-trip id-honored, edit→update, create, namespace-scoped prune, dry-run, wiki-safety); 36 tests passing.
- [x] Verified end-to-end on the `dist/` bundle: export store → edit a file → dry-run → import (get reflects edit) → delete file kept → `--prune` soft-deletes; plain `list`/wiki unaffected.

### Still deferred (v4)

- [ ] Optional vector/semantic retrieval (`sqlite-vec`) — out of scope per the wiki direction; could augment `wiki search` later.
- [ ] `store` round-trip currently syncs title/body/tags (+merge metadata); `kind`/`namespace`/`scope` are treated as immutable identity. Could extend to sync structural fields if needed.

## Hardening — multi-agent audit pass (shipped)

A 9-agent audit (6 dimension auditors → adversarial skeptic + completeness critic → synthesis) found and we fixed:

- **Security:** skill-bundle symlinks no longer followed (no file exfiltration); crafted wiki `slug` is slugified (no path traversal on export); skill reconstruct has a path-traversal guard; `.mdc` `globs` collapsed to one line + hardened `yamlScalar` (no YAML-frontmatter injection).
- **Data-loss / correctness:** `import --prune` now scoped by an export **manifest** (`.braincontext-export.json`) and refused when scope is unknown (no accidental namespace wipe); wiki `export` deletes stale files (deleted pages can't resurrect); managed-block replace uses a function replacer (`$`-patterns no longer corrupt bodies); creating a page now **resolves pre-existing wanted links** (no permanent phantom orphans).
- **Firewall:** by-id context surfaces (`bctx get/update/rm`, MCP `get/update/delete_context`, the context resource) reject wiki pages → added `bctx wiki rm`; source pages stay immutable everywhere.
- **Robustness:** `searchContexts` tolerates FTS5-special input (sanitized fallback, never crashes) and honors `includeDeleted`; `references` reserved for the auto channel (explicit links survive body re-sync); CRLF/BOM frontmatter parsed; bad files skipped (not fatal) on import; `.cursor/rules` filenames de-duped; CLI int options validated; zod errors print cleanly; lint excludes edges from soft-deleted pages; provenance timestamps + source `uri` preserved on wiki re-import; skill exec-bit honored faithfully.
- Coverage: `test/audit.test.ts` (11 regression tests) added; **47 tests** total, all gates green.

## Notes / decisions

- **Driver:** better-sqlite3 over `node:sqlite` because the latter is still experimental on Node 22–24 and lacks migration-tool support; revisit on Node 26.
- **Query layer:** Kysely (zero-dep, whole-query type-safety, built-in migration runner) over Drizzle for a barebones tool.
- **Concurrency:** WAL mode + short transactions + history/soft-delete make multi-agent writes recoverable.
- **Anti-drift rule:** every surface calls `core/`, never raw SQL. (MCP, export, and skill bundles all go through `core/`.)
- **MCP SDK:** `@modelcontextprotocol/sdk@1.29.0` (stable) supports zod 3 **and** zod 4 via its compat layer — kept zod 4, no pin. Avoided the `@modelcontextprotocol/server` 2.x alpha. Raw-shape `inputSchema` (not `z.object`). stdout reserved for protocol; all logs to stderr.
- **Export bridge:** AGENTS.md is canonical; CLAUDE.md only imports it (`@AGENTS.md`) since Claude Code doesn't read AGENTS.md — single source of truth, no drift. Cursor `globs` emitted as an unquoted CSV string (not a YAML list), per spec.
- **Skill storage:** `skill_files.content` is BLOB + `is_executable` so binary `assets/` round-trip and `scripts/` stay executable. Full frontmatter stored losslessly in the context's `metadata` JSON.
- **Greenfield migrations:** no incremental/back-compat migrations — the full schema lives in one base `0001_init`; schema changes re-baseline (reset the DB). This collapsed the planned `0003_wiki` ADD-COLUMN/rollback work.
- **Wiki = no embeddings:** retrieval is FTS5/BM25 + the typed `links` graph (the graph *is* the knowledge graph). Pages reuse `contexts` (FTS/history/MCP/export for free); `page_type` is the wiki marker, orthogonal to `kind`, default-excluded so legacy surfaces never regress. Sources (`page_type='source'`) are immutable. `[[Title]]` resolves case-insensitively to non-deleted pages; unresolved → wanted (lint) link. Lint joins `deleted_at IS NULL` on both endpoints and ignores edges from `index` pages.
