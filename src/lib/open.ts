// Open a URL in the user's default browser. Cross-platform and best-effort:
// spawns the OS launcher detached and never throws — failing to open a browser
// must not take down the Studio server that is already listening.

import { spawn } from 'node:child_process'
import { platform } from 'node:process'

/** The OS command + args that hand a URL to the default browser. */
function launcher(url: string): { command: string; args: string[] } {
  switch (platform) {
    case 'darwin':
      return { command: 'open', args: [url] }
    case 'win32':
      // `start` is a cmd builtin; the empty "" is the (ignored) window title.
      return { command: 'cmd', args: ['/c', 'start', '""', url] }
    default:
      return { command: 'xdg-open', args: [url] }
  }
}

/** Best-effort: launch the default browser at `url`, swallowing any failure. */
export function openInBrowser(url: string): void {
  const { command, args } = launcher(url)
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {}) // e.g. xdg-open missing — don't crash the server
    child.unref()
  } catch {
    // Opening a browser is a convenience, not a requirement.
  }
}
