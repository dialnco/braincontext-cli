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
})
