# braincontext-cli — Progress

Tracking project progress across milestones. Update as work lands.

## Studio datatable safety — confirm-delete + persistent undo/redo (shipped 2026-07-05)

Prompted by an accidental whole-column delete in the Studio datatable grid (record
`01KWT8482F8MX19ZPW8WYBN868`, **indicadores-clave-edumetrics** lost its `Fuente` column). The
grid's delete-column fired with no confirmation and no undo. Recovered the column losslessly from
`context_history` (the pre-delete `old_body`, byte-identical to the post-extract backup) via
`wiki update --file --agent recovery`, then added two speed-bumps. No schema/migration — restores
reuse the existing `event='update'` history rows, labeled via `agentSource`.

- [x] **Generic `ConfirmDialog`** (`studio/src/components/common/ConfirmDialog.tsx`) — reuses the
  ConfirmDeleteDialog scrim convention (inline `z-index:80` scrim, `mw-fade`/`mw-pop`,
  Escape/scrim-click cancel) without the delete-specific soft/hard checkbox. `destructive` flag
  toggles red vs accent confirm button.
- [x] **Confirm before deleting a column** — the datatable grid's header `×` now opens
  `ConfirmDialog` ("Remove '<col>' and all N of its cells? You can undo with ⌘Z.") instead of
  firing the splice immediately. Cancel keeps the table; Confirm deletes.
- [x] **Persistent, history-backed undo/redo** (⌘Z / ⌘⇧Z) in the grid — a client-owned revision
  timeline (`histRef`/`curRef` in `DataTableEditor`) built from `wikiApi.history` `newBody`
  snapshots, rebuilt only on pageId change / 409 (never oscillates over its own restore writes).
  Undo/redo issue a labeled `updatePage` (`agentSource:'undo'|'redo'`) via the same `ifRev` CAS
  path → server-persisted, survives reload. Routed from WikiView's document keydown only while a
  datatable grid is mounted (`dtHandleRef !== null`); prose keeps native ⌘Z.
- [x] **Clickable History-panel restore** (all page types incl. prose) — RightPanel History rows
  gain a "↩ Restore" affordance (older revisions only) → `ConfirmDialog` →
  `onRestoreRevision(entry)` = `wikiApi.update(id, {body: entry.newBody, ifRev: page.rev,
  agentSource:'restore'})` → `detail.reload()`. Restoring a datatable reseeds the grid; a prose
  revision re-renders the editor.
- [x] **`ifRev` + `agentSource` threaded** on whole-body writes: `studio/src/api/wiki.ts`
  `UpdatePageInput` + `src/studio/routes/wiki.ts` `updatePageBody` zod (`agentSource` optional),
  passed into `updatePage`. Stale `ifRev` → 409 `{currentRev}`.
- [x] **Tests + gate**: extended `test/studio-api.test.ts` (PATCH stale-`ifRev` → 409; a
  `body`+`ifRev`+`agentSource:'restore'` write succeeds and appends a labeled history row). Full
  gate green (typecheck + typecheck:studio + lint + 222 tests + build). Browser E2E on a seeded
  isolated store verified all four: (a) delete-column confirm (Cancel keeps / Confirm deletes),
  (b) grid ⌘Z/⌘⇧Z step through revisions with server body matching + persist across reload,
  (c) History "Restore" reverts a prose page, (d) `undo`/`redo`/`restore` labels appear in History.
- [x] **Datatable keeps the sidebar** — the datatable view now forces the `'dual'` layout
  (sidebar + full-width grid) instead of `'focus'`, so the wiki stays navigable from a datatable;
  the right panel still auto-hides for grid width, and the three-pane layout restores on exit.
  Browser-verified the round-trip (datatable ⇄ prose sidebar navigation) keeps the sidebar and
  restores the right panel off-datatable.
