import { readFileSync } from 'node:fs'

/** Read all of stdin (empty string if attached to a TTY / nothing piped). */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Resolve a body from (in priority order): `--file -` (stdin), `--file <path>`,
 * trailing positional args, or piped stdin.
 */
export async function resolveBody(file: string | undefined, args: string[]): Promise<string> {
  if (file === '-') return readStdin()
  if (file) return readFileSync(file, 'utf8')
  if (args.length > 0) return args.join(' ')
  return readStdin()
}
