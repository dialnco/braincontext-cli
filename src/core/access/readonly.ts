import type {
  KyselyPlugin,
  OperationNode,
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

/** The bare table name an operation node targets, or null if it is not a plain table. */
function tableName(node: OperationNode | undefined): string | null {
  if (!node) return null
  if (node.kind === 'AliasNode') return tableName((node as unknown as { node: OperationNode }).node)
  if (node.kind !== 'TableNode') return null
  const t = node as unknown as { table: { schema?: unknown; identifier: { name: string } } }
  return t.table.schema ? null : t.table.identifier.name
}

/** Every table a mutating node writes to, or null when it cannot be determined. */
function writeTargets(node: RootOperationNode): string[] | null {
  // A CTE could hide a second write; treat it as undeterminable.
  if ((node as { with?: unknown }).with) return null
  if (node.kind === 'InsertQueryNode') {
    const t = tableName((node as unknown as { into?: OperationNode }).into)
    return t ? [t] : null
  }
  if (node.kind === 'UpdateQueryNode') {
    const t = tableName((node as unknown as { table?: OperationNode }).table)
    return t ? [t] : null
  }
  if (node.kind === 'DeleteQueryNode') {
    const froms = (node as unknown as { from?: { froms?: OperationNode[] } }).from?.froms ?? []
    const names = froms.map(tableName)
    return names.length && names.every((n): n is string => n !== null) ? names : null
  }
  return null
}

/**
 * Defense in depth for a read-only session.
 *
 * The real gate is the capability check at the surface layer; this is the backstop
 * that catches a code path someone forgot to annotate. It is an allow-list: only
 * `SelectQueryNode` and non-mutating raw SQL (FTS queries, `PRAGMA`) get through,
 * so a query node type added by a future Kysely version fails closed.
 *
 * `writableTables` carves out the few tables a session may still write even though
 * it cannot change project knowledge — the inbox, for a reader who holds
 * `inbox.write`. Only Kysely insert/update/delete nodes whose every target is a
 * plain, listed table qualify; raw-SQL writes, merges, CTEs, and anything whose
 * target cannot be read off the node stay refused.
 *
 * Install it with `db.withPlugin(...)` AFTER migrations have run — the migrator's
 * DDL would otherwise be rejected.
 */
export function createReadOnlyPlugin(
  writableTables: ReadonlySet<string> = new Set(),
): KyselyPlugin {
  return {
    transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
      const node = args.node
      if (node.kind === 'SelectQueryNode') return node
      if (node.kind === 'RawNode') {
        const raw = node as RootOperationNode & { sqlFragments?: readonly string[] }
        const text = (raw.sqlFragments ?? []).join(' ')
        if (!isWriteSql(text)) return node
      }
      if (writableTables.size > 0) {
        const targets = writeTargets(node)
        if (targets?.every((t) => writableTables.has(t))) return node
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
}

/** The strict variant: nothing but reads. */
export const readOnlyPlugin: KyselyPlugin = createReadOnlyPlugin()
