# Ingest workflow

Goal: integrate a new source into the wiki so knowledge **accumulates** instead of
being re-discovered each time.

1. **Store the source** (immutable):
   ```bash
   bctx wiki ingest ./article.md --title "TLS 1.3 overview" --uri https://...
   ```
2. **Write a summary page** capturing the source's key takeaways:
   ```bash
   bctx wiki new "TLS 1.3 overview" --type summary --file -
   ```
   In the body, cross-link the entities/concepts it touches with `[[...]]`. When you want
   oversight, surface the key takeaways to the user first and let them steer before you
   commit pages.
3. **Link the summary to its source** (provenance):
   ```bash
   bctx wiki link "TLS 1.3 overview" "TLS 1.3 overview" --type source
   ```
   (If the source and summary share a title, link by id from `bctx wiki search`.)
4. **Update ~5–15 related pages.** For each entity/concept the source informs,
   open it (`bctx wiki show`), weave in the new facts, and add `[[...]]` links.
   Create missing pages (`bctx wiki new --type entity|concept`). Watch for claims the new
   source contradicts or supersedes, and reconcile them (`bctx wiki link --type supersedes`).
5. **Refresh the index**: `bctx wiki index --out index.md` so the catalog reflects the
   new and updated pages — every ingest should leave the index current.
6. **Lint and reconcile**: `bctx wiki lint` — resolve any new wanted/orphan findings.

The CLI does the mechanical storage + logging; **you** do the synthesis (a single source
typically touches ~5–15 pages). One source at a time when you want oversight; batch when
you trust the pattern.
