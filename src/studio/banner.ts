import { accent, bold, dim, green, isInteractive } from '../lib/ansi'

export interface BannerInfo {
  /** Base URL without trailing slash, e.g. http://127.0.0.1:8420 */
  url: string
  /** Human label for the store being served (project/mode/location). */
  storeLabel: string
  /** Bind host, e.g. 127.0.0.1 */
  host: string
}

// "braincontext" — figlet, "standard" font.
const WORDMARK = [
  ' _               _                       _            _',
  '| |__  _ __ __ _(_)_ __   ___ ___  _ __ | |_ _____  _| |_',
  "| '_ \\| '__/ _` | | '_ \\ / __/ _ \\| '_ \\| __/ _ \\ \\/ / __|",
  '| |_) | | | (_| | | | | | (_| (_) | | | | ||  __/>  <| |_',
  '|_.__/|_|  \\__,_|_|_| |_|\\___\\___/|_| |_|\\__\\___/_/\\_\\\\__|',
]

const PAD = '  '
const DOT = green('●') // a live, reachable endpoint
const META = dim('◦') // ambient info, not a link

/** Pretty multi-line startup banner for a terminal. */
function renderRich(info: BannerInfo): string {
  const api = ['/api/health', '/api/contexts', '/api/wiki/pages']
  const lines = [
    '',
    ...WORDMARK.map((l) => PAD + accent(l)),
    '',
    `${PAD}${accent('studio')}  ${dim('·  linked knowledge over your local store')}`,
    '',
    `${PAD}${DOT}  ${bold('UI ')}   ${bold(accent(`${info.url}/`))}`,
    `${PAD}${DOT}  ${bold('API')}   ${dim(info.url)}${dim(`  ${api.join('  ·  ')}`)}`,
    '',
    `${PAD}${META}  ${dim('store')}  ${dim(info.storeLabel)}`,
    `${PAD}${META}  ${dim('local')}  ${dim(`${info.host} · not reachable from other machines`)}`,
    '',
    `${PAD}${dim('Ctrl-C to stop.')}`,
    '',
  ]
  return lines.join('\n')
}

/** Compact, parseable lines for non-interactive output (pipes, logs, CI). */
function renderPlain(info: BannerInfo): string {
  return [
    `bctx studio: serving ${info.storeLabel}`,
    `  UI   ${info.url}/`,
    `  API  ${info.url}/api/health , /api/contexts , /api/wiki/pages`,
    `  (${info.host} only — not reachable from other machines)`,
    '  Ctrl-C to stop.',
  ].join('\n')
}

/**
 * Render the Studio startup banner. Rich (ASCII art + colour) on an interactive
 * terminal; compact plain lines when piped/redirected. Colour also respects NO_COLOR.
 */
export function renderStudioBanner(info: BannerInfo): string {
  return isInteractive ? renderRich(info) : renderPlain(info)
}
