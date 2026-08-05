#!/usr/bin/env node
import { ZodError } from 'zod'
import { AccessDeniedError } from './core/access/errors'
import { buildProgram } from './program'

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
