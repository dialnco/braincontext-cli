---
name: braincontext-wiki
description: Preferred workflow for braincontext. Build and maintain a linked knowledge wiki with `bctx wiki` (Karpathy LLM-wiki pattern). Use when ingesting sources into durable, interlinked pages, answering questions from the wiki, or running maintenance. Pairs with the bctx MCP `wiki_*` tools. (For one-off individual entries, use the braincontext skill instead.)
allowed-tools: Bash(bctx:*)
---

# braincontext-wiki — you are the wiki maintainer

`bctx wiki` is a local knowledge **wiki** over the same SQLite store: interlinked
markdown **pages** with **typed links** (the link graph *is* the knowledge graph),
searched with FTS5/BM25 — **no embeddings**. Your job is to keep it accurate,
well-linked, and compounding. Wiki pages are hidden from plain `bctx list`/`search`;
use `bctx wiki *` (or the `wiki_*` MCP tools).

This is not RAG. Instead of re-retrieving from raw docs on every query, you build a
**persistent, compiled knowledge layer**: a source is read once and digested into
durable pages, so the cross-references are already there and contradictions have
already been flagged. Each ingest and each answered question **compounds** the wiki —
knowledge accumulates instead of being re-discovered.

This is the **preferred** way to manage durable, linked knowledge. For one-off
individual entries (a single rule/note/decision), use `bctx add/get/list` — the
`braincontext` skill.

## The three layers

1. **Sources** (immutable) — raw docs you read but never edit (`page_type='source'`).
2. **Pages** (yours) — `entity`, `concept`, `summary`, `comparison`, `analysis` pages, cross-linked.
3. **This skill** — the conventions/workflows below (the "schema": structure + conventions).

## Division of labor

The tedious part of a knowledge base is not the reading or thinking — it's the
**bookkeeping**: updating cross-references, keeping summaries current, holding dozens of
pages consistent, and flagging contradictions. Humans abandon wikis under that burden;
you don't get bored, so it's **yours**.

- **The human** curates sources, directs the analysis, asks good questions, and decides
  what matters.
- **You** do everything else — ingest, summarize, cross-link, reconcile, lint, and keep
  the index/log current. Treat consistency and connectivity as your standing job, not a
  one-off.

## Linking

- In a page body, write `[[Title]]` to link another page. On save these become a
  `references` edge automatically; an unknown `[[Title]]` becomes a **wanted** (red) link that `lint` surfaces.
- For explicit semantic edges use `bctx wiki link <from> <to> --type <relates|supersedes|part-of|mentions|source>`.

## Navigate the graph (query it, don't just build it)

The link graph is queryable — use it to assemble context around a page instead of
re-searching, and to explain how concepts relate:

- `bctx wiki related "<ref>" [--depth N] [--type a,b] [--limit N]` (MCP: `wiki_related`) —
  every page within N hops, nearest first, each hit tagged with the link type, its true
  direction (`→` outbound / `←` inbound), and the page it was reached through. **Start
  here when a task centers on one page**: 1 hop = its immediate context, 2 hops = the
  wider neighborhood worth peeking.
- `bctx wiki path "<from>" "<to>"` (MCP: `wiki_path`) — the shortest chain of links
  connecting two pages, with the type + direction of every step. Answers "how do these
  two concepts relate?" structurally; exits non-zero when they don't connect.
- `bctx wiki graph [--min-degree N] [--limit N]` (MCP: `wiki_graph`) — whole-graph
  overview: counts by link type, orphans, and the best-connected hubs. Hubs are the
  load-bearing pages — keep them accurate first. On large wikis pass `--limit` for the
  well-connected core instead of thousands of nodes.

## Editing tables (cell/row ops — don't rewrite the whole body)

Editing a markdown table the naive way (fetch the full body, re-emit the whole table, PATCH
it back) burns output tokens and often corrupts the other rows. Edit it in place instead:

- `bctx wiki table get "<ref>"` (MCP: `wiki_table_get`) — read a table as structured rows +
  a `rev`. Pass that `rev` back as `--if-rev` / `ifRev` so a concurrent edit is caught, not
  silently clobbered.
- `bctx wiki table set "<ref>" --row <key> --col <name> --value <v>` (MCP:
  `wiki_table_set_cell`) — change ONE cell; every other cell stays byte-identical.
- `bctx wiki table add-row "<ref>" --cells a,b,c` / `bctx wiki table rm-row "<ref>" --row <key>`
  (MCP: `wiki_table_add_row` / `wiki_table_delete_row`).

Rows are addressed by first-column value (or a 0-based ordinal), columns by header name;
pick among multiple tables with `--caption` (the heading above it) or `--table-index`. Reach
for a table op when the data is queried, mutated field-by-field, or shared across pages; a
one-off illustrative list can stay plain markdown.

## Datatables (one table, embedded in many pages)

When the SAME table belongs on several pages, don't copy it — make it a **datatable** and
embed it. A datatable is a page whose whole body is one canonical table, so all the table
ops above work on it, and it's searchable/peekable like any page.

- `bctx wiki datatable new "<Title>" --columns "Name,Status" --row "Acme,active"` (MCP:
  `wiki_datatable_new`) — create it (repeat `--row` for more rows).
- In any other page body, write `![[<Title>]]` (note the leading `!`) to **embed** it. On
  read, `wiki get`/`wiki_get {detail:"full"}` inlines the datatable's current table where the
  `![[..]]` sits; `--peek` (and `--no-embed`) leave it as a reference. The embed is an
  `embeds` edge, so `lint`/backlinks show every page that consumes the datatable.
- Edit the datatable ONCE (`wiki table set …`) and every page that `![[..]]`-embeds it
  reflects the change — no per-page rewrite. Use this whenever a table is the single source
  of truth for facts reused across pages.

## Properties & views (query pages like a database)

Give pages typed **properties** and you can query the wiki as a small database instead of
grepping bodies.

- Set props when creating: `bctx wiki new "Auth" --type concept --prop status=active --prop priority=3`
  (MCP: `props` on `wiki_new`/`wiki_update`). One at a time: `bctx wiki set-prop "Auth" --key status --value done`
  (MCP: `wiki_set_prop`; value `null` deletes the key). Values are typed (number/boolean inferred).
- Discover what you can filter on: `bctx wiki list-properties` (MCP: `wiki_list_properties`).
- Query: `bctx wiki query --where '{"status":"active","priority":{"gt":2}}'` (MCP: `wiki_query`).
  Each `where` key is ANDed; a value is a scalar (exact match) or a condition object —
  `{eq,ne,lt,gt,lte,gte,contains,in,exists}`. Add `--sort priority:desc --sort-numeric`.
- Save a query as a **view**: `bctx wiki view new "Active work" --where '{"status":"active"}' --columns priority,area`
  (MCP: `wiki_view_new`). A view is a page whose body is a live GFM table of the matching
  pages — it re-renders every read, so it always reflects the current graph.

## Editing prose (section / find-replace — don't rewrite the whole body)

For a targeted text edit, don't `wiki get` the whole page and re-emit it — patch in place:

- **One section:** `bctx wiki get "<ref>" --section "Config"` reads just that heading's slice
  (MCP: `wiki_get {section}`); `bctx wiki patch-section "<ref>" --section "Config" --body ...`
  replaces it (MCP: `wiki_patch_section`). Include the heading line in the new body to keep it.
  A section runs to the next same-or-higher heading. Refuses if the heading is missing or matches
  more than one place.
- **One phrase/link/value:** `bctx wiki replace "<ref>" --find "old" --replace "new"` (MCP:
  `wiki_replace`). EXACT-MATCH-OR-REFUSE — with no `--occurrence`, `--find` must occur exactly
  once; if it appears N times, pass `--occurrence <n>` (1-based). A miss is an error, never a
  silent no-op.