- [x] **Remove an embedded datatable from a page** — a `![[Title]]` embed rendered in the prose
  editor (`WikiEditor`) now carries a "✕ Remove" button in its header (and on the unresolved
  `⚠ no page titled …` note), gated by a `ConfirmDialog` ("only this reference is removed — the
  datatable itself is kept"). Confirm removes the `contenteditable=false` embed node and
  `persist()`+`flush()`es the whole-body PATCH, which drops the `![[Title]]` marker and re-derives
  the `embeds`/`wanted` links server-side. Button hidden on read-only pages. Browser-verified:
  resolved + unresolved embeds both removable, marker dropped from the stored body, the referenced
  datatable page + its rows survive, LINKS re-derived, and Cancel keeps the embed.
- [x] **Fix: embed shows "no page titled" on hard reload** — `WikiEditor.hydrateEmbeds` resolved
  `![[Title]]` against the `pages` prop, but on a hard reload the load effect hydrates before the
  pages list finishes loading, so the embed fell back to the unresolved note AND eagerly set
  `data-embed-hydrated`, locking it in until a full HTML rebuild (nav away/back). Fix: don't mark
  hydrated when `pages` is still empty, and add a `[pages]` effect that re-runs `hydrateEmbeds`
  when the list arrives (already-resolved nodes are skipped). Reproduced deterministically with a
  15s one-shot delay on the pages-list fetch (temp `dist/studio/index.html` shim, since removed):
  embed = NOTE while pages loading → flips to TABLE the instant pages resolve, no navigation.

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

### Out of core scope — potential future `plugins`

Not part of the core app. The core stays embedding-free: retrieval is FTS5/BM25 + the
typed `links` graph (the wiki direction). These belong in an optional plugin layer if/when
one exists, so a user can opt into heavier deps without bloating the local-first core.

- [ ] **Embeddings / semantic retrieval** (e.g. `sqlite-vec`) — vector search as an opt-in plugin that could augment `wiki search`. Explicitly **not** a core feature.

### Known limitations (by design — not addressable as bugs)

- **`store` round-trip syncs content, not identity.** On import-update, only `title`/`body`/`tags` (+merged `metadata`) flow back; `kind`/`namespace`/`scope`/`id` are treated as immutable structural identity (edits to them in a store `.md` are ignored on update — though all are honored on *create*). This is intentional: those axes file contexts for export-by-kind, `list --namespace`, the wiki firewall, and `--prune` scoping, so re-homing a row must be deliberate, not a side effect of a text edit. Confirmed correct.

## Hardening — multi-agent audit pass (shipped)

A 9-agent audit (6 dimension auditors → adversarial skeptic + completeness critic → synthesis) found and we fixed:

- **Security:** skill-bundle symlinks no longer followed (no file exfiltration); crafted wiki `slug` is slugified (no path traversal on export); skill reconstruct has a path-traversal guard; `.mdc` `globs` collapsed to one line + hardened `yamlScalar` (no YAML-frontmatter injection).
- **Data-loss / correctness:** `import --prune` now scoped by an export **manifest** (`.braincontext-export.json`) and refused when scope is unknown (no accidental namespace wipe); wiki `export` deletes stale files (deleted pages can't resurrect); managed-block replace uses a function replacer (`$`-patterns no longer corrupt bodies); creating a page now **resolves pre-existing wanted links** (no permanent phantom orphans).
- **Firewall:** by-id context surfaces (`bctx get/update/rm`, MCP `get/update/delete_context`, the context resource) reject wiki pages → added `bctx wiki rm`; source pages stay immutable everywhere.
- **Robustness:** `searchContexts` tolerates FTS5-special input (sanitized fallback, never crashes) and honors `includeDeleted`; `references` reserved for the auto channel (explicit links survive body re-sync); CRLF/BOM frontmatter parsed; bad files skipped (not fatal) on import; `.cursor/rules` filenames de-duped; CLI int options validated; zod errors print cleanly; lint excludes edges from soft-deleted pages; provenance timestamps + source `uri` preserved on wiki re-import; skill exec-bit honored faithfully.
- Coverage: `test/audit.test.ts` (11 regression tests) added; **47 tests** total, all gates green.

## v4 — Multi-project + online sync (shipped)

The North Star foundation: one project's context shared across sessions, devices, and
members. **Driver swapped to libSQL** (`@libsql/client` + `@libsql/kysely-libsql`),
replacing better-sqlite3 — one URL-driven driver covers local files, embedded replicas,
and remote connections, so "go online" is a config change, not a rewrite. No auth yet.

- [x] **libSQL driver** — `src/core/db.ts` is now `openStore(DbTarget)` over `@libsql/client` (local file / embedded replica / remote), `withDb` syncs a replica before/after the op (`--no-sync` to skip), and `close()` tears down both Kysely and the client. The whole schema (FTS5 external-content + triggers + `bm25()`) validated on libSQL — **Phase 0 risk cleared**. Tests run on a temp **file** db (libSQL recreates its connection per transaction, which discards a `:memory:` db). BLOBs (skill files) normalized from ArrayBuffer → Buffer.
- [x] **Project registry** — `src/core/registry.ts`: `~/.braincontext/config.json` (projects + currentProject) and `credentials.json` (tokens, `0600`, **never** in config.json); the legacy global `store.db` auto-registers as the `default` project. `resolveTarget` precedence: `--db`/`BCTX_DB` > `--global`/`--local` > `--project`/`BCTX_PROJECT` > current project > cwd `./.braincontext` > default. Global `--project`/`--no-sync` flags added.
- [x] **`bctx project`** — `create`/`list`/`use`/`current`/`path`/`rm` (local) + `migrate-online`/`link`/`sync`/`status`/`disconnect` (online). `migrate-online` seeds a fresh remote primary from the local store (faithful, ids preserved — `src/core/dump.ts`), then re-bootstraps the local file as an embedded replica; `link` attaches another device to the same remote.
- [x] **Sync semantics** — write-through to one primary (serialized → no multi-master conflict); distinct-ULID inserts merge, same-row edits are last-writer-wins with history retained. Online writes need connectivity (offline-write reconciliation deferred).
- [x] Vitest: `test/registry.test.ts` (precedence, token isolation + 0600, default seed) and `test/online.test.ts` (FTS5 lock + faithful remote seed); **59 tests** total, all gates green.
- [x] Verified end-to-end on `dist/`: project create/use/isolation/`--project` override/status/path/rm (local). The replica/sync round-trip needs a real `libsql://` remote (manually verifiable); the seed (its core) is unit-tested.

> **Auth/permissions = North Star, not built.** Future managed control-plane: accounts,
> project membership, RBAC (owner/editor/viewer), and server-minted scoped tokens
> (`bctx login`, `bctx project share … --role editor`). Reuses `agent_source` +
> `context_history` for attribution/audit. **Phase 3:** offline-write reconciliation
> (Turso CDC / `updated_at` merge). **S3/R2** = backup only, never a sync backend.

## Concurrency hardening — multi-agent stress pass (shipped)

A 5-dimension concurrency-hazard audit + a multi-process stress harness
(`scripts/stress/`) drove these fixes. Stress harness spawns N independent OS
processes (each its own libSQL connection = one "agent") and verifies data-integrity
invariants after the burst; a companion remote harness hits a real Turso primary.

- **The bleed (CRITICAL):** the libSQL swap had dropped WAL + busy_timeout, so concurrent writers failed instantly with `SQLITE_BUSY` (562/1067 ops failed at 8 workers). Fixed in `src/core/db.ts`: `journal_mode=WAL` (file-header-persistent) + libSQL Config `timeout: 5000` (busy_timeout that survives the client's per-transaction reconnect) + `src/core/tx.ts` `withWriteRetry` (capped backoff on busy/locked) around every write transaction.
- **Migration race (CRITICAL):** Kysely's migration lock is a no-op on SQLite/libSQL, so concurrent first-runs crashed with "table already exists" (all workers died, 0 rows). Fixed in `src/core/migrate.ts`: a fast `isCurrent` pre-check (steady-state skips the migrator), a cross-process `O_EXCL` lockfile (`src/core/lock.ts`) so only one process migrates a local file, idempotent `IF NOT EXISTS` DDL, and benign-race tolerance for the remote path.
- **Lost updates (HIGH):** `updateContext`/`deleteContext` read the row OUTSIDE the transaction → concurrent edits clobbered each other and the audit `old_body` was wrong. Fixed: the read-modify-write now happens entirely inside the IMMEDIATE transaction; writes return an in-memory object (no stale replica read-back, fixing the replica read-your-writes gap too).
- **Missing UNIQUE constraints (HIGH):** added (in `0001_init`) partial unique indexes for resolved links `(from_id,type,to_id)`, wanted links `(from_id,type,lower(to_title))`, and one live skill per `(kind,title,namespace)`; `addLink`/`context_tags` inserts use `onConflict doNothing`; `syncBodyLinks`/`resolveWantedLinks` are now atomic; `createPage`/`recordSource` retry on the slug-uniqueness race.
- **In-process write serialization (found via stress):** libSQL opens a fresh connection per `transaction()`, so *concurrent* writes from one process (e.g. the long-lived MCP connection handling concurrent tool calls) become many same-file connections — which SQLite's same-process locking handles poorly (5s busy stalls, even lost updates). `src/core/tx.ts` now chains writes per Kysely instance (one in-flight writer per connection): 40 concurrent writes went from a 5s timeout to **42ms**, 30 concurrent `setMetadata` on one row keep all 30 keys. Cross-process concurrency is unaffected (separate instances; busy_timeout + WAL coordinate).
- **Verified — local:** 16 workers × 200 ops × 3 phases = **9,600 ops, 0 failures**; plus lost-update (1200 concurrent setMetadata on one row → **0 keys lost**, history chain intact), wiki (589 concurrent pages, **0 duplicate links**), skill (1200 concurrent imports of 3 names → exactly **3 live skills**). FTS integrity-check passes throughout.
- **Verified — remote (Turso):** 5 concurrent clients CRUD the primary (0 failures, FTS works remotely); 3 replicas write-through + a fresh replica bootstrap **all converge to the identical set**.
- **Registry & bootstrap atomicity (MEDIUM):** `config.json`/`credentials.json` writes are now atomic (temp-file + `rename`, `src/core/registry.ts`) so a concurrent `project` command can't read a half-written/truncated registry; `migrate-online`/`link` run under a cross-process bootstrap lockfile so two concurrent runs can't double-seed.
- Coverage: `test/concurrency.test.ts` (concurrent first-run migration, concurrent writes serialize, lost-update guard). **62 tests**, all gates green.

> **Known limitation (replica single-owner):** an embedded-replica file should have one
> active syncer at a time. Running a long-lived `bctx mcp` on a replica project *and*
> concurrent CLI commands against the same replica file (two independent syncers to one
> file) is unsupported and can corrupt the local replica — use separate replica files
> (devices) or route through the one MCP connection. The remote primary is always safe.

## v5 — Studio web UI (shipped)

The human-facing surface: `bctx studio` now serves a full read/write SPA over the
store, replacing the 1065-line mock "personal wiki" reference component with a
decomposed app bound to the braincontext domain (wiki pages + typed links as the
primary workspace, a Contexts tab for note/rule/snippet/decision/skill, an in-UI
project switcher). Keeps the reference's warm paper/Spectral aesthetic; only the
data/taxonomy changed. localhost-only, no auth (writes go through `core/`).

- [x] **Backend API** — `src/studio/server.ts` is now a thin Hono mount over focused
  route modules (`src/studio/routes/{health,contexts,wiki,projects,tags}.ts`) + `http.ts`
  helpers; full CRUD/search/history for contexts, pages CRUD + links/backlinks/graph/log
  for wiki, `/api/projects` + switch/sync. Every handler calls `core/` (anti-drift held).
- [x] **StoreManager** (`src/studio/stores.ts`) — a `StoreProvider` injected into the app
  so a runtime project switch swaps the live db under every handler (serialized, opens the
  next store before closing the old; replica single-owner preserved). Tests use a trivial
  `staticProvider` over `freshDb()`.
- [x] **Core additions** — `listTags`/`listHistory` (`core/contexts.ts`), `wikiGraph`
  (`core/wiki.ts`); `updatePage` already re-syncs `[[..]]` links on body PATCH.
- [x] **Frontend decomposition** — god file → `studio/src/{api,lib,state,components,editor,views}`:
  typed API client + DTOs, pure libs (markdown ⇄ html, wikilinks, force-graph, editor
  blocks, theme), hash router + context + hooks, and components for sidebar/topbar/palette/
  project-switcher/editor/backlinks/graph/contexts. No heavy state lib. `@ts-nocheck` dropped;
  biome a11y relaxed for the inline-styled SPA only.
- [x] **Editor** — contenteditable with slash menu, wikilink autocomplete (insert + create),
  selection toolbar, hover previews, dual markdown pane; **10s debounced autosave** flushed on
  blur / navigate / project-switch / `beforeunload` (per product decision — never per keystroke).
- [x] **AGENTS.md export preview** — `previewExport` (`src/export/preview.ts`, filesystem-free,
  reuses `renderAgentsBody`/`renderClaudeBody`/`renderMdc` + canonical managed block) behind
  `GET /api/export/preview?targets`; Contexts tab gets an **Export** toggle → read-only tabbed
  view of AGENTS.md / CLAUDE.md / .cursor/rules/*.mdc with copy-to-clipboard. Nothing is written.
- [x] Vitest: `test/studio-api.test.ts` (contexts CRUD+search+history, wiki pages/links/backlinks/
  graph/resolve + `[[..]]` autosync, export preview, projects/tags) via `app.request()`; **71 tests** total, green.
- [x] **Verified end-to-end in a real browser** (agent-browser, isolated `BCTX_HOME`): page nav +
  hash deep-links, edit → 10s autosave → DB-persisted, `[[..]]` autocomplete → insert → server
  link-sync, graph (constellation/local/by-type), backlinks/properties, contexts list/filter/edit/
  delete, export preview (AGENTS.md + .cursor rendering), ⌘K palette, theme toggle, Wiki↔Contexts
  tabs, project switcher. Two bugs found+fixed (double-hash routing; contexts-tab redirect bounce).

## Notes / decisions

- **Driver:** **libSQL** (`@libsql/client`) since **v4** — one URL-driven driver covers local files, embedded replicas, and remote primaries, so "go online" is a config change, not a rewrite. (v1–v3 used **better-sqlite3**; `node:sqlite` was skipped as still-experimental on Node 22–24 with no migration-tool support — revisit on Node 26.)
- **Query layer:** Kysely (zero-dep, whole-query type-safety, built-in migration runner) over Drizzle for a barebones tool.
- **Concurrency:** WAL mode + short transactions + history/soft-delete make multi-agent writes recoverable.
- **Anti-drift rule:** every surface calls `core/`, never raw SQL. (MCP, export, and skill bundles all go through `core/`.)
- **MCP SDK:** `@modelcontextprotocol/sdk@1.29.0` (stable) supports zod 3 **and** zod 4 via its compat layer — kept zod 4, no pin. Avoided the `@modelcontextprotocol/server` 2.x alpha. Raw-shape `inputSchema` (not `z.object`). stdout reserved for protocol; all logs to stderr.
- **Export bridge:** AGENTS.md is canonical; CLAUDE.md only imports it (`@AGENTS.md`) since Claude Code doesn't read AGENTS.md — single source of truth, no drift. Cursor `globs` emitted as an unquoted CSV string (not a YAML list), per spec.
- **Skill storage:** `skill_files.content` is BLOB + `is_executable` so binary `assets/` round-trip and `scripts/` stay executable. Full frontmatter stored losslessly in the context's `metadata` JSON.
- **Greenfield migrations:** no incremental/back-compat migrations — the full schema lives in one base `0001_init`; schema changes re-baseline (reset the DB). This collapsed the planned `0003_wiki` ADD-COLUMN/rollback work.
- **Wiki = no embeddings:** retrieval is FTS5/BM25 + the typed `links` graph (the graph *is* the knowledge graph). Pages reuse `contexts` (FTS/history/MCP/export for free); `page_type` is the wiki marker, orthogonal to `kind`, default-excluded so legacy surfaces never regress. Sources (`page_type='source'`) are immutable. `[[Title]]` resolves case-insensitively to non-deleted pages; unresolved → wanted (lint) link. Lint joins `deleted_at IS NULL` on both endpoints and ignores edges from `index` pages.

## v6 — Hardening & adoption (P0–P3 shipped)

A second multi-agent **double-check** after v5 (an 11-dimension fan-out, **73 agents**, every
finding independently adversarially verified — refuted/duplicate dropped) surfaced **62
findings: 0 critical, 8 high, 26 medium, 27 low**. The core is sound (per-instance write
serialization, IMMEDIATE-txn read-modify-write, correct FTS triggers, real path-traversal
guards, 0600 credentials, anti-drift through `core/`). The weaknesses cluster in the
unauthenticated **Studio HTTP surface**, a handful of **data-loss edges**, the
**retrieval/adoption loop** that makes context actually compound, and **doc drift**. This
milestone now ships **all P0, P1, P2, and P3** below (each behavioural fix with a regression
test). Full gate green — **104 tests** across 21 files — verified on the real binary
(`init`/`add`/`export`/`update`/`wiki`/`status`/`export --watch`) and a live Studio server
(percent-malformed path → 400, cross-origin POST + rebind Host → 403). Version bumped to
**0.6.0**; CI added. Two items are intentionally **not** shipped and remain backlog: the
namespace-default-to-project taxonomy change (semantic, needs design) and jsdom client-side
React-hook tests (the data-loss-critical round-trip is covered server-side instead).

### Known correctness bug (root-caused; fixed in v6 P0)

- **`ON DELETE CASCADE` silently never fires.** `prepare()` sets `PRAGMA foreign_keys = ON`
  on the main connection only, but libSQL's sqlite3 client drops/reopens its connection per
  `transaction()` (the same reason `busy_timeout` had to move to the client `Config`, see
  `db.ts:24-29`). So inside any write transaction `foreign_keys` is OFF and cascades don't
  run — `skills.ts` re-import (`// cascades skill_files`) orphans the prior bundle's
  `skill_files` BLOBs. Fix: never rely on CASCADE in app code; delete sidecars explicitly
  inside the txn (audit `links`/`context_tags` too).

### P0 — Security & data-loss (shipped)

- [x] **Studio CSRF / DNS-rebinding:** the no-auth localhost read/write API had no
  `Host`/`Origin` validation → a visited web page could CSRF-write (Hono parses any
  content-type, so a `text/plain` simple-request POST needs no preflight) or DNS-rebind to
  read the store; injected contexts later flow into `AGENTS.md`/`CLAUDE.md` =
  prompt-injection. Added a `Host`+`Origin` allowlist middleware (`src/studio/server.ts`),
  regression-tested (`test/studio-api.test.ts`) + verified on a live server (403 on
  cross-origin POST + rebind Host).
- [x] **`wiki export <dir>` deleted unrelated `.md`** in the target dir — deletes are now
  scoped to tool-written files (wiki `slug`+`type` frontmatter); hand-authored markdown
  (README/AGENTS.md) is never touched (`src/wiki/export.ts`).
- [x] **`import --prune` deleted contexts whose file failed to parse** — now refuses to prune
  when any file is unparseable (`src/sync/import.ts`).
- [x] **CASCADE orphan bug** (above) — explicit child-row deletes via a shared
  `deleteContextChildren` (`src/core/contexts.ts`), used by `skills.ts` re-import and hard
  delete; test asserts 0 orphaned `skill_files`.
- [x] **Studio editor data-loss windows** — `beforeunload` now prompts on dirty + best-effort
  saves; the editor flushes on blur and on project-switch (registered via the store's
  `registerFlush`) (`studio/src/state/useAutosave.ts`, `StoreContext.tsx`, `WikiView.tsx`).
- [x] **Leaked Turso token** — `test-config.md` gitignored, creds env-only; token rotation is
  a manual Turso-dashboard action.

### P1 — Close the compounding loop (shipped)

- [x] **`wiki_update` MCP tool** (+`wiki_unlink`, `wiki_graph`) — an MCP-only agent can now
  edit a page in place instead of spawning duplicate-titled pages; tool descriptions +
  ingest checklist nudge update-over-create (`src/mcp/wiki-tools.ts`).
- [x] **Agent self-onboarding preamble** — `export` always emits a managed AGENTS.md preamble
  ("retrieve before acting; save durable facts after; MCP available") even for an empty
  store; `init` prints the next-step hint (`src/export/render.ts`, `src/commands/init.ts`).
- [x] **`bctx status`/`doctor`** — single orient-me command: store/project/mode/location,
  counts by kind/type, links, tags, and AGENTS.md staleness (`src/commands/status.ts`).
- [x] **Env-derived `--agent`** — auto-attribute from agent env vars (or `BCTX_AGENT`) else
  `user@host`, threaded through `add` + `wiki` writes (`src/lib/agent.ts`).

### P2 — Correctness & UX edges (shipped)

- [x] `searchContexts` swallowed **all** errors as empty — now only FTS5 *syntax* errors are
  caught (and the query is sanitized + retried); busy/locked/I-O/corruption re-throw so "no
  matches" ≠ "search failed" (`src/core/contexts.ts`).
- [x] Wiki `type` filter was applied after SQL `LIMIT` → truncated; `page_type` is now pushed
  into the WHERE so `LIMIT` applies to already-filtered rows (`listPages`/`searchPages`).
- [x] Managed-block **sentinel-in-body** corrupted `AGENTS.md` & broke idempotency — `BEGIN`/
  `END` markers in rendered bodies are now neutralized with a zero-width char
  (`src/export/managed.ts`).
- [x] `export --targets store` never removed stale files → deleted contexts resurrected on
  re-import; `pruneStaleStoreFiles` now removes scope-matching files whose `id` is no longer
  live (id-less files like README/AGENTS.md are never touched) (`src/export/store.ts`).
- [x] Wiki export/import **dropped the typed-link graph** (only body `[[links]]` survived) —
  explicit links now serialize to frontmatter (`slug`/`title`) and re-create on import
  (`src/wiki/export.ts`, `src/wiki/import.ts`).
- [x] `update` can now change `kind`/`scope`/`namespace` (`--kind/--scope/--namespace`); on
  `import`, divergence in those immutable fields surfaces a **skip warning** (with the
  `bctx update` hint) instead of a silent "unchanged" (`src/commands/update.ts`,
  `src/sync/import.ts`).
- [x] Skill `loadSkill`/`skill export` now honor namespace; a bare name living in multiple
  namespaces throws with the candidates instead of exporting an arbitrary bundle
  (`src/core/skills.ts`, `src/commands/skill.ts`).
- [x] Studio SPA: blank pane after project switch fixed (redirect to first live page); read
  errors now surface an **error UI with Retry** instead of an empty state; hover-preview
  DOM-XSS sink replaced with `DOMParser`/`textContent`; autosave serialized + `beforeunload`
  guard (`studio/src/views/*`, `studio/src/state/*`, `studio/src/editor/WikiEditor.tsx`).
- [ ] **Taxonomy overload:** defaulting `--namespace` to the current project — **deferred**
  (semantic change; flagged to avoid a silent cross-project regression).

### P3 — Tests, packaging, polish (shipped)

- [x] New regression tests (104 total, +16): FTS sanitize, wiki type-pushdown-under-LIMIT,
  `removeLink` count, `update` kind/scope/namespace, managed-sentinel idempotency, store
  prune, wiki typed-link round-trip, frontmatter blank-line byte round-trip, registry
  chmod + token-collision, skill-namespace disambiguation, `withFileLockSync` steal/release,
  studio malformed-path 400. (jsdom client `useAutosave` + spawn CLI-smoke deferred — the
  latter is covered by the real-binary e2e.)
- [x] `config.json` now written `0600` and `~/.braincontext` kept `0700` (`registry.ts`).
- [x] Project token env-var collision fixed: names with `.`/`-` (which collapse to `_`) get
  **no** env override — credentials.json (keyed by exact name) is unambiguous (`registry.ts`).
- [x] Registry read-modify-write now runs under a cross-process `withFileLockSync` (no lost
  updates between concurrent `bctx project` commands) (`src/core/lock.ts`, `registry.ts`).
- [x] Stdio MCP server now exits on client disconnect (stdin EOF) so an orphaned process can't
  keep the embedded-replica write-lock (`src/mcp/run.ts`).
- [x] CLI silent-success foot-guns fixed: `--set-meta` rejects malformed pairs; `export
  --targets` errors on unknown names; `update` refuses an empty body (wipe guard); `wiki
  unlink` reports `Unlinked (n)` / `No matching link to remove`.
- [x] Wiki resource hides soft-deleted pages; frontmatter round-trips the blank line after the
  block; studio wiki PATCH returns `409` only for the immutable-source conflict (else `500`);
  studio project-switch drains in-flight requests before closing the old store.
- [x] **`bctx export --watch`** — re-exports whenever the store changes (polls + replica
  re-sync); exits promptly on Ctrl-C; closes the staleness loop (`src/commands/export.ts`).
- [x] `prepublishOnly` now runs typecheck + studio typecheck + lint + test + build via `npm`
  (not hardcoded `pnpm`); version → **0.6.0**; `.github/workflows/ci.yml` added.
- [x] `README` v4→v5 + Studio section; `LICENSE` shipped; this `progress.md` refresh.

## vNext (design) — Structured data / "datatables" (not shipped; direction locked)

A design exploration into a core mechanic — **agent-mutable structured tables** ("embed
JSON instead of markdown tables; reference across pages; let agents search/mutate rows &
fields"). Produced by a 12-agent design pass (5 independent proposals → adversarial
code-grounded verification → completeness critic → synthesis). Every claim below is
verified against the current code. **No code written yet** — this section is the direction
of record; build follows the phased plan.

### The real gap (reframing)

Retrieval got sophisticated (disclosure ladder index→`peek`→`full`, `maxTokens`,
tokenEstimate everywhere, FTS5/BM25 + link graph, no embeddings). **Mutation stayed
whole-body**: `updateContext` replaces the entire `body` column (`src/core/contexts.ts:235`)
and there is **no section/row/field patch anywhere** (CLI/MCP/Studio). Changing one cell of
a 40-row table = fetch full body, regenerate the whole table, PATCH it back (expensive
output tokens + LLM table-corruption risk). Tables are the weakest surface: opaque TEXT
server-side; the only parser is browser-only and **lossy** (drops alignment,
`studio/src/lib/markdown.ts`). **The datatable is the highest-structure instance of one
axis: sub-document addressability.**

### Verdict — YES, build it (qualified). Three qualifications are load-bearing:

1. **No sidecar `datatable_rows` table.** It empties `contexts.body`, breaking what it
   claims to inherit: `pagePeek` reads `body` (`wiki.ts:378`), `contexts_fts` mirrors only
   `title+body` (`0001_init.ts:139`), `pageFreshness` keys on `updatedAt` (`wiki.ts:293`).
   Keep canonical data **inside the single `contexts` row**.
2. **No `page_type=NULL` blocks** — excluded from `wiki_search` (`page_type IS NOT NULL`),
   so cell text becomes unfindable on the surface agents hit first.
3. **Token win is agent-I/O only, not storage.** `context_history` logs full
   `old_body`+`new_body` per update (`contexts.ts:292`); the row is the LWW sync unit.
   Realistic warm reduction **~5–15×**, not 35×; sync/history bytes flat-to-worse. Framed
   honestly, not oversold.

> Writes are whole-row LWW and `tx.ts` serializes only per-Kysely-instance (MCP/Studio/CLI
> are separate processes; Turso sync is row-LWW), so **any** fine-grained mutation API
> invites silent cross-replica clobbers of disjoint edits. The compare-and-swap guard ships
> **first**.

### Locked design decisions

- **Storage:** canonical data inside the single `contexts` row, never a sidecar. Phase 1 =
  GFM-in-`body` spliced in place (JSON *ergonomics*, zero schema change); Phase 3 = promoted
  datatable keeps canonical JSON in a fenced ```` ```bctx-table ```` block, rendered to GFM
  on read so FTS/peek stay honest.
- **Revision handle:** reuse `updatedAt` (already surfaced on every peek/get/search/resolve
  — no new column). Content-hash fallback if timestamp granularity bites.
- **Transclusion:** Obsidian-native `![[slug]]`. Prereq: `WIKILINK` regex
  `/\[\[([^\]]+)\]\]/g` has no `!` guard, duplicated in `src/lib/wikilinks.ts:1` and
  `src/wiki/export.ts:13` → add `(?<!!)` lookbehind + dedupe; route `![[..]]` into a
  reserved `embeds` link channel mirroring `references` (kept out of `LINK_TYPES`).
- **Export:** Phase 1 byte-stable (table already in `body`; one-time whitespace reflow on
  first splice). Phase 3 object → own `<slug>.md`, canonical JSON in frontmatter (`data:`) +
  rendered GFM body; pages keep `![[slug]]`. **Not** `src/export/managed.ts` (single global
  BEGIN/END can't host N id-scoped fences).
- **Flagship tools (exactly four, no query language in v1):** `wiki_table_get` /
  `_set_cell` / `_add_row` / `_delete_row`, addressed by caption/heading + column-name +
  row-key (not positional), echoing `headingAbove`+`header`; loud on ambiguous/out-of-range.

### Roadmap (full arc committed; 0–3 = the datatable arc, 4–5 earned against usage)

| Phase | Scope | Ships |
|---|---|---|
| **0 — Enabling primitives** | S | Revision-CAS + fence-aware GFM (de)serializer (`src/lib/mdtable.ts`). No user surface. |
| **1 — FLAGSHIP: inline table ops** | M | `src/core/tables.ts` cell/row splice via existing write path; `wiki_table_*` MCP + CLI. Kills the one-cell-edit pain. Zero schema change, byte-stable export. |
| **2 — Studio parity + parser unification** | M | Cell-blur endpoint → `core/tables.ts`; one shared table grammar (browser imports the pure lib). |
| **3 — First-class datatables + transclusion** | L | **Body-canonical** datatable under a searchable `page_type` (body *is* the GFM table → reuses FTS/peek/history + Phase-1 table ops, no bespoke read path); `![[Title]]` embeds via reserved `embeds` channel, inlined on read; per-file export w/ verbatim embeds. *The literal "reused across pages" ask.* |
| **4 — Typed properties + views** | L | Derive-on-write `page_properties` mirror of `metadata.props`; `wiki_query` predicate (eq/ne/lt/gt/lte/gte/in/contains/exists + numeric sort); `page_type='view'` saved queries rendered to a live GFM table. "Database OF pages". |
| **5 — General sub-body mutation** | M | `wiki_get {section}` / `wiki_patch_section` on a fence-aware heading splice + CAS; `wiki_replace {find,replace,occurrence}` exact-match-or-refuse diff-write for the prose majority. |

> **Shipped: Phases 0–5 (COMPLETE)** (200 tests green; typecheck + typecheck:studio + lint + build + real-binary e2e).
> - **Phase 0** — content-hash `rev` on every `Context` (computed in `toContext`, never
>   stored); `ifRev` compare-and-swap in `updateContext` (`RevConflictError`) threaded
>   through `updatePage` + MCP (`wiki_update`/`update_context`) + CLI (`wiki update --if-rev`)
>   + Studio PATCH (409 + `currentRev`); `wiki_get {ifChangedSince}` → `NOT_MODIFIED`
>   sentinel; new pure `src/lib/mdtable.ts` (fence-aware GFM parse/serialize/splice,
>   alignment + escaped-pipe fidelity). Tests: `test/{cas,mdtable}.test.ts`.
> - **Phase 1** — `src/core/tables.ts` (`tableGet/tableSetCell/tableAddRow/tableDeleteRow`
>   via `updatePage`, loud locator errors); MCP `wiki_table_*` (with `next[]` affordance
>   envelope + `ifRev`); CLI `bctx wiki table get|set|add-row|rm-row`; skill-doc "editing
>   tables" section. Tests: `test/tables.test.ts` + MCP round-trip in `test/mcpwiki.test.ts`.
>   Verified on the real binary: one-cell edit is a minimal diff with alignment preserved,
>   FTS still finds the changed cell, stale `--if-rev` rejected with the live rev.
> - **Phase 2** — ONE shared table grammar: `studio/src/lib/markdown.ts` imports the pure
>   `src/lib/mdtable.ts` via a `@core/*` alias (vite `resolve.alias` + dev `server.fs.allow`
>   + tsconfig `paths`); build bundles the single source into both runtimes. The Studio
>   editor's whole-body autosave is now **alignment-lossless** (renders `data-align` +
>   re-emits via the shared `serializeTable`) — the old path silently dropped alignment.
>   Plus `POST /api/wiki/pages/:id/table` cell endpoint + `wikiApi.editCell` (backs the
>   Phase-3 grid; contenteditable keeps whole-body autosave to avoid a granular/full-body
>   race). Tests: cell endpoint in `test/studio-api.test.ts`. Verified end-to-end in a real
>   browser: edit a cell → autosave → stored markdown keeps the `:--- | :--: | ---:` row.
> - **Phase 3** — datatables + transclusion, **body-canonical** (refined from the design's
>   JSON-in-`metadata.data`): a `datatable` page's `body` *is* one canonical GFM table, so it
>   reuses FTS/peek/history/export and the Phase-1 `wiki_table_*` cell/row ops verbatim — no
>   bespoke read path, no schema change. `src/core/datatable.ts` (`createDatatable` +
>   `expandTransclusions`); `![[Title]]` embeds via the reserved `embeds` channel
>   (`EMBEDS_LINK`, kept out of `LINK_TYPES` like `references`) — `parseTransclusions` +
>   `syncBodyLinks` mirror the references block; `parseWikiLinks`/export `WIKILINK` gained a
>   `(?<!!)` lookbehind so `![[..]]` isn't captured/rewritten as a plain link/image.
>   `wiki_get` full (MCP + CLI `--no-embed`) inlines embeds on read (peek stays
>   reference-only); one datatable backs N pages, edit-once-reflect-everywhere. MCP
>   `wiki_datatable_new` + CLI `bctx wiki datatable new --columns --row`. Export writes a
>   datatable as its own `<slug>.md` (GFM body is canonical, `![[..]]` verbatim); import
>   re-derives the embed (title-keyed `resolveWantedLinks` handles either page ordering).
>   Tests: `test/{datatable,transclusion}.test.ts`. Verified on the real binary: edit a
>   datatable once → two consumers both reflect it; export/import round-trips type + verbatim
>   embed; wanted-embed resolves when the target is created after the consumer.
> - **Phase 4** — typed properties + views. NEW `page_properties(context_id,key,value,type)`
>   table (the only added stored state — ships as the first INCREMENTAL migration
>   `0002_page_properties`, so existing stores upgrade in place; see the migration note below)
>   is a DERIVED mirror of each page's `metadata.props`, rebuilt in the SAME write txn by
>   `rebuildPageProperties` (folded into `createContext`/`updateContext`; cleaned up in
>   `deleteContextChildren`) so it can never drift. `src/core/query.ts` = a predicate engine:
>   `where` object (keys ANDed; scalar = eq, or `{eq,ne,lt,gt,lte,gte,contains,in,exists}`),
>   numeric CAST comparisons, `sort {key,dir,numeric}`, compiled to correlated EXISTS/NOT-EXISTS
>   SQL. `queryPages` + `listProperties` + saved views: `page_type='view'` whose
>   `metadata.{query,columns}` render to a live GFM table (via `serializeTable`) on read/export
>   — always reflects the current graph. Surfaces: MCP `wiki_query` / `wiki_list_properties` /
>   `wiki_set_prop` / `wiki_view_new` + `props` on `wiki_new`/`wiki_update`; CLI `wiki query`
>   / `list-properties` / `set-prop` / `view new` + `wiki new --prop k=v`. Export writes a
>   `props:` frontmatter block (+ `query:`/`columns:` for views); import re-derives them.
>   Tests: `test/{properties,query}.test.ts`. Verified on the real binary: query/sort, a view
>   reflecting a `set-prop` live, export→import re-derives props + view in a fresh store.
> - **Phase 4 Studio UI** (was deferred, now shipped) — `RightPanel` gained an editable
>   **Fields** section: `metadata.props` render as key/value rows with inline edit / delete /
>   `+ field` (type-coerced like the CLI), persisted via `wikiApi.update({setMetadata:{props}})`
>   (merge preserves the other fields; the server re-derives the `page_properties` mirror).
>   `view` pages render their LIVE table (studio route calls `renderView` in `GET /pages/:id`)
>   and are read-only in the editor (like `source`), with a read-only query summary in the
>   panel. Studio `PAGE_TYPES` gained `datatable`/`view` so both surface in the sidebar.
>   Verified in a real browser: add/edit/delete a field end-to-end, view renders live, datatable
>   displays.
> - **Datatable grid editor + embedded-table rendering** (Studio) — a `datatable` page now opens
>   in a dedicated **full-bleed grid** (`studio/src/editor/DataTableEditor.tsx`): edit cells, add/
>   delete rows, add/delete/rename columns, cycle column alignment. Every mutation is one
>   index-addressed splice op → `POST /pages/:id/table/op` → `core/tables` → `updatePage`
>   (alignment-preserving, CAS via `ifRev`, no lossy whole-body PATCH); the grid is
>   server-authoritative (reseeds from each op's response, serialized through one promise chain so
>   rapid edits never race or self-409). NEW pure column mutators (`addColumnData`/`deleteColumnData`/
>   `renameColumnData`/`setColumnAlignData` in `src/lib/mdtable.ts`) + index-addressed core ops
>   (`tableSetCellAt`/`tableDeleteRowAt`/`tableAddColumn`/`tableDeleteColumn`/`tableRenameColumn`/
>   `tableSetColumnAlign`) that refuse an immutable `source` page and out-of-range indices; a
>   `writeTable` source guard now centralizes the immutable refusal for ALL table writes. Full
>   surface parity: CLI `wiki table add-col/rm-col/rename-col` + MCP `wiki_table_add_column/
>   _delete_column/_rename_column`. `WikiView` branches on `datatable` to render the grid and
>   **auto-collapses the sidebar + right panel** (layout toggle restores them). Embeds: `![[Title]]`
>   now renders inline in the prose editor as the referenced datatable's **read-only table + an
>   "Open to edit ↗" header** (`markdownToHtml` emits a `contenteditable=false` placeholder that
>   `WikiEditor` hydrates by fetching the datatable; `htmlToMarkdown` short-circuits on
>   `data-embed-title` so the consuming page's stored body keeps the `![[Title]]` marker — the table
>   is never inlined by autosave). Tests: column mutators + index ops (`test/{mdtable,tables}.test.ts`),
>   the `/table/op` endpoint incl. CAS + source refusal (`test/studio-api.test.ts`). Verified in a
>   real browser on a seeded store: full-bleed grid, cell edit + add-column persist via single
>   `/table/op` POSTs, embed renders with Open-to-edit, and editing the consuming page's prose +
>   autosave preserves `![[Title]]` (no inlined table) — the round-trip gate.
> - **Migration to existing data** — the model moved from pure-greenfield to INCREMENTAL:
>   schema additions ship as new `src/migrations/000N_*.ts` (editing an already-applied
>   migration never reaches an existing store, since they're tracked by name). `page_properties`
>   moved out of `0001_init` into `0002_page_properties` (registered in `migrate.ts`, `LATEST`
>   bumped). Added `bctx wiki reindex` (rebuild the props mirror; `--links` re-derives the graph
>   but SKIPS immutable `source` pages, per an adversarial-review finding). Tests:
>   `test/{migration,reindex}.test.ts`. Applied to the real **edumetrics** store (472 contexts,
>   26MB) on 2026-07-05: backed up → migrated to `0002` → reindexed → verified byte-identical
>   row counts (zero data loss), FTS + reads intact. Backup: `edumetrics.db.bak-2026-07-05-pre-vnext`.
> - **Table→datatable extraction** — NEW `extractTableToDatatable` (`src/core/tables.ts`) +
>   CLI `bctx wiki datatable extract <ref> --title … [--caption|--table-index]`: lifts a GFM
>   table out of a page into its own `datatable` page (verbatim: alignment / escaped pipes /
>   in-cell `[[links]]`) and leaves a `![[Title]]` embed in its place, so the page reads
>   identically (embed re-renders on read) while the data becomes queryable + reusable.
>   Creates the datatable FIRST (source-update failure never loses the table); refuses an
>   immutable `source` page or a title collision; ambiguous locator errors instead of guessing.
>   Tests: `test/extract.test.ts`. Applied to real **edumetrics** on 2026-07-05 (backups
>   `edumetrics.db.bak-2026-07-05-{pre,post}-extract`): extracted the 3 real data-tables →
>   `roster-clientes-crm` (15×57), `precios-vocation-2026` (6×3), `indicadores-clave-edumetrics`
>   (3×16). Verified: all 3 pages read BYTE-IDENTICAL after extraction+embed-expansion, 3
>   `embeds` edges derived, datatables cell-addressable + FTS-searchable, contexts 472→475 /
>   links 2734→2737 (only +3 embeds), integrity + FTS checks ok. Navigation-index tables (of
>   `[[wikilinks]]`) and immutable sources deliberately left inline.
> - **Phase 5** — general sub-body mutation for the prose/link majority a table/section can't
>   reach. NEW pure `src/lib/section.ts` (fence-aware ATX heading addressing: `parseHeadings`,
>   `findSections` — a section runs to the next same-or-higher heading — `replaceSection`, and
>   `replaceOccurrence`). `src/core/edit.ts` wires them through `updatePage`, all
>   EXACT-MATCH-OR-REFUSE via a typed `EditError`: `getPageSection`/`patchPageSection` refuse a
>   missing OR ambiguous (>1) heading; `editPage` find/replace refuses a miss, and refuses a
>   multi-match unless an `occurrence` (1-based) is given — never a silent no-op or wrong-place
>   edit. Surfaces: MCP `wiki_get {section}` + `wiki_patch_section` + `wiki_replace`; CLI
>   `wiki get --section` + `wiki patch-section` + `wiki replace` (find/replace named `replace`,
>   not `edit`, since `wiki update` already aliases `edit`). All compose with `ifRev` CAS and
>   re-sync `[[links]]` from the patched text. Tests: `test/{section,edit}.test.ts`. Verified
>   on the real binary: patch one section (sibling intact), unique replace, absent-find /
>   missing-heading / stale-rev all refuse with exit 1, links re-sync from a patched section.

> Two cross-cutting mechanics from the completeness critic fold in: **revision-CAS**
> (Phase 0) and **affordance-carrying result envelopes** (a `next:[{tool,args}]` block on
> tool results handing the agent its next pre-addressed call — added to Phase 1+ responses
> as each addressing rung lands).

### Phase 0–1 build plan (execute-ready)

- **0a — Revision CAS (first).** `UpdateInput` gains `ifRev?` (`contexts.ts:65`); in
  `updateContext`, after the in-txn read of `existing` (`:245`), reject when
  `ifRev !== existing.updated_at` with a typed `RevConflictError{currentRev}`. Thread through
  `updatePage` (`wiki.ts:229`). Read side: `ifChangedSince` on `wiki_get`/`pagePeek` →
  ~3-token `NOT_MODIFIED` sentinel. Surfaces: MCP/CLI (`--if-rev`)/Studio PATCH (409 + rev,
  reuse existing 409 path). Test `test/cas.test.ts`.
- **0b — `src/lib/mdtable.ts`** (NEW, pure, no deps/DOM): `parseTables(body)` →
  `{headingAbove, header, alignments, rows, startLine, endLine}[]`, **fence-aware** (consume
  ```` ``` ```` before detecting tables, per `studio markdown.ts:145`), honoring escaped
  `\|`, optional outer pipes, ragged rows; `serializeTable` preserving alignment. Test
  `test/mdtable.test.ts` (incl. code-fence tables NOT matched).
- **1 — `src/core/tables.ts`** (NEW): `tableGet/tableSetCell/tableAddRow/tableDeleteRow` —
  `resolvePageRef`→`getPage`→parse→splice→**`updatePage`** (history/FTS/`syncBodyLinks` fire
  free; anti-drift held). Locate by caption/`headingAbove` then index; row by key-column
  else ordinal; column by header; loud typed errors. `tableGet` returns array-of-arrays +
  header + alignment + `rev`, no page body. Register `wiki_table_*` in
  `src/mcp/wiki-tools.ts` (coaching descriptions); CLI `bctx wiki table …` in
  `src/commands/wiki.ts`; add a "when to use a datatable vs plain markdown table" note to
  `skills/braincontext-wiki/SKILL.md`. Test `test/tables.test.ts`.

### Risks → mitigations

- Silent cross-replica clobber (row-LWW) → **Phase-0 CAS ships before any granular write**.
- Storage/history amplification unchanged → document as agent-token + corruption-safety
  win, not a storage win; opt-in diff-history only if bloat bites.
- Fenced-code false positives / two-parser drift → `mdtable.ts` fence-aware + hard tests;
  Phase 2 makes Studio import the same lib.
- `![[..]]` token collision → Phase 3 `(?<!!)` lookbehind (both copies, deduped) + `embeds`.
- Query-engine scope creep → v1 = get + 3 mutators, no query language; querying/typed
  properties only Phases 3–4 behind one shared AST.

### Open decisions

1. **Row-granular sidecar storage** — the one thing JSON-in-row can't give (two agents on
   *different rows* of one big table never clobber). Default **no** (Phase-0 CAS covers
   safety; token win identical); revisit at Phase 3 only against a real
   many-agents-on-shared-large-tables profile.
2. **Commitment past Phase 3** — Phases 4–5 endorsed but earned against usage; confirm at
   the Phase 3 boundary.
