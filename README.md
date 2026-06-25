# braincontext-cli

A **local-first** SQLite CLI for saving and retrieving shared **context** across AI
coding agents (Claude, Codex, Cursor, ...). One local database, one binary: `bctx`.

> Status: **v1 (barebones)**. See [`progress.md`](./progress.md) for the roadmap.

## Why

Agents constantly re-learn the same project facts. `braincontext` gives them a single,
portable, local store to **save** durable context (rules, decisions, snippets, notes)
and **retrieve** it later — over a fast FTS5 search — with full history and soft-delete.

## Install (dev)

```bash
pnpm install
pnpm build
pnpm link --global     # exposes `bctx` on your PATH
```

Requires Node >= 22. `better-sqlite3` is a native module; pnpm's
`onlyBuiltDependencies` allow-list (in `package.json`) lets it build on install.

## Usage

```bash
bctx init                                   # create the store (idempotent)
echo "Use pnpm, never npm" | bctx add --kind rule --tags tooling --agent claude
bctx list --json
bctx search "pnpm"
bctx get <id> --json
bctx update <id> --add-tag important
bctx rm <id>                                # soft-delete (reversible)
```

Store precedence: `--db <path>` > `--global`/`--local` > `./.braincontext` (if present)
> `~/.braincontext`.

### Kinds & scopes

- **kinds:** `note` (default), `rule`, `snippet`, `decision`, `skill`
- **scopes:** `global`, `user`, `project` (default), `local`

## Skills (for agents)

The CLI ships its own **bundled, version-matched skill docs** with progressive
disclosure — agents load detail on demand:

```bash
bctx skills                       # list bundled skills
bctx skills get braincontext      # the SKILL.md
bctx skills get braincontext --full   # + references/*
```

This mirrors the [agent-browser](https://github.com/vercel-labs/agent-browser#skills)
pattern, so `npx skills add <repo>` can drop a stub that points back at
`bctx skills get braincontext`.

## MCP server (read & write from any agent)

Run an MCP stdio server so Claude/Cursor/Codex read and write the same store
natively (full CRUD; `delete` is soft-only over MCP):

```bash
bctx mcp
```

Register it with Claude Code:

```bash
claude mcp add --transport stdio bctx -- bctx mcp
```

…or in `.mcp.json`:

```json
{ "mcpServers": { "bctx": { "type": "stdio", "command": "bctx", "args": ["mcp"] } } }
```

Tools: `search_contexts`, `get_context`, `list_contexts`, `create_context`,
`update_context`, `delete_context` — plus a `bctx://context/{id}` resource.

## Export to agent files

Materialize the store into the files agents already read, idempotently (a managed
`<!-- BEGIN/END braincontext-cli -->` block; hand-written content is preserved):

```bash
bctx export --out .                  # AGENTS.md + CLAUDE.md(@AGENTS.md) + .cursor/rules/*.mdc
bctx export --targets agents,cursor  # pick targets
bctx export --dry-run                # show what would change
bctx export --check                  # exit non-zero if stale (CI)
```

`AGENTS.md` is canonical (sections by kind, read by 60+ agents); `CLAUDE.md` just
imports it via `@AGENTS.md`; each `rule` becomes one `.cursor/rules/*.mdc`.

## Round-trip / manual sync (markdown ⇄ DB)

The files above are one-directional (DB → agents). For editing context **as markdown
and syncing edits back**, use the `store` target — one identity-bearing `.md` per
context — paired with `bctx import` (a manual, explicit action; never auto-sync):

```bash
bctx export --targets store --out ./ctx   # write one <slug>.md per context (frontmatter id/kind/tags + body)
# …edit / add / delete files in ./ctx…
bctx import ./ctx --dry-run               # preview: create / update / prune
bctx import ./ctx                         # apply: matches by frontmatter id; new files create
bctx import ./ctx --prune                 # also soft-delete contexts whose file is gone
```

Safe by default: `import` never deletes unless `--prune`, and `--prune` is **scoped to
the namespaces present in the files** so a partial export can't remove unrelated
contexts. Syncs title/body/tags; `id`/`kind`/`namespace`/`scope` are stable identity.
(Wiki pages round-trip separately via `bctx wiki export/import`.)

## Skill bundles (SKILL.md round-trip)

Import a full Agent-Skill directory (frontmatter + `scripts/`/`references/`/`assets/`)
into the store and reconstruct it on disk faithfully (binary assets + `chmod +x scripts/`):

```bash
bctx skill add ./my-skill            # validates name==folder (kebab) and imports
bctx skill list                      # skills stored in the DB
bctx skill export my-skill ./out     # writes ./out/my-skill/ back to disk
```

> `bctx skill` (singular) manages skills **stored in the database**; `bctx skills`
> (plural) serves the CLI's **own bundled docs**.

## Wiki (linked knowledge base)

A Karpathy-style **LLM wiki** over the same store: interlinked markdown **pages**
with typed **links** (the graph *is* the knowledge graph), searched with FTS5/BM25
and link navigation — **no embeddings**. Wiki pages are hidden from plain
`list`/`search` (use `--include-wiki` to include them).

```bash
bctx wiki ingest ./article.md --title "TLS notes"   # store a raw source + a synthesis checklist
bctx wiki new "Gateway" --type entity --file -        # create a page (entity|concept|summary|comparison|analysis)
echo "See [[Gateway]]." | bctx wiki new "OAuth2" --type concept --file -   # [[Title]] auto-links
bctx wiki link "OAuth2" "Gateway" --type relates      # explicit typed link
bctx wiki show "OAuth2"                                # page + outbound links + backlinks
bctx wiki search "tls"                                 # FTS5/BM25 over pages
bctx wiki lint                                         # orphans, dangling/wanted links, ...
bctx wiki index --out wiki/index.md                   # catalog by page type
bctx wiki export ./wiki  &&  bctx wiki import ./wiki   # Obsidian-compatible round-trip
```

Ingestion is **agent-driven**: the CLI stores/links/searches/lints; an agent (via the
MCP `wiki_*` tools + the bundled `braincontext-wiki` skill) does the synthesis. See
`bctx skills get braincontext-wiki --full`.

## Development

```bash
pnpm dev <args>        # run the CLI from source (tsx)
pnpm typecheck         # tsc --noEmit
pnpm test              # vitest
pnpm lint              # biome
pnpm build             # tsup -> dist/cli.js
```

## Architecture

```
src/
  cli.ts            commander program (bin entry)
  commands/         thin handlers: parse -> validate -> call core/
  core/             shared data-access layer (single source of truth)
  migrations/       Kysely migrations (registered in code)
  core/wiki.ts      wiki pages + typed links + lint (over core/contexts)
  mcp/              MCP server (context + wiki tools + resources) over core/
  export/           AGENTS.md / CLAUDE.md / .cursor/rules renderers + managed fences
  skillbundles/     SKILL.md parse / validate / reconstruct (filesystem)
  wiki/             wiki export / import (markdown <-> store)
  skills/           bundled-skill doc loader
  lib/              small helpers (paths, stdin, formatting, frontmatter, wikilinks)
skills/braincontext/       shipped CLI agent docs
skills/braincontext-wiki/  shipped wiki-maintainer skill
```

Every surface — CLI commands, the MCP server, export, skill bundles, and the wiki —
goes through `core/`, never raw SQL, so they can't drift. See `progress.md`.
