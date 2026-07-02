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
bctx wiki search "<q>" [--type][--limit]
bctx wiki index [--out index.md] [--budget N]  # catalog by page type; --budget caps it at ~N tokens
bctx wiki log [--tail N]                  # operation log
bctx wiki lint [--stale-days N] [--drift] [--json]
bctx wiki ingest "<ref>" --status         # how far did the synthesis get? (resumable)
bctx wiki export <dir> / import <dir>     # Obsidian-compatible markdown round-trip
```

Load detail on demand: `bctx skills get braincontext-wiki --full`
(`references/structure.md`, `ingest.md`, `query.md`, `lint.md`).