Both re-sync `[[links]]` from the new text and take `--if-rev`/`ifRev` for compare-and-swap.

## Core loops

```bash
bctx wiki ingest <file|->   # store a source, then summarize + cross-link ~5–15 pages   -> references/ingest.md
bctx wiki search "<q>"      # find pages; drill in; FILE answers back as an `analysis` page (query.md)
bctx wiki lint              # health report; fix orphans/dangling/wanted/contradictions  -> references/lint.md
bctx wiki index --out index.md   # regenerate the catalog; refresh it after each ingest
bctx wiki log               # chronological record of ingests/queries/lint passes
```

Start a query at the **index** (the content catalog — your map of what exists) before
drilling into pages, and refresh it after ingesting so it stays the reliable first stop.

## Read progressively (protect your context window)

Climb the disclosure ladder instead of dumping full pages:

1. **Index line** — the catalog shows each page's one-line summary and token cost (`~340 tok`).
2. **Peek** — `bctx wiki get "<ref>" --peek` (MCP: `wiki_get {detail:"peek"}`): outline,
   excerpt, links, freshness, and what the full body would cost. Search hits are compact
   too (snippet + token estimate, no bodies).
3. **Full** — fetch the body only for pages you will actually use; `--max-tokens N`
   (MCP: `maxTokens`) truncates at a paragraph boundary when you only need the top.

## Freshness & code drift

Pages not verified or updated within ~45 days surface in `lint` as `stale` /
`never-verified`. After you check a page against reality (or refresh it), run
`bctx wiki verify "<ref>"` (MCP: `wiki_verify`) so freshness tracking stays honest.

Declare the source files a page documents with `--sources src/a.ts,src/b.ts`
(MCP: `sources` on `wiki_new`/`wiki_update`) — that is how a future agent finds
the relevant files for a task. `verify` snapshots each file's content hash;
`bctx wiki lint --drift` (run from the repo root) then flags pages whose
documented code changed out from under them.

## Resumable ingest

`bctx wiki ingest "<ref>" --status` (MCP: `wiki_ingest_status`) derives the
synthesis checklist's completion from the graph — summary linked? related pages
updated? index refreshed? verified? — so an interrupted ingest can be picked up
in a later session exactly where it stopped.

## Commands

```bash
bctx wiki new "<title>" --type <entity|concept|summary|comparison|analysis> --file -
bctx wiki get|show "<id|title>"           # show = page + outbound links + backlinks
bctx wiki get "<ref>" --peek              # outline/excerpt/links/cost — decide before fetching full
bctx wiki verify "<ref>"                  # mark just-checked content as verified
bctx wiki link "<from>" "<to>" --type <relates|supersedes|part-of|mentions|source>
bctx wiki backlinks "<id|title>"
bctx wiki related "<ref>" [--depth N]     # neighborhood: pages within N hops, nearest first
bctx wiki path "<from>" "<to>"            # shortest link chain between two pages
bctx wiki graph [--limit N]               # overview: link counts, orphans, best-connected hubs
bctx wiki search "<q>" [--type][--limit]
bctx wiki index [--out index.md] [--budget N]  # catalog by page type; --budget caps it at ~N tokens
bctx wiki log [--tail N]                  # operation log
bctx wiki lint [--stale-days N] [--drift] [--json]
bctx wiki ingest "<ref>" --status         # how far did the synthesis get? (resumable)
bctx wiki export <dir> / import <dir>     # Obsidian-compatible markdown round-trip
```

Load detail on demand: `bctx skills get braincontext-wiki --full`
(`references/structure.md`, `ingest.md`, `query.md`, `lint.md`).

**If a write is refused** with `Permission denied:`, the project has per-member permissions
on and this identity may not edit. Run `bctx whoami` to see your role — a reader can still
search, `wiki get`, `graph`, `related` and `lint`, so answer from the wiki and report what
you could not file back, rather than retrying.
→ `bctx skills get braincontext` (`references/access.md`)
