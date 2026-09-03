#!/usr/bin/env node
// `engines` only makes npm *warn*, so a too-old Node reaches this file and then
// dies somewhere deep in the app with an unrelated-looking error. Check first and
// say so plainly. The app graph is pulled in with `await import` below precisely
// so nothing from it is evaluated before this guard runs (static imports hoist).
const MIN_NODE_MAJOR = 22
const nodeMajor = Number.parseInt(process.versions.node, 10)
if (Number.isFinite(nodeMajor) && nodeMajor < MIN_NODE_MAJOR) {
  console.error(
    `bctx requires Node >= ${MIN_NODE_MAJOR} (found v${process.versions.node}). Upgrade Node, then re-run.`,
  )
  process.exit(1)
}

const { ZodError } = await import('zod')
const { AccessDeniedError } = await import('./core/access/errors')
const { buildProgram } = await import('./program')

try {
  await buildProgram().parseAsync(process.argv)
} catch (err) {
  if (err instanceof ZodError) {
    console.error(err.issues.map((i) => i.message).join('; '))
  } else if (err instanceof AccessDeniedError) {
    // Already a complete, actionable sentence (see access/session.ts describeFailure).
    console.error(err.message)
  } else {
    console.error(err instanceof Error ? err.message : String(err))
  }
  process.exitCode = 1
}
