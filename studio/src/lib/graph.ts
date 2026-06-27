/**
 * Graph layout + render geometry, ported from the reference's force-directed code
 * and rebound to the API's {@link WikiGraph} (nodes = pages, edges = typed links).
 * Pure + deterministic (no Math.random) so the same graph always lays out the same
 * way and it's unit-testable. Handlers/colours-by-theme are applied by the view.
 */

import type { GraphEdge, GraphNode, WikiGraph } from '../api/types'
import { pageTypeColor } from './theme'

export type GraphMode = 'global' | 'local' | 'folder'

export interface Vec {
  x: number
  y: number
}
export type Positions = Record<string, Vec>

export interface RenderEdge {
  x1: number
  y1: number
  x2: number
  y2: number
  w: number
  o: number
}
export interface RenderNode {
  id: string
  x: number
  y: number
  r: number
  sw: number
  fill: string
  stroke: string
  opacity: number
  labelY: number
  label: string
  textOpacity: number
}

const W = 900
const H = 600

/** Collapse directed edges to a unique undirected set among the given node ids. */
export function undirectedEdges(edges: GraphEdge[], ids: Set<string>): [string, string][] {
  const seen = new Set<string>()
  const out: [string, string][] = []
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) continue
    const k = e.from < e.to ? `${e.from}|${e.to}` : `${e.to}|${e.from}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push([e.from, e.to])
  }
  return out
}

export function adjacency(edges: GraphEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const add = (a: string, b: string) => {
    const s = adj.get(a) ?? new Set<string>()
    s.add(b)
    adj.set(a, s)
  }
  for (const e of edges) {
    if (e.from === e.to) continue
    add(e.from, e.to)
    add(e.to, e.from)
  }
  return adj
}

/** Deterministic force-directed layout (repulsion + spring + centering, cooled). */
export function forceLayout(ids: string[], edges: [string, string][]): Positions {
  const pad = 64
  const ns = ids.map((id, i) => ({
    id,
    x: W / 2 + Math.cos(i * 2.3999) * (150 + i * 4),
    y: H / 2 + Math.sin(i * 2.3999) * (130 + i * 3),
    dx: 0,
    dy: 0,
  }))
  const idx: Record<string, number> = {}
  ns.forEach((n, i) => {
    idx[n.id] = i
  })
  const es = edges.filter((e) => idx[e[0]] != null && idx[e[1]] != null)
  const k = Math.sqrt((W * H) / Math.max(1, ns.length)) * 0.62
  let temp = W * 0.1
  for (let it = 0; it < 280; it++) {
    for (const n of ns) {
      n.dx = 0
      n.dy = 0
    }
    for (let i = 0; i < ns.length; i++) {
      const ni = ns[i]!
      for (let j = i + 1; j < ns.length; j++) {
        const nj = ns[j]!
        let dx = ni.x - nj.x
        let dy = ni.y - nj.y
        const d = Math.hypot(dx, dy) || 0.01
        const rep = (k * k) / d
        dx = dx / d
        dy = dy / d
        ni.dx += dx * rep
        ni.dy += dy * rep
        nj.dx -= dx * rep
        nj.dy -= dy * rep
      }
    }
    for (const [a, b] of es) {
      const A = ns[idx[a]!]!
      const B = ns[idx[b]!]!
      let dx = A.x - B.x
      let dy = A.y - B.y
      const d = Math.hypot(dx, dy) || 0.01
      const att = (d * d) / k
      dx = dx / d
      dy = dy / d
      A.dx -= dx * att
      A.dy -= dy * att
      B.dx += dx * att
      B.dy += dy * att
    }
    for (const n of ns) {
      n.dx += (W / 2 - n.x) * 0.013
      n.dy += (H / 2 - n.y) * 0.013
    }
    for (const n of ns) {
      const d = Math.hypot(n.dx, n.dy) || 0.01
      const m = Math.min(d, temp)
      n.x += (n.dx / d) * m
      n.y += (n.dy / d) * m
      n.x = Math.max(pad, Math.min(W - pad, n.x))
      n.y = Math.max(pad, Math.min(H - pad, n.y))
    }
    temp *= 0.984
  }
  const pos: Positions = {}
  for (const n of ns) pos[n.id] = { x: n.x, y: n.y }
  return pos
}

/** Center node + immediate neighbours on an inner ring, their neighbours on an outer ring. */
export function localLayout(
  center: string,
  adj: Map<string, Set<string>>,
): { pos: Positions; ids: string[] } {
  const inner = [...(adj.get(center) ?? [])]
  const innerSet = new Set([center, ...inner])
  const outer: string[] = []
  const outerSet = new Set<string>()
  for (const i of inner) {
    for (const o of adj.get(i) ?? []) {
      if (!innerSet.has(o) && !outerSet.has(o)) {
        outerSet.add(o)
        outer.push(o)
      }
    }
  }
  const cx = W / 2
  const cy = H / 2
  const pos: Positions = { [center]: { x: cx, y: cy } }
  inner.forEach((id, i) => {
    const ang = (i / Math.max(1, inner.length)) * Math.PI * 2 - Math.PI / 2
    pos[id] = { x: cx + Math.cos(ang) * 150, y: cy + Math.sin(ang) * 150 }
  })
  outer.forEach((id, i) => {
    const ang = (i / Math.max(1, outer.length)) * Math.PI * 2 - Math.PI / 2 + 0.3
    pos[id] = { x: cx + Math.cos(ang) * 255, y: cy + Math.sin(ang) * 248 }
  })
  return { pos, ids: [center, ...inner, ...outer] }
}

/** Cluster nodes by page type into a grid of "folders". */
export function folderLayout(nodes: GraphNode[]): { pos: Positions; ids: string[] } {
  const groups: Record<string, string[]> = {}
  for (const n of nodes) {
    const f = n.pageType || 'other'
    const arr = groups[f] ?? []
    arr.push(n.id)
    groups[f] = arr
  }
  const fids = Object.keys(groups).sort()
  const cols = Math.min(3, fids.length) || 1
  const rows = Math.ceil(fids.length / cols)
  const cents: Record<string, Vec> = {}
  fids.forEach((f, i) => {
    cents[f] = { x: (((i % cols) + 0.5) / cols) * W, y: ((Math.floor(i / cols) + 0.5) / rows) * H }
  })
  const pos: Positions = {}
  for (const f of fids) {
    const arr = groups[f] ?? []
    const c = cents[f] ?? { x: W / 2, y: H / 2 }
    arr.forEach((id, j) => {
      if (arr.length === 1) {
        pos[id] = { x: c.x, y: c.y }
      } else {
        const ang = (j / arr.length) * Math.PI * 2
        const rad = Math.min(105, 34 + arr.length * 9)
        pos[id] = { x: c.x + Math.cos(ang) * rad, y: c.y + Math.sin(ang) * rad * 0.84 }
      }
    })
  }
  for (const id in pos) {
    const p = pos[id]
    if (!p) continue
    p.x = Math.max(58, Math.min(W - 58, p.x))
    p.y = Math.max(58, Math.min(H - 58, p.y))
  }
  return { pos, ids: nodes.map((n) => n.id) }
}

export interface BuildGraphArgs {
  graph: WikiGraph
  mode: GraphMode
  activeId: string | null
  hover: string | null
  /** Cached global positions so the constellation doesn't relayout every render. */
  globalPos?: Positions
}

/** Render-ready edges + nodes for the current mode (geometry + styling, no handlers). */
export function buildGraphRender(args: BuildGraphArgs): {
  edges: RenderEdge[]
  nodes: RenderNode[]
} {
  const { graph, mode, activeId, hover } = args
  const adj = adjacency(graph.edges)
  let pos: Positions
  let ids: string[]
  if (mode === 'local' && activeId) {
    const r = localLayout(activeId, adj)
    pos = r.pos
    ids = r.ids
  } else if (mode === 'folder') {
    const r = folderLayout(graph.nodes)
    pos = r.pos
    ids = r.ids
  } else {
    ids = graph.nodes.map((n) => n.id)
    pos = args.globalPos ?? forceLayout(ids, undirectedEdges(graph.edges, new Set(ids)))
  }
  const idset = new Set(ids)
  const titleOf = new Map(graph.nodes.map((n) => [n.id, n.title ?? n.id]))
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.pageType]))
  const focus = hover
    ? new Set([hover, ...[...(adj.get(hover) ?? [])].filter((x) => idset.has(x))])
    : null

  const edges: RenderEdge[] = undirectedEdges(graph.edges, idset)
    .filter(([a, b]) => pos[a] && pos[b])
    .map(([a, b]) => {
      const pa = pos[a]!
      const pb = pos[b]!
      const inb = focus ? focus.has(a) && focus.has(b) : false
      return {
        x1: pa.x,
        y1: pa.y,
        x2: pb.x,
        y2: pb.y,
        w: inb ? 2 : 1,
        o: focus ? (inb ? 0.55 : 0.07) : 0.18,
      }
    })

  const nodes: RenderNode[] = ids
    .filter((id) => pos[id])
    .map((id) => {
      const p = pos[id]!
      const deg = (adj.get(id) ?? new Set()).size
      let r = Math.min(20, 6 + deg * 1.5)
      const active = id === activeId
      const isHover = id === hover
      const inF = !focus || focus.has(id)
      let fill: string
      let stroke: string
      if (mode === 'folder') {
        const c = pageTypeColor(typeOf.get(id) ?? null)
        fill = c
        stroke = c
      } else {
        fill = active || isHover ? 'var(--accent)' : 'var(--surface)'
        stroke = active || isHover ? 'var(--accent)' : 'var(--muted)'
      }
      r = active ? r + 2 : r
      return {
        id,
        x: p.x,
        y: p.y,
        r,
        sw: active ? 3 : 2,
        fill,
        stroke,
        opacity: inF ? 1 : 0.16,
        labelY: p.y + r + 15,
        label: titleOf.get(id) ?? id,
        textOpacity: inF ? (active || isHover ? 1 : 0.78) : 0.12,
      }
    })
  return { edges, nodes }
}
