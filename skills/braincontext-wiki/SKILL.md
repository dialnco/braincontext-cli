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

This is the **preferred** way to manage durable, linked knowledge. For one-off
individual entries (a single rule/note/decision), use `bctx add/get/list` — the
`braincontext` skill.

## The three layers

1. **Sources** (immutable) — raw docs you read but never edit (`page_type='source'`).
2. **Pages** (yours) — `entity`, `concept`, `summary`, `comparison`, `analysis` pages, cross-linked.
3. **This skill** — the conventions/workflows below.

## Linking

- In a page body, write `[[Title]]` to link another page. On save these become a
  `references` edge automatically; an unknown `[[Title]]` becomes a **wanted** (red) link that `lint` surfaces.
- For explicit semantic edges use `bctx wiki link <from> <to> --type <relates|supersedes|part-of|mentions|source>`.

## Core loops

```bash
bctx wiki ingest <file|->   # store a source + print a synthesis checklist  -> references/ingest.md
bctx wiki search "<q>"      # find pages; drill in; FILE answers back as an `analysis` page (query.md)
bctx wiki lint              # health report; fix orphans/dangling/wanted      -> references/lint.md
```

## Commands

```bash
bctx wiki new "<title>" --type <entity|concept|summary|comparison|analysis> --file -
bctx wiki get|show "<id|title>"           # show = page + outbound links + backlinks
bctx wiki link "<from>" "<to>" --type <relates|supersedes|part-of|mentions|source>
bctx wiki backlinks "<id|title>"
bctx wiki search "<q>" [--type][--limit]
bctx wiki index [--out index.md]          # catalog by page type
bctx wiki log [--tail N]                  # operation log
bctx wiki lint [--json]
bctx wiki export <dir> / import <dir>     # Obsidian-compatible markdown round-trip
```

Load detail on demand: `bctx skills get braincontext-wiki --full`
(`references/structure.md`, `ingest.md`, `query.md`, `lint.md`).
