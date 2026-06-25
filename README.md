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
  skills/           bundled-skill loader
  lib/              small helpers (paths, stdin, formatting)
skills/braincontext/  shipped agent docs (SKILL.md + references)
```

All surfaces go through `core/` — never raw SQL — so future surfaces (MCP server,
markdown export) can be added without drift. See `progress.md`.
