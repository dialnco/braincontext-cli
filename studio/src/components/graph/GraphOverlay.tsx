import { useMemo, useState } from 'react'
import type { WikiGraph } from '../../api/types'
import { Hov, sx } from '../../lib/dc'
import {
  buildGraphRender,
  forceLayout,
  type GraphMode,
  type Positions,
  undirectedEdges,
} from '../../lib/graph'

interface Props {
  graph: WikiGraph
  activeId: string | null
  onOpen: (id: string) => void
  onClose: () => void
}

export function GraphOverlay({ graph, activeId, onOpen, onClose }: Props) {
  const [mode, setMode] = useState<GraphMode>('global')
  const [hover, setHover] = useState<string | null>(null)

  // Cache the (expensive, deterministic) constellation layout for this graph.
  const globalPos: Positions = useMemo(() => {
    const ids = graph.nodes.map((n) => n.id)
    return forceLayout(ids, undirectedEdges(graph.edges, new Set(ids)))
  }, [graph])

  const render = useMemo(
    () => buildGraphRender({ graph, mode, activeId, hover, globalPos }),
    [graph, mode, activeId, hover, globalPos],
  )

  const seg = (on: boolean) =>
    `padding:3px 11px;border-radius:6px;cursor:pointer;font:500 12px 'IBM Plex Sans';color:${on ? '#fff' : 'var(--ink-soft)'};background:${on ? 'var(--accent)' : 'transparent'};`
  const hoverTitle = hover ? graph.nodes.find((n) => n.id === hover)?.title : ''

  return (
    <div
      style={sx(
        'position:absolute;inset:0;z-index:20;background:var(--bg);display:flex;flex-direction:column;animation:mw-fade .18s ease;',
      )}
    >
      <div
        style={sx(
          'height:52px;flex:0 0 52px;display:flex;align-items:center;gap:14px;padding:0 18px;border-bottom:1px solid var(--border);background:var(--panel);',
        )}
      >
        <span style={sx("font:600 14px 'IBM Plex Sans';color:var(--ink);")}>Graph view</span>
        <span style={sx("font:400 12px 'IBM Plex Mono';color:var(--muted);")}>
          {graph.nodes.length} pages · {render.edges.length} links
        </span>
        <div
          style={sx(
            'display:flex;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:2px;gap:2px;margin-left:4px;',
          )}
        >
          <div onClick={() => setMode('global')} style={sx(seg(mode === 'global'))}>
            Constellation
          </div>
          <div onClick={() => setMode('local')} style={sx(seg(mode === 'local'))}>
            Local
          </div>
          <div onClick={() => setMode('folder')} style={sx(seg(mode === 'folder'))}>
            By type
          </div>
        </div>
        <span style={sx('flex:1;')} />
        <span style={sx("font:400 12px 'IBM Plex Mono';color:var(--muted);")}>{hoverTitle}</span>
        <Hov
          base={sx(
            "width:30px;height:30px;border-radius:8px;border:1px solid var(--border);background:var(--surface);display:flex;align-items:center;justify-content:center;cursor:pointer;color:var(--ink-soft);font:300 18px/1 'IBM Plex Sans';",
          )}
          hover={sx('border-color:var(--accent);')}
          onClick={onClose}
        >
          ✕
        </Hov>
      </div>
      <div style={sx('flex:1;min-height:0;position:relative;')}>
        <svg
          viewBox="0 0 900 600"
          preserveAspectRatio="xMidYMid meet"
          style={sx('width:100%;height:100%;display:block;')}
        >
          {render.edges.map((e, i) => (
            <line
              key={`e-${i}`}
              x1={e.x1}
              y1={e.y1}
              x2={e.x2}
              y2={e.y2}
              stroke="var(--ink-soft)"
              strokeWidth={e.w}
              strokeOpacity={e.o}
            />
          ))}
          {render.nodes.map((n) => (
            <g
              key={n.id}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => {
                onClose()
                onOpen(n.id)
              }}
              style={sx('cursor:pointer;')}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill={n.fill}
                stroke={n.stroke}
                strokeWidth={n.sw}
                opacity={n.opacity}
              />
              <text
                x={n.x}
                y={n.labelY}
                textAnchor="middle"
                fill="var(--ink-soft)"
                opacity={n.textOpacity}
                style={sx("font:500 12px 'IBM Plex Sans';pointer-events:none;")}
              >
                {n.label}
              </text>
            </g>
          ))}
        </svg>
        <div
          style={sx(
            "position:absolute;left:16px;bottom:14px;display:flex;gap:14px;align-items:center;font:400 11px 'IBM Plex Mono';color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:8px 13px;",
          )}
        >
          <span>hover to trace · click to open</span>
        </div>
        {graph.nodes.length === 0 && (
          <div
            style={sx(
              "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:400 15px 'Spectral',serif;font-style:italic;color:var(--muted);",
            )}
          >
            No pages to graph yet.
          </div>
        )}
      </div>
    </div>
  )
}
