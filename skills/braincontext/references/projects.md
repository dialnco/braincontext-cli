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

# Device 2 / a teammate — attach to the EXISTING remote and bootstrap a local replica:
bctx project link work --url libsql://work-org.turso.io --auth-token "$TOKEN"

bctx project sync [name]            # pull the latest now (also runs automatically)
bctx project status [name]          # mode, location, syncUrl, interval, token state
bctx project disconnect work        # revert to a plain local store (keeps the file)
```

Token sources (in order): `--auth-token <t>` (persisted to `credentials.json`, `0600`),
`--auth-token-env <VAR>` (read at runtime, not stored), or `BCTX_TOKEN_<PROJECT>` env.

## What to know about sync

- **Reads are local** (replica speed). **Writes go to the one primary**, which serializes
  them — there is no multi-master conflict.
- Concurrent edits to **different** entries merge cleanly (every entry has a unique ULID).
  Concurrent edits to the **same** entry are last-writer-wins; the prior value is kept in
  the append-only history.
- **Online writes require connectivity.** If you're offline, switch to a local project or
  expect writes to a replica to fail until reconnected.
- Each command on a replica syncs before and after by default; pass `--no-sync` to skip for
  speed when freshness doesn't matter.
- **Auth/permissions are not built yet** — group members currently share one project token.
  A managed control-plane (accounts, roles, per-member tokens) is planned.
