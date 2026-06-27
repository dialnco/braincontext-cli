import type { ProjectInfo } from '../../api/types'
import { sx } from '../../lib/dc'

interface Props {
  projects: ProjectInfo[]
  onSwitch: (name: string) => void
  onClose: () => void
}

/** Overlay dropdown listing registry projects; selecting one reopens the store. */
export function ProjectSwitcher({ projects, onSwitch, onClose }: Props) {
  return (
    <>
      <div onClick={onClose} style={sx('position:fixed;inset:0;z-index:40;')} />
      <div
        style={sx(
          'position:absolute;top:52px;left:13px;z-index:41;width:272px;background:var(--panel);border:1px solid var(--border);border-radius:13px;box-shadow:0 26px 60px -22px rgba(20,15,5,.5);padding:7px;animation:mw-pop .14s ease;',
        )}
      >
        <div
          style={sx(
            "font:500 10px 'IBM Plex Mono';letter-spacing:.09em;text-transform:uppercase;color:var(--muted);padding:7px 9px;",
          )}
        >
          Projects
        </div>
        {projects.map((p) => (
          <div
            key={p.name}
            onClick={() => {
              onSwitch(p.name)
              onClose()
            }}
            style={sx(
              `display:flex;align-items:center;gap:11px;padding:8px 9px;border-radius:9px;cursor:pointer;${p.current ? 'background:var(--accent-soft);' : ''}`,
            )}
          >
            <div
              style={sx(
                "width:32px;height:32px;flex:0 0 32px;border-radius:9px;background:var(--accent);color:#fff;display:flex;align-items:center;justify-content:center;font:600 15px 'Spectral',serif;",
              )}
            >
              {p.name.charAt(0).toUpperCase()}
            </div>
            <div style={sx('flex:1;min-width:0;')}>
              <div style={sx("font:600 13px 'IBM Plex Sans';color:var(--ink);")}>{p.name}</div>
              <div style={sx("font:400 11.5px 'Spectral',serif;color:var(--muted);")}>{p.mode}</div>
            </div>
            <span
              style={sx(
                "font:500 13px 'IBM Plex Mono';color:var(--accent-ink);width:16px;flex:0 0 16px;text-align:center;",
              )}
            >
              {p.current ? '✓' : ''}
            </span>
          </div>
        ))}
      </div>
    </>
  )
}
