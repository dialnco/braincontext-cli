# Schema reference

A single SQLite file (default `~/.braincontext/store.db`), WAL mode, foreign keys on.

## `contexts` (the main table)

| column | notes |
|---|---|
| `id` | ULID, time-sortable primary key |
| `namespace` | project bucket (default `global`) |
| `title` | optional short title |
| `body` | the content (required) |
| `kind` | `note` \| `rule` \| `snippet` \| `decision` \| `skill` |
| `scope` | `global` \| `user` \| `project` \| `local` |
| `agent_source` | who wrote it (`claude`, `codex`, ...) |
| `metadata` | free-form JSON object |
| `created_at` / `updated_at` | ISO timestamps |
| `deleted_at` | set on soft-delete; `NULL` when live |

## Supporting tables

- `tags` + `context_tags` — many-to-many tagging.
- `contexts_fts` — FTS5 mirror of `(title, body)`, kept in sync by triggers; powers `bctx search`.
- `context_history` — append-only audit of every create/update/delete (`old_body`, `new_body`, `agent_source`, `changed_at`).
- `skill_files` — reserved for future SKILL.md bundles (unused in v1).

## Kinds, briefly

- **note** — general context.
- **rule** — a constraint the agent must obey.
- **decision** — a recorded choice and its rationale.
- **snippet** — reusable code/command.
- **skill** — a skill-flavored note (stored like any other context).
