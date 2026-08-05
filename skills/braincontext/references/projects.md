# Projects & online sync

A **project** is a named store. Projects let you keep separate contexts (per repo, per
client, per topic) and switch between them; each is isolated. A project can be **local**
(a plain file) or **online** (a local embedded replica that syncs with a remote
libSQL/Turso primary), so the same context is shared across sessions, devices, and members.

Everything lives under `~/.braincontext/`:

```
~/.braincontext/
  config.json          # projects + the current project (safe to read/share)
  credentials.json     # auth tokens, mode 0600 — NEVER commit or print
  store.db             # the legacy global store = the "default" project
  projects/<name>.db   # each named project's local file / replica
```

## Targeting a project

Resolution precedence (highest first):

1. `--db <path>` / `BCTX_DB` — an explicit file
2. `--global` / `--local` — the legacy global / cwd stores
3. `--project <name>` / `BCTX_PROJECT` — a named project
4. the **current** project (`bctx project use <name>`)
5. `./.braincontext/store.db` in the working dir, if present
6. the **default** project (`~/.braincontext/store.db`)

```bash
bctx --project work list          # one command against "work"
BCTX_PROJECT=work bctx search x   # same, via env (handy for an MCP server)
```

## Local projects

```bash
bctx project create work            # ~/.braincontext/projects/work.db
bctx project create work --from ./some.db   # seed from an existing store
bctx project use work               # set the current project
bctx project list                   # '*' marks current; shows mode + location
bctx project current                # print the current name
bctx project path [name]            # print the resolved file/URL (scriptable)
bctx project rm work [--keep-file]  # unregister (the "default" project can't be removed)
```

## Online sync (bring your own libSQL URL — Turso free tier or self-hosted sqld)

```bash
# Device 1 — push the local project up to a FRESH (empty) remote, then become a replica:
bctx project migrate-online work --url libsql://work-org.turso.io --auth-token "$TOKEN"

# Another of YOUR devices — attach to the EXISTING remote and bootstrap a local replica:
bctx project link work --url libsql://work-org.turso.io --auth-token "$TOKEN"

# A TEAMMATE — don't share the url/token. Issue a join code (see references/access.md):
#   you:  bctx access user add ana --role writer   → prints a code
#   ana:  bctx project join <code>                 → one command, connection included

bctx project sync [name]            # pull the latest now (also runs automatically)
bctx project status [name]          # mode, location, syncUrl, interval, token state
bctx project disconnect work        # revert to a plain local store (keeps the file)
```

Token sources (in order): `--auth-token <t>` (persisted to `credentials.json`, `0600`),
`--auth-token-env <VAR>` (read at runtime, not stored), or `BCTX_TOKEN_<PROJECT>` env.

## Concurrency — safe by default

Multiple agents, sessions, and devices can read and write the **same** store at the same
time. It's built for that:

- **Local projects:** every `bctx` invocation is its own process; concurrent processes
  coordinate at the file level (WAL + busy-timeout + retry), so simultaneous CRUD from many
  agents is safe — no corruption, no lost writes.
- Concurrent edits to **different** entries always merge (every entry has a unique ULID).
  Concurrent edits to the **same** entry are **last-writer-wins**, with the prior value kept
  in append-only history (nothing is silently lost).
- You generally don't need to coordinate or lock — just CRUD. Use `bctx search`/`get` to
  re-read current state when an edit depends on what's already there.

## What to know about online sync

- **Reads are local** (replica speed). **Writes go to the one primary**, which serializes
  them — there is no multi-master conflict — and propagate to all members on sync.
- **Online writes require connectivity.** If you're offline, switch to a local project or
  expect writes to a replica to fail until reconnected.
- Each command on a replica syncs before and after by default; pass `--no-sync` to skip for
  speed when freshness doesn't matter.
- **Single writer per replica file (important):** a long-lived `bctx mcp` server on an
  online project *owns* that replica file. Do **not** run concurrent `bctx` CLI writes
  against the same online project on the same machine while the MCP server is running —
  route writes through the one MCP server, or use a separate device (its own replica).
  Different machines/replicas are always fine; the remote primary is always safe.
- **Per-member permissions exist** — a project can name its members and give each a role,
  enforced across the CLI, Studio and MCP. Off until someone runs `bctx access init`.
  → `references/access.md`
