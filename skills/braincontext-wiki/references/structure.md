# Wiki structure

## Page types

- **entity** — a person, system, service, place, org (a noun you'll reference often).
- **concept** — an idea, pattern, or technique.
- **summary** — a faithful digest of one source.
- **comparison** — A-vs-B tradeoffs.
- **analysis** — a synthesized answer to a question (the output of `query`, filed back).
- **source** — a raw ingested document (immutable; you never edit these).
- **index** — the generated catalog (use `bctx wiki index`; don't hand-maintain).

## Identity & links

- Each page has a stable **slug** (used as the export filename) and a **title**.
- `[[Title]]` in a body → an automatic `references` edge (re-derived on every save).
- Explicit edges (`bctx wiki link ... --type ...`) are preserved across edits.
- A page's **backlinks** (`bctx wiki backlinks`) are how you navigate inbound context.

## Conventions

- One idea per page; keep pages focused and link generously.
- Title pages consistently (titles resolve case-insensitively; avoid duplicate titles — `lint` flags `ambiguous-wikilink`).
- Keep a single `index` page current with `bctx wiki index --out`.
- Namespaces (`--namespace`) separate independent wikis/projects; default is `wiki`.
