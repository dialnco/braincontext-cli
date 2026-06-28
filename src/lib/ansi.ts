// Tiny ANSI helper for human-facing CLI status (banners, startup notices).
// Status is printed to stderr, so colour/interactivity is gated on stderr.
// Honours the NO_COLOR convention (https://no-color.org) and `TERM=dumb`.

const noColor = process.env.NO_COLOR != null
const dumb = process.env.TERM === 'dumb'

/** stderr is attached to a terminal — show the rich banner, not the plain log lines. */
export const isInteractive = Boolean(process.stderr.isTTY) && !dumb

/** Emit ANSI colour codes (interactive and not opted out). */
export const colorEnabled = isInteractive && !noColor

/** Terminal advertises 24-bit colour — use the exact brand periwinkle. */
const truecolor = /(^|;)(truecolor|24bit)(;|$)/i.test(process.env.COLORTERM ?? '')

function sgr(code: string): (s: string) => string {
  return (s) => (colorEnabled ? `\x1b[${code}m${s}\x1b[0m` : s)
}

export const bold = sgr('1')
export const dim = sgr('2')
export const green = sgr('32')

/** The braincontext brand accent (periwinkle #7c8cff), truecolor → 256-colour → plain. */
export const accent = (s: string): string =>
  colorEnabled ? `\x1b[${truecolor ? '38;2;124;140;255' : '38;5;111'}m${s}\x1b[0m` : s
