# Lint / maintenance workflow

Run `bctx wiki lint` periodically. Findings and how to fix them:

| finding | meaning | fix |
|---|---|---|
| `orphan` | a page no other page links to | add `[[links]]` from related pages, or link from the index |
| `dangling` | a link points at a missing/deleted page | fix the link, or recreate the target |
| `wanted` | a `[[Title]]` with no page yet (red link) | create the page (`bctx wiki new`) or correct the title |
| `ambiguous-wikilink` | two pages share a title | rename one so `[[Title]]` resolves deterministically |
| `source-without-page` | an ingested source nothing derives from | write a summary page and link it `--type source` |
| `missing-from-index` | a page absent from the index | regenerate the index (`bctx wiki index --out index.md`) |

After fixing, re-run `bctx wiki lint` until clean, and append notable maintenance to
the log implicitly (ingest/query operations are logged; see `bctx wiki log`).

Also proactively look for: contradictions between pages, stale claims superseded by
newer sources (link `--type supersedes`), concepts important enough to deserve their own
page, and **data gaps** — questions the wiki can't yet answer for lack of a source.
Surface these to the user and suggest new questions/sources to fill them.
