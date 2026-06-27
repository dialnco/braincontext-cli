import React from 'react'

/**
 * Parse a CSS declaration string ("a:b;c:d") into a React style object.
 * The design expresses styles as CSS strings; React needs objects. Non-string
 * input (e.g. the pre-built `heroVars` object) is returned as-is. Results are
 * cached by source string so repeated renders don't re-parse.
 */
const cache = new Map<string, React.CSSProperties>()
export function sx(input?: string | React.CSSProperties | null): React.CSSProperties | undefined {
  if (input == null) return undefined
  if (typeof input !== 'string') return input
  const hit = cache.get(input)
  if (hit) return hit
  const out: Record<string, string> = {}
  for (const decl of input.split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const rawProp = decl.slice(0, i).trim()
    const val = decl.slice(i + 1).trim()
    if (!rawProp) continue
    const prop = rawProp.startsWith('--')
      ? rawProp
      : rawProp.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
    out[prop] = val
  }
  const obj = out as React.CSSProperties
  cache.set(input, obj)
  return obj
}

type HovProps = {
  as?: keyof React.JSX.IntrinsicElements
  base?: React.CSSProperties
  hover?: React.CSSProperties
  children?: React.ReactNode
  [key: string]: any
}

/**
 * A `div` (or `as` tag) that swaps to the `hover` style on pointer enter/leave —
 * reproduces the design's `style-hover` attribute, which React has no native
 * equivalent for. All other props (onClick, title, …) pass straight through.
 */
export function Hov({
  as = 'div',
  base,
  hover,
  onMouseEnter,
  onMouseLeave,
  children,
  ...rest
}: HovProps) {
  const [h, setH] = React.useState(false)
  return React.createElement(
    as,
    {
      ...rest,
      style: h ? { ...base, ...hover } : base,
      onMouseEnter: (e: any) => {
        setH(true)
        if (onMouseEnter) onMouseEnter(e)
      },
      onMouseLeave: (e: any) => {
        setH(false)
        if (onMouseLeave) onMouseLeave(e)
      },
    },
    children,
  )
}
