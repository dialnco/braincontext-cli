import type { ProjectStatus } from '../../api/types'
import { Hov, sx } from '../../lib/dc'
import { Icon } from '../common/Icon'

type View = 'wiki' | 'contexts' | 'settings'
type Layout = 'three' | 'focus' | 'dual'

interface Props {
  project: ProjectStatus | null
  onOpenProjects: () => void
  onSync: () => void
  view: View
  onNav: (v: View) => void
  onOpenPalette: () => void
  layout: Layout
  setLayout: (l: Layout) => void
  graphOpen: boolean
  onEditor: () => void
  onGraph: () => void
  /** Health segment — wiki view only (the contexts view omits these). */
  healthOpen?: boolean
  /** Lint finding count (null while loading). */
  healthCount?: number | null
  onHealth?: () => void
  theme: 'light' | 'dark'
  onToggleTheme: () => void
}

export function TopBar(props: Props) {
  const { project, view } = props
  const glyph = (project?.project ?? '·').charAt(0).toUpperCase()
  const seg = (on: boolean) =>
    `padding:4px 13px;border-radius:6px;cursor:pointer;font:500 12.5px 'IBM Plex Sans';color:${on ? '#fff' : 'var(--ink-soft)'};background:${on ? 'var(--accent)' : 'transparent'};`
  const iconSeg = (on: boolean) =>
    `width:27px;height:25px;display:flex;align-items:center;justify-content:center;border-radius:6px;cursor:pointer;color:${on ? '#fff' : 'var(--muted)'};background:${on ? 'var(--accent)' : 'transparent'};`
  const navTab = (on: boolean) =>
    `padding:5px 11px;border-radius:7px;cursor:pointer;font:${on ? 600 : 500} 12.5px 'IBM Plex Sans';color:${on ? 'var(--ink)' : 'var(--muted)'};background:${on ? 'var(--accent-soft)' : 'transparent'};`

  return (
    <div
      style={sx(
        'height:50px;flex:0 0 50px;display:flex;align-items:center;gap:12px;padding:0 14px;background:var(--panel);border-bottom:1px solid var(--border);position:relative;z-index:5;',
      )}
    >
      <Hov
        base={sx(
          'display:flex;align-items:center;gap:9px;cursor:pointer;padding:5px 8px;margin:-5px -8px;border-radius:9px;',
        )}
        hover={sx('background:var(--accent-soft);')}
        onClick={props.onOpenProjects}
      >
        <div
          style={sx(
            "width:25px;height:25px;border-radius:7px;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font:600 14px 'Spectral',serif;",
          )}
        >
          {glyph}
        </div>
        <div style={sx("font:600 14px 'IBM Plex Sans';color:var(--ink);white-space:nowrap;")}>
          {project?.project ?? 'store'}
        </div>
        <span style={sx("font:400 10px 'IBM Plex Mono';color:var(--muted);")}>
          {project?.mode ?? ''}
        </span>
        <span style={sx("font:400 11px 'IBM Plex Mono';color:var(--muted);")}>▾</span>
      </Hov>

      {project?.mode === 'replica' && (
        <Hov
          base={sx(
            'width:28px;height:28px;border-radius:7px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--muted);',
          )}
          hover={sx('background:var(--accent-soft);color:var(--accent-ink);')}
          onClick={props.onSync}
          title="Sync replica"
        >
          <Icon name="sync" size={15} />
        </Hov>
      )}

      <div style={sx('display:flex;gap:2px;')}>
        <div onClick={() => props.onNav('wiki')} style={sx(navTab(view === 'wiki'))}>
          Wiki
        </div>
        <div onClick={() => props.onNav('contexts')} style={sx(navTab(view === 'contexts'))}>
          Contexts
        </div>
      </div>

      <Hov
        base={sx(
          'flex:1;max-width:380px;margin:0 auto;height:32px;display:flex;align-items:center;gap:9px;padding:0 10px 0 11px;background:var(--surface);border:1px solid var(--border);border-radius:8px;cursor:text;color:var(--muted);',
        )}
        hover={sx('border-color:var(--accent);')}
        onClick={props.onOpenPalette}
      >
        <Icon name="search" size={14} />
        <span style={sx("flex:1;font:400 13px 'IBM Plex Sans';")}>Search or jump to…</span>
        <span
          style={sx(
            "font:500 11px 'IBM Plex Mono';background:var(--code-bg);border:1px solid var(--border);border-radius:5px;padding:1px 6px;color:var(--muted);",
          )}
        >
          ⌘K
        </span>
      </Hov>

      <div style={sx('display:flex;align-items:center;gap:8px;justify-content:flex-end;')}>
        {view === 'wiki' && (
          <>
            <div
              style={sx(
                'display:flex;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:2px;gap:1px;',
              )}
            >
              <div
                onClick={() => props.setLayout('three')}
                title="Three-pane"
                style={sx(iconSeg(props.layout === 'three'))}
              >
                <Icon name="three" size={15} />
              </div>
              <div
                onClick={() => props.setLayout('focus')}
                title="Focus"
                style={sx(iconSeg(props.layout === 'focus'))}
              >
                <Icon name="focus" size={15} />
              </div>
              <div
                onClick={() => props.setLayout('dual')}
                title="Dual — rendered + markdown"
                style={sx(iconSeg(props.layout === 'dual'))}
              >
                <Icon name="dual" size={15} />
              </div>
            </div>
            <div
              style={sx(
                'display:flex;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:2px;gap:2px;',
              )}
            >
              <div
                onClick={props.onEditor}
                style={sx(seg(!props.graphOpen && !(props.healthOpen ?? false)))}
              >
                Editor
              </div>
              <div onClick={props.onGraph} style={sx(seg(props.graphOpen))}>
                Graph
              </div>
              {props.onHealth && (
                <div
                  onClick={props.onHealth}
                  title="Wiki health (lint findings)"
                  style={sx(
                    `${seg(props.healthOpen ?? false)}display:flex;align-items:center;gap:6px;`,
                  )}
                >
                  Health
                  {(props.healthCount ?? 0) > 0 && (
                    <span
                      style={sx(
                        `font:600 10px 'IBM Plex Mono';border-radius:8px;padding:0 5px;background:${props.healthOpen ? 'rgba(255,255,255,.25)' : 'var(--accent-soft)'};color:${props.healthOpen ? '#fff' : '#c98a6a'};`,
                      )}
                    >
                      {props.healthCount}
                    </span>
                  )}
                </div>
              )}
            </div>
          </>
        )}
        <Hov
          base={sx(
            'width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-soft);',
          )}
          hover={sx('border-color:var(--accent);color:var(--accent-ink);')}
          onClick={() => props.onNav('settings')}
          title="Settings"
        >
          <Icon name="gear" size={16} />
        </Hov>
        <Hov
          base={sx(
            'width:32px;height:32px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-soft);',
          )}
          hover={sx('border-color:var(--accent);color:var(--accent-ink);')}
          onClick={props.onToggleTheme}
          title="Toggle theme"
        >
          <Icon name={props.theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </Hov>
      </div>
    </div>
  )
}
