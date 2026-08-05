# Users, keys & permissions

A shared project can name its members and give each one a **role**. Roles are enforced by
every bctx surface — the CLI, `bctx studio`, and the `bctx mcp` server.

**It is off until someone runs `bctx access init`.** A project that never opts in behaves
exactly as it always has: no keys, no checks, nothing to configure. Most local
single-person projects should leave it off.

## If you are an agent working in a store

Find out what you may do — this always works, even when everything else is refused:

```bash
bctx whoami                  # handle, role, capabilities; says so if access control is off
bctx whoami --json           # same, machine-readable
```

Over MCP, call the `whoami` tool (also always allowed).

**When a command or tool is refused** you get:

```
Permission denied: "ana" (reader) lacks the `write` capability.
```

That is **final**. Do not retry it, and do not try another command that reaches the same
data — every surface checks the same capability. Instead:

1. Call `bctx whoami` (or the `whoami` tool) to see what you *do* hold.
2. Do the parts of the task your role allows.
3. Tell the user plainly what you could not do and which capability it needed, so they can
   grant it (`bctx access user update <handle> --cap "+write"`) or do that step themselves.

A **read-only** identity should plan read-only work — don't draft a long page you cannot
save. `bctx whoami` reports `This identity is read-only.`

If you have **no** key on an access-controlled project, every command fails with:

```
This project requires an access key. Run `bctx project join <code>` …
```

Ask the user for a join code; do not attempt to work around it.

## Roles and capabilities

| role | what it can do |
|---|---|
| `owner` | everything, including turning access control off |
| `admin` | everything, except removing or demoting the last owner |
| `writer` | `read`, `write`, `delete`, `files.read`, `files.write`, `config.read` |
| `reader` | `read`, `files.read`, `config.read` |

The nine capabilities: `read`, `write`, `delete`, `files.read`, `files.write`,
`config.read`, `config.write`, `users.manage`, `project.manage`.

Roles can be adjusted per user — `--cap "+delete,-files.write"` layers exceptions over the
role's defaults, so a writer can be denied deletes without inventing a new role.

## Joining a project (as a member)

The project admin sends **one** join code. It is a single command, from nothing:

```bash
bctx project join bctxj.…      # the whole setup
bctx whoami                    # confirm which identity you got
```

That one command registers the project, bootstraps the local replica, syncs it, saves the
database token **and** the access key, and makes it the current project. There is **no
`bctx project link` step first** — the code already carries the connection.

Keys live in `~/.braincontext/credentials.json` (mode `0600`) — never typed again.
`BCTX_KEY_<PROJECT>` overrides for one command; `BCTX_KEY` is the fallback for a raw
`--db <file>` target.

If the code was issued while the project was still local it carries no connection, and
joining fails unless you already have that store. Ask for a fresh one.

## Running a project (as an admin)

```bash
bctx access init                            # become owner; switch enforcement on
bctx access status                          # is it on, who am I, how many users/keys

# Take the project ONLINE FIRST — a code minted while local carries no connection.
bctx access user add ana --role writer      # creates the user AND prints a join code
bctx access user ls
bctx access user show ana                   # role, capabilities, keys
bctx access user update ana --role reader   # or --cap "+delete" / --disable / --enable
bctx access user rm ana                     # their access log entries are kept

bctx access key issue ana --label laptop    # a second key (rotation, another device)
bctx access key ls [ana]
bctx access key revoke <keyId>              # applies at each client's next sync

bctx access log --limit 20                  # allow/deny history
bctx access log --deny-only                 # just the refusals
```

Keys are shown **once**, when created, and stored only as scrypt hashes — there is no
command that prints an existing key. Lost one? Issue another and revoke the old.

Denials are always logged. Allowed *writes* are logged; allowed *reads* are not, to keep
the log useful (and to avoid a write to the remote on every read).

## Two things that matter

**This is advisory, not a security boundary.** Clients sync against the libSQL primary
directly, so anyone holding the raw database token can bypass every rule with an ordinary
SQLite client — and **the join code contains that token**. What it does buy: roles,
attribution, an audit trail, revocation, and protection against mistakes. Hand join codes
only to people you would trust with full access to the database.

**Locked out?** `bctx access recover --db <path-to-store.db>` restores owner access on any
store file you can open on disk. It refuses remote targets on purpose — filesystem
ownership is the real boundary here, and that is exactly why the model is advisory.

## Attribution

Once access control is on, every write records who made it (`principal_id` on the row and
in the append-only history), alongside the existing `agent_source` tool label. So the store
can answer both "which tool wrote this" and "on whose authority".
