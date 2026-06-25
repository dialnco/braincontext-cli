# Search reference (FTS5)

`bctx search "<query>"` runs an SQLite FTS5 `MATCH` over titles and bodies,
ranked by BM25 (best matches first).

## Query syntax

| query | matches |
|---|---|
| `pnpm` | the term `pnpm` |
| `pnpm install` | both terms (implicit AND) |
| `"pnpm install"` | the exact phrase |
| `deploy*` | prefix: `deploy`, `deployment`, ... |
| `pnpm OR yarn` | either term |
| `pnpm NOT npm` | `pnpm` but not `npm` |

## Combine with filters

```bash
bctx search "driver" --namespace myproj --kind decision --tag db --limit 10 --json
```

## Tips

- FTS5 treats most punctuation as a token separator; quote phrases that contain it.
- Search ignores soft-deleted entries.
- For exhaustive listing rather than ranked relevance, use `bctx list` with filters.
