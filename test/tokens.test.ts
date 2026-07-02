import { describe, expect, it } from 'vitest'
import { extractExcerpt, extractOutline, truncateAtTokens } from '../src/lib/outline'
import { estimateTokens, formatTokens } from '../src/lib/tokens'

describe('token estimation', () => {
  it('estimates ~chars/4 and never rounds down to skip a partial token', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(4000))).toBe(1000)
  })

  it('formats compactly below and above 1k', () => {
    expect(formatTokens(340)).toBe('~340 tok')
    expect(formatTokens(12345)).toBe('~12.3k tok')
  })
})

describe('outline / excerpt / truncation', () => {
  it('extracts ## and ### headings in order, skipping code fences', () => {
    const body = [
      '# Title',
      '## First',
      'text',
      '```',
      '## not a heading',
      '```',
      '### Nested',
      '## Second',
    ].join('\n')
    expect(extractOutline(body)).toEqual(['First', 'Nested', 'Second'])
  })

  it('excerpt cuts at a word boundary and never splits a [[wikilink]]', () => {
    const short = 'brief body'
    expect(extractExcerpt(short)).toBe(short)

    const long = `${'word '.repeat(70)}[[Some Long Page Title]] tail`
    const cut = extractExcerpt(long, 360)
    expect(cut.endsWith('…')).toBe(true)
    // Either the wikilink is fully present or fully absent — never half of it.
    const opens = (cut.match(/\[\[/g) ?? []).length
    const closes = (cut.match(/\]\]/g) ?? []).length
    expect(opens).toBe(closes)
  })

  it('truncates at a paragraph boundary and reports token counts', () => {
    const para = 'sentence '.repeat(50).trim() // ~450 chars
    const body = [para, para, para, para].join('\n\n')
    const full = truncateAtTokens(body, 100000)
    expect(full.truncated).toBe(false)
    expect(full.text).toBe(body)

    const cut = truncateAtTokens(body, 250) // ~1000 chars => ~2 paragraphs
    expect(cut.truncated).toBe(true)
    expect(cut.returnedTokens).toBeLessThanOrEqual(250)
    expect(cut.totalTokens).toBe(estimateTokens(body))
    // Cut at a paragraph boundary: the returned text is a prefix ending on a full paragraph.
    expect(body.startsWith(cut.text)).toBe(true)
    expect(cut.text.endsWith(para)).toBe(true)
  })

  it('falls back to a hard cut when the nearest paragraph break is too early', () => {
    const body = `tiny\n\n${'x'.repeat(4000)}`
    const cut = truncateAtTokens(body, 500)
    expect(cut.truncated).toBe(true)
    // A paragraph cut would return just "tiny" (4 chars for a 500-token budget).
    expect(cut.text.length).toBeGreaterThan(1000)
  })
})
