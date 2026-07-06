import { describe, expect, it } from 'vitest'
import { findSections, parseHeadings, replaceOccurrence, replaceSection } from '../src/lib/section'

const DOC = [
  '# Title',
  '',
  'intro',
  '',
  '## Alpha',
  'a body',
  '',
  '### Alpha child',
  'child body',
  '',
  '## Beta',
  'b body',
].join('\n')

describe('lib/section — heading-anchored addressing', () => {
  it('parses ATX headings with levels, skipping fenced code', () => {
    const doc = ['# Real', '```', '# fake in fence', '```', '## Also real'].join('\n')
    expect(parseHeadings(doc)).toEqual([
      { level: 1, text: 'Real', line: 0 },
      { level: 2, text: 'Also real', line: 4 },
    ])
  })

  it('bounds a section at the next same-or-higher heading (nested children included)', () => {
    const [alpha] = findSections(DOC, 'Alpha')
    if (!alpha) throw new Error('no Alpha')
    // Alpha (##) includes its ### child, stops before ## Beta.
    expect(alpha.text).toBe('## Alpha\na body\n\n### Alpha child\nchild body\n')
    expect(alpha.level).toBe(2)
  })

  it('a deeper heading bounds only its own content', () => {
    const [child] = findSections(DOC, 'Alpha child')
    expect(child?.text).toBe('### Alpha child\nchild body\n')
  })

  it('matches case/space-insensitively and reports ambiguity', () => {
    expect(findSections(DOC, 'alpha').length).toBe(1)
    const dup = ['## Notes', 'x', '## Notes', 'y'].join('\n')
    expect(findSections(dup, 'Notes').length).toBe(2)
  })

  it('replaceSection splices a section, leaving the rest intact', () => {
    const [beta] = findSections(DOC, 'Beta')
    if (!beta) throw new Error('no Beta')
    const out = replaceSection(DOC, beta, '## Beta\nrewritten')
    expect(out).toContain('## Beta\nrewritten')
    expect(out).toContain('## Alpha') // other sections untouched
    expect(out).not.toContain('b body')
  })

  it('replaceOccurrence: single match replaced', () => {
    const r = replaceOccurrence('the cat sat', 'cat', 'dog')
    expect(r).toEqual({ body: 'the dog sat', count: 1 })
  })

  it('replaceOccurrence: refuses an ambiguous multi-match without occurrence', () => {
    const r = replaceOccurrence('a a a', 'a', 'b')
    expect(r).toEqual({ body: 'a a a', count: 3 }) // unchanged; caller refuses
  })

  it('replaceOccurrence: picks the nth match (1-based)', () => {
    expect(replaceOccurrence('a a a', 'a', 'b', 2).body).toBe('a b a')
  })

  it('replaceOccurrence: out-of-range / not-found leave the body unchanged', () => {
    expect(replaceOccurrence('a a', 'a', 'b', 5)).toEqual({ body: 'a a', count: 2 })
    expect(replaceOccurrence('hello', 'zzz', 'b')).toEqual({ body: 'hello', count: 0 })
  })
})
