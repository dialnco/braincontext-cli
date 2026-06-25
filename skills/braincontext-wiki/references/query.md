# Query workflow

Goal: answer a question from the wiki — and make the answer **compound**.

1. **Locate** relevant pages:
   ```bash
   bctx wiki index            # scan the catalog
   bctx wiki search "<q>"     # FTS5/BM25 ranked pages
   ```
2. **Drill in**: `bctx wiki show "<title>"` to read a page plus its links and
   backlinks; follow links to gather connected context.
3. **Synthesize** the answer for the user.
4. **File it back** as a permanent page so the exploration isn't lost to chat:
   ```bash
   bctx wiki new "<question or topic>" --type analysis --file -
   ```
   Link it to the pages it draws on (`[[...]]` in the body, or `bctx wiki link`).

Over time this turns one-off questions into durable, navigable knowledge.
