# Common workflows

## Save a rule from stdin

```bash
echo "Always run pnpm typecheck before committing." \
  | bctx add --kind rule --namespace myproj --tags ci,policy --agent claude
```

## Save a multi-line decision from a file

```bash
bctx add --kind decision --title "DB driver" --file ./notes/decision.md --agent claude
```

## Recall context for the current project

```bash
bctx list --namespace myproj --json          # everything, newest first
bctx list --namespace myproj --kind rule      # just the rules
bctx search "driver" --namespace myproj       # full-text
```

## Update an entry

```bash
bctx update <id> --add-tag important --set-meta reviewed=true
echo "Revised body" | bctx update <id> --file -
```

## Remove (reversible) vs purge

```bash
bctx rm <id>            # soft-delete: hidden from list/search, still in history
bctx rm <id> --hard     # permanent
```

## Agent etiquette

- Scope writes with `--namespace <project>` so context does not leak across projects.
- Always set `--agent <name>` so authorship and history are meaningful in a shared store.
- Prefer `--json` when parsing output programmatically.
