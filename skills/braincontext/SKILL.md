---
name: braincontext
description: Save and retrieve shared context/memory across AI coding agents using the local `bctx` CLI (a local-first SQLite store). Use when you need to persist a decision, rule, snippet, or note for later, or recall previously stored project context.
allowed-tools: Bash(bctx:*)
---

# braincontext — shared context for agents

`bctx` is a local-first CLI backed by a single SQLite file. It lets any agent
(Claude, Codex, Cursor, ...) **save** durable context and **retrieve** it later.
Store precedence: `--db` > `--global`/`--local` > `./.braincontext` (if present) > `~/.braincontext`.

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

## Commands

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
