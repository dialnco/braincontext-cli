import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely'
import { AccessDeniedError } from './errors'

/**
 * Leading keyword of a statement, ignoring leading comments and whitespace. Only
 * the FIRST keyword is inspected: matching write verbs anywhere in the text would
 * reject legitimate selects (`context_history` filters on the literal `'delete'`).
 */
const WRITE_HEAD =
  /^(insert|update|delete|replace|drop|alter|create|vacuum|reindex|attach|detach)\b/i

function isWriteSql(text: string): boolean {
  const head = text.replace(/^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '')
  return WRITE_HEAD.test(head)
}

/**
 * Defense in depth for a read-only session.
 *
 * The real gate is the capability check at the surface layer; this is the backstop
 * that catches a code path someone forgot to annotate. It is an allow-list: only
 * `SelectQueryNode` and non-mutating raw SQL (FTS queries, `PRAGMA`) get through,
 * so a query node type added by a future Kysely version fails closed.
 *
 * Install it with `db.withPlugin(readOnlyPlugin)` AFTER migrations have run — the
 * migrator's DDL would otherwise be rejected.
 */
export const readOnlyPlugin: KyselyPlugin = {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const node = args.node
    if (node.kind === 'SelectQueryNode') return node
    if (node.kind === 'RawNode') {
      const raw = node as RootOperationNode & { sqlFragments?: readonly string[] }
      const text = (raw.sqlFragments ?? []).join(' ')
      if (!isWriteSql(text)) return node
    }
    throw new AccessDeniedError(
      'This session is read-only: your role grants no write capability.',
      { code: 'read_only' },
    )
  },

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result
  },
}
