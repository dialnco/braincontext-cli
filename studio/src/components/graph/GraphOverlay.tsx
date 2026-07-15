import { useEffect, useMemo, useRef, useState } from 'react'
import type { WikiGraph } from '../../api/types'
import { Hov, sx } from '../../lib/dc'
import {
  buildGraphRender,
  forceLayout,
  GRAPH_NODE_CAP,
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

/** The SVG's fixed viewBox (must match lib/graph's layout space). */
const VB_W = 900
const VB_H = 600

interface View {
  k: number
  tx: number
  ty: number
}
const HOME_VIEW: View = { k: 1, tx: 0, ty: 0 }

/** Map a pointer event to viewBox coordinates (accounting for `meet` letterboxing). */
function toViewBox(svg: SVGSVGElement, clientX: number, clientY: number): { x: number; y: number } {
  const rect = svg.getBoundingClientRect()
  const s = Math.min(rect.width / VB_W, rect.height / VB_H) || 1
  return {
    x: (clientX - rect.left - (rect.width - s * VB_W) / 2) / s,
    y: (clientY - rect.top - (rect.height - s * VB_H) / 2) / s,
  }
}

export function GraphOverlay({ graph, activeId, onOpen, onClose }: Props) {
  const [mode, setMode] = useState<GraphMode>('global')
  const [hover, setHover] = useState<string | null>(null)
  const [view, setView] = useState<View>(HOME_VIEW)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const drag = useRef<{ x: number; y: number } | null>(null)
  // A pan should not open the node it happened to start on.
  const panned = useRef(false)

  // Cache the (expensive, deterministic) constellation layout for this graph.
  const globalPos: Positions = useMemo(() => {
    const ids = graph.nodes.map((n) => n.id)
    return forceLayout(ids, undirectedEdges(graph.edges, new Set(ids)))
  }, [graph])

  const render = useMemo(
    () => buildGraphRender({ graph, mode, activeId, hover, globalPos }),
    [graph, mode, activeId, hover, globalPos],
  )

  // Wheel zoom around the cursor. Attached natively (non-passive) so
  // preventDefault stops the browser's own pinch-zoom/scroll.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const p = toViewBox(svg, e.clientX, e.clientY)
      setView((v) => {
        const k = Math.min(8, Math.max(0.4, v.k * Math.exp(-e.deltaY * 0.002)))
        // Keep the graph point under the cursor stationary through the zoom.
        return { k, tx: p.x - ((p.x - v.tx) / v.k) * k, ty: p.y - ((p.y - v.ty) / v.k) * k }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const switchMode = (m: GraphMode) => {
    setMode(m)
    setView(HOME_VIEW)
  }

  const seg = (on: boolean) =>
    `padding:3px 11px;border-radius:6px;cursor:pointer;font:500 12px 'IBM Plex Sans';color:${on ? '#fff' : 'var(--ink-soft)'};background:${on ? 'var(--accent)' : 'transparent'};`
  const hoverTitle = hover ? graph.nodes.find((n) => n.id === hover)?.title : ''
  const pruned = graph.nodes.length >= GRAPH_NODE_CAP

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
          {pruned ? ` · top ${GRAPH_NODE_CAP} best-connected` : ''}
        </span>
        <div
          style={sx(
            'display:flex;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:2px;gap:2px;margin-left:4px;',
          )}
        >
          <div onClick={() => switchMode('global')} style={sx(seg(mode === 'global'))}>
            Constellation
          </div>
          <div onClick={() => switchMode('local')} style={sx(seg(mode === 'local'))}>
            Local
          </div>
          <div onClick={() => switchMode('folder')} style={sx(seg(mode === 'folder'))}>
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
          ref={svgRef}
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          preserveAspectRatio="xMidYMid meet"
          style={sx(
            `width:100%;height:100%;display:block;touch-action:none;cursor:${drag.current ? 'grabbing' : 'grab'};`,
          )}
          onPointerDown={(e) => {
            drag.current = { x: e.clientX, y: e.clientY }
            panned.current = false
          }}
          onPointerMove={(e) => {
            const svg = svgRef.current
            if (!svg || !drag.current) return
            const rect = svg.getBoundingClientRect()
            const s = Math.min(rect.width / VB_W, rect.height / VB_H) || 1
            const dx = (e.clientX - drag.current.x) / s
            const dy = (e.clientY - drag.current.y) / s
            if (Math.abs(e.clientX - drag.current.x) + Math.abs(e.clientY - drag.current.y) > 2) {
              // Only capture once a real pan starts — capturing on pointerdown would
              // retarget pointerup at the svg and swallow node click-to-open.
              panned.current = true
              svg.setPointerCapture(e.pointerId)
            }
            drag.current = { x: e.clientX, y: e.clientY }
            setView((v) => ({ ...v, tx: v.tx + dx, ty: v.ty + dy }))
          }}
          onPointerUp={(e) => {
            if (svgRef.current?.hasPointerCapture(e.pointerId)) {
              svgRef.current.releasePointerCapture(e.pointerId)
            }
            drag.current = null
          }}
          onDoubleClick={() => setView(HOME_VIEW)}
        >
          <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
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
                  if (panned.current) return
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
          </g>
        </svg>
        <div
          style={sx(
            "position:absolute;left:16px;bottom:14px;display:flex;gap:14px;align-items:center;font:400 11px 'IBM Plex Mono';color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:8px 13px;",
          )}
        >
          <span>scroll to zoom · drag to pan · double-click to reset · click to open</span>
          {view.k !== 1 && <span>{Math.round(view.k * 100)}%</span>}
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
