---
name: braincontext
description: Save and retrieve INDIVIDUAL context entries (decisions, rules, snippets, notes) with the local `bctx` CLI (a local-first SQLite store) — for quick, specific save/recall operations. For durable, interlinked knowledge built from sources, prefer the braincontext-wiki skill (`bctx wiki`).
allowed-tools: Bash(bctx:*)
---

# braincontext — shared context for agents

`bctx` is a local-first CLI backed by a single libSQL/SQLite store. It lets any agent
(Claude, Codex, Cursor, ...) **save** context and **retrieve** it later.
Store precedence: `--db`/`BCTX_DB` > `--global`/`--local` > `--project`/`BCTX_PROJECT` >
current project > `./.braincontext` (if present) > default project (`~/.braincontext`).

**Projects:** a named store you can switch between (`bctx project use <name>`), optionally
taken **online** so the same context syncs across sessions/devices/members. To target a
specific project for one command, use `--project <name>` or `BCTX_PROJECT`. Online projects
sync automatically on each command (write-through to one primary); pass `--no-sync` to skip.
→ `references/projects.md`

## Two ways to use braincontext

- **Wiki (preferred)** — for durable, **interlinked** knowledge built from sources:
  interlinked pages + typed links, ingest/query/lint. Start here for anything you'll
  revisit or connect. → `bctx skills get braincontext-wiki`
- **Direct context ops (this doc)** — for **individual** entries: quick save/recall of
  one decision, rule, snippet, or note when you don't need the wiki structure.

## Quick start

```bash
bctx init                                  # create the store (idempotent)
echo "Use pnpm, never npm" | bctx add --kind rule --tags tooling
bctx list --json                           # newest first
bctx search "pnpm"                         # full-text search
bctx get <id> --json                       # fetch one entry
```

## When to save context

- A **decision** the team made (`--kind decision`)
- A **rule** the agent must always follow (`--kind rule`)
- A reusable **snippet** or command (`--kind snippet`)
- A general **note** (`--kind note`, the default)

Always pass `--agent <you>` (e.g. `--agent claude`) so authorship is tracked, and
`--namespace <project>` to keep projects separate (default `global`).

## Direct context operations (individual entries)

For linked, compounding knowledge use `bctx wiki` instead (see above). These commands
are for single entries:

```bash
bctx add [body...] [--title t] [--kind k] [--namespace ns] [--scope s] \
         [--tags a,b] [--agent name] [--file path|-]   # body via args, --file, or stdin
bctx get <id> [--json]
bctx list [--namespace][--kind][--tag][--scope][--agent][--limit n][--all][--json]
bctx update <id> [--title][--body|--file -][--add-tag t][--rm-tag t][--set-meta k=v][--json]
bctx rm <id> [--hard]                       # soft-delete by default
bctx search "<query>" [--namespace][--kind][--tag][--limit][--json]
```

Pass `--json` to any read command for machine-readable output. Every write is
recorded in an append-only history table, and `rm` is reversible unless `--hard`.

## Going deeper (progressive disclosure)

Load full detail only when you need it:

```bash
bctx skills get braincontext --full        # this doc + all references
```

- `references/schema.md` — the SQLite schema, kinds, and scopes
- `references/workflows.md` — common save/retrieve/update flows
- `references/search.md` — FTS5 query syntax and tips
- `references/projects.md` — projects, switching, and online sync
- **`bctx skills get braincontext-wiki`** — the preferred wiki workflow (linked knowledge)
