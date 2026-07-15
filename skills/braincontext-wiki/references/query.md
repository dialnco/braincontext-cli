# Query workflow

Goal: answer a question from the wiki — and make the answer **compound**.

1. **Locate** relevant pages — start at the catalog, then search:
   ```bash
   bctx wiki index            # scan the catalog (your map of what exists) first
   bctx wiki search "<q>"     # FTS5/BM25 ranked pages
   ```
2. **Drill in**: `bctx wiki show "<title>"` to read a page plus its links and
   backlinks. Then gather the connected context in one shot with
   `bctx wiki related "<title>" --depth 2` (nearest pages first, with the link
   type and direction that reached each) instead of following links one by one.
   When the question is "how do X and Y relate?", `bctx wiki path "X" "Y"`
   returns the shortest chain of typed links connecting them.
3. **Synthesize** the answer for the user, **with citations** — name the pages/sources
   you drew on (and `[[link]]` them) so the answer is traceable.
4. **File it back** as a permanent page so the exploration isn't lost to chat:
   ```bash
   bctx wiki new "<question or topic>" --type analysis --file -
   ```
   Link it to the pages it draws on (`[[...]]` in the body, or `bctx wiki link`).

Over time this turns one-off questions into durable, navigable knowledge.
