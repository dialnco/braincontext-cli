# braincontext-cli

A **local-first** SQLite CLI for saving and retrieving shared **context** across AI
coding agents (Claude, Codex, Cursor, ...). One local database, one binary: `bctx`.

> Status: **v5** — multi-project + online sync + a local **Studio** web UI. See
> [`progress.md`](./progress.md) for the roadmap.

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

Requires Node >= 22. The store is **libSQL** (`@libsql/client`) — a SQLite-compatible
engine that works as a plain local file **and** as an embedded replica that syncs with a
remote primary (see [Projects & online sync](#projects--online-sync)). It ships prebuilt
binaries, so there is no native compile step.

## Usage

```bash
bctx init                                   # create the store (idempotent)
bctx status                                 # orient: store, counts, AGENTS.md staleness
echo "Use pnpm, never npm" | bctx add --kind rule --tags tooling --agent claude
bctx list --json
bctx search "pnpm"
bctx get <id> --json
bctx update <id> --add-tag important
bctx update <id> --kind decision --scope user   # correct kind/scope/namespace too
bctx rm <id>                                # soft-delete (reversible)
```

Store precedence: `--db <path>`/`BCTX_DB` > `--global`/`--local` >
`--project`/`BCTX_PROJECT` > current project > `./.braincontext` (if present) >
default project (`~/.braincontext/store.db`).

### Kinds & scopes

- **kinds:** `note` (default), `rule`, `snippet`, `decision`, `skill`
- **scopes:** `global`, `user`, `project` (default), `local`

## Projects & online sync

A **project** is a named store. Projects live under `~/.braincontext/` and you switch
between them; each is isolated. The same project can go **online** so its context is
shared across sessions, devices, and members — backed by a remote
[libSQL/Turso](https://turso.tech) primary with a local **embedded replica** (local-speed
reads; writes go to the primary and sync back).

```bash
bctx project create work            # ~/.braincontext/projects/work.db
bctx project use work               # make it current
bctx add --kind rule --title "Pkg mgr" <<< "Use pnpm"
bctx project list                   # * marks the current project
bctx --project personal list        # target another project for one command
```

**Going online** (bring your own libSQL URL — Turso's free tier or a self-hosted `sqld`).
You do this **once**, on the machine that has the remote's credentials:

```bash
bctx project migrate-online work --url libsql://work-org.turso.io --auth-token "$TOKEN"
```

That seeds a fresh (empty) remote from your local store and turns the local file into an
embedded replica. To attach **another of your own devices** to a remote you already have
credentials for, use `link`:

```bash
bctx project link work --url libsql://work-org.turso.io --auth-token "$TOKEN"
```

To add **other people**, don't hand out the URL and token — issue a join code instead
(see [Users & permissions](#users--permissions)).

```bash
bctx project sync work              # pull the latest now (also runs automatically)
bctx project status work            # mode, location, sync settings
bctx project disconnect work        # revert to a plain local store
```

Writes are **write-through to one primary** (it serializes them, so there are no
multi-master conflicts); concurrent edits to different entries merge cleanly (ULID ids),
and same-entry edits are last-writer-wins with the prior value kept in history. Online
writes require connectivity. **Tokens** are never stored in `config.json` — they live in
`~/.braincontext/credentials.json` (mode `0600`) or `BCTX_TOKEN_<PROJECT>` env.

> A plain SQLite file on S3/R2 is **not** a sync backend (single-writer only); use it for
> backup, not multi-user sync. libSQL replicas are the supported path.

## Users & permissions

A shared project can name its members and give each one a role. Roles are enforced by
every bctx surface — the CLI, `bctx studio`, and the MCP server — and every mutation is
attributed and logged.

### Inviting someone — the recommended flow

**You (once, on the project):**

```bash
bctx access init                          # you become owner; enforcement switches on
bctx access user add ana --role writer    # creates the user AND prints a join code
```

**Ana (once, on her machine) — a single command, nothing set up beforehand:**

```bash
bctx project join bctxj.…
# → Joined "work" as ana (writer).
```

That one command registers the project, bootstraps her local replica, syncs it, saves both
the database token and her access key to `~/.braincontext/credentials.json` (`0600`), and
makes it her current project. She can read and write immediately. **No `project link`
first — the join code already carries the connection.**

This is the way to onboard people. Sharing the raw `--url` + `--auth-token` still works
(and is what `link` is for on your *own* second device), but it gives everyone identical
unrestricted access with nothing to revoke short of rotating the token for the whole team.

> **Order matters:** the join code only carries the connection if the project is *already
> online*. Take it online first (`migrate-online`), then invite. If you enabled access
> control while still local, issue a fresh code once you're online:
> `bctx access key issue ana --join-code`.

### Day to day

```bash
bctx whoami                               # who am I here, and what may I do
bctx access user ls                       # roles at a glance
bctx access user show ana                 # role, capabilities, her keys
bctx access user update ana --cap "-delete"   # per-user exception to the role
bctx access user update ana --disable     # block without deleting them or their history
bctx access key issue ana --join-code     # a replacement / second-device code
bctx access key revoke <keyId>            # takes effect at each client's next sync
bctx access log --deny-only               # what was refused, and to whom
```

Roles: `owner` and `admin` (everything), `writer` (read/write/delete + files), `reader`
(read only). `--cap "+x,-y"` layers exceptions over a role. Keys are shown **once**, at
creation, and stored only as scrypt hashes — nothing can print an existing key.

> **This is advisory, not a security boundary.** Clients sync against the libSQL primary
> directly, so anyone holding the raw database token can bypass these rules with any
> SQLite client — and the join code contains that token. It gives you roles, attribution,
> an audit trail, revocation, and protection against mistakes; it does not contain someone
> who sets out to defeat it. Hand join codes only to people you would trust with full
> access. Locked out? `bctx access recover --db <file>` works on any store file you can
> open on disk.

Access control is **off** until you run `bctx access init`, and a project that never opts
in behaves exactly as it always has.

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

### Install a skill into a project (`bctx skill init`)

Scaffold the skill into the current project so any agent picks it up. Following the
[skills.sh](https://www.skills.sh/) convention, the skill lives **once** under
`.agents/skills/<name>/` and is **symlinked** into each agent's skills dir — so
`.agents`-aware and `.claude`-aware agents share the same base:

```bash
bctx skill init                      # .agents/skills/braincontext + .claude symlink
bctx skill init braincontext-wiki    # install a specific bundled skill
bctx skill init --full               # copy SKILL.md + references/* instead of a stub
bctx skill init --no-symlink         # copy into each agent dir (no symlink support)
```

By default it writes a tiny **discovery stub** (frontmatter + a pointer to
`bctx skills get <name> --full`) so the content stays version-matched to the installed
CLI and never drifts. It's idempotent; `--force` replaces a pre-existing non-managed entry.

```
.agents/skills/braincontext/SKILL.md          # canonical (stub, or --full docs)
.claude/skills/braincontext -> ../../.agents/skills/braincontext
```

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
bctx export --watch                  # re-export on every store change (Ctrl-C to stop)
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

## Studio (web UI)

The human-facing surface: a local read/write SPA + same-origin JSON API over the store —
browse and edit the wiki (pages + typed links, graph view, backlinks), manage contexts,
preview the `AGENTS.md`/`CLAUDE.md`/`.cursor` export, and switch projects.

```bash
bctx studio                 # serve on http://127.0.0.1:8420 (auto-increments if busy)
bctx studio -p 9000         # pick a port
bctx --project work studio  # serve a specific project (or BCTX_PROJECT)
```

**Binds `127.0.0.1` only** — the API exposes (and writes) store contents with no auth, so it
is not reachable from other machines, and a `Host`/`Origin` allowlist blocks cross-site
(CSRF / DNS-rebinding) access from pages you visit in a browser. Like `bctx mcp`, Studio owns
the store while running: don't run concurrent `bctx` CLI writes against the same **online
(replica)** project on this machine while it is up. Requires a build (`pnpm build` produces
`dist/studio`); for development use `pnpm studio:dev` (Vite HMR).

## Development

```bash
pnpm dev <args>        # run the CLI from source (tsx)
pnpm studio:dev        # run the Studio SPA with Vite HMR
pnpm typecheck         # tsc --noEmit (CLI)
pnpm typecheck:studio  # tsc --noEmit (Studio SPA)
pnpm test              # vitest
pnpm lint              # biome
pnpm build             # tsup -> dist/cli.js  +  vite -> dist/studio
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

Every surface — CLI commands, the MCP server, export, skill bundles, the wiki, and the
Studio web UI — goes through `core/`, never raw SQL, so they can't drift. See `progress.md`.

## License

[MIT](./LICENSE) © Dial Cortez.
