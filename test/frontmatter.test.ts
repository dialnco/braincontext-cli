import { describe, expect, it } from 'vitest'
import { parseFrontmatter, stringifyFrontmatter } from '../src/lib/frontmatter'

describe('frontmatter', () => {
  it('parses frontmatter data + body, including lists', () => {
    const { data, body } = parseFrontmatter('---\nname: x\ntags:\n  - a\n  - b\n---\nhello\n')
    expect(data.name).toBe('x')
    expect(data.tags).toEqual(['a', 'b'])
    expect(body.trim()).toBe('hello')
  })

  it('round-trips data and body', () => {
    const md = stringifyFrontmatter({ name: 'x', list: ['a', 'b'] }, 'body text\n')
    const { data, body } = parseFrontmatter(md)
    expect(data).toEqual({ name: 'x', list: ['a', 'b'] })
    expect(body.trim()).toBe('body text')
  })

  it('treats input without frontmatter as all body', () => {
    const { data, body } = parseFrontmatter('no frontmatter here')
    expect(data).toEqual({})
    expect(body).toBe('no frontmatter here')
  })

  it('preserves the blank line after the closing --- (byte round-trip)', () => {
    const original = '---\nname: demo\n---\n\n# Title\n\nBody.\n'
    const { data, body } = parseFrontmatter<Record<string, unknown>>(original)
    expect(stringifyFrontmatter(data, body)).toBe(original)
  })

  it('does not invent a blank line when there was none', () => {
    const original = '---\nname: demo\n---\nBody.\n'
    const { data, body } = parseFrontmatter<Record<string, unknown>>(original)
    expect(stringifyFrontmatter(data, body)).toBe(original)
  })
})
