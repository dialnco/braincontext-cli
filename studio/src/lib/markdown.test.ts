// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { htmlToMarkdown, markdownToHtml } from './markdown'

const ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
const noResolve = () => ''

describe('file image rendering (bctx-file:// whitelist)', () => {
  it('renders the whitelisted syntax as an <img> and round-trips it', () => {
    const md = `intro\n\n![My pic](bctx-file://${ID})`
    const html = markdownToHtml(md, noResolve)
    const div = document.createElement('div')
    div.innerHTML = html
    const img = div.querySelector('img')
    expect(img).not.toBeNull()
    expect(img?.getAttribute('src')).toBe(`/api/files/${ID}/content`)
    expect(img?.getAttribute('data-file-id')).toBe(ID)
    expect(img?.getAttribute('alt')).toBe('My pic')
    expect(htmlToMarkdown(html)).toBe(md)
  })

  it('NEVER emits <img> for non-whitelisted urls (XSS)', () => {
    for (const bad of [
      '![x](javascript:alert(1))',
      '![x](https://evil.example/x.png)',
      '![x](data:image/png;base64,AAAA)',
      '![x](bctx-file://tooshort)',
      `![x](bctx-file://${ID.toLowerCase()})`, // wrong case = not a ULID per whitelist
    ]) {
      const html = markdownToHtml(bad, noResolve)
      expect(html).not.toContain('<img')
      expect(html).toContain('![x](') // stays literal text
    }
  })

  it('escapes hostile alt text', () => {
    const html = markdownToHtml(`!["><img onerror=alert(1) src=x>](bctx-file://${ID})`, noResolve)
    const div = document.createElement('div')
    div.innerHTML = html
    // Exactly the one whitelisted img — the alt payload did not become an element.
    expect(div.querySelectorAll('img').length).toBe(1)
    expect(div.querySelector('img')?.getAttribute('onerror')).toBeNull()
  })

  it('drops foreign <img> elements on serialize instead of emitting their urls', () => {
    expect(htmlToMarkdown('<p>a <img src="https://evil.example/t.png"> b</p>')).toBe('a  b')
    expect(htmlToMarkdown(`<img src="/api/files/${ID}/content">`)).toBe('') // no data-file-id
  })
})

describe('file attachment embeds (![[file:<id>|name]])', () => {
  it('renders a placeholder card and round-trips the marker', () => {
    const md = `![[file:${ID}|report.pdf]]`
    const html = markdownToHtml(md, noResolve)
    const div = document.createElement('div')
    div.innerHTML = html
    const node = div.querySelector('[data-file-embed]')
    expect(node).not.toBeNull()
    expect(node?.getAttribute('data-file-embed')).toBe(ID)
    expect(node?.getAttribute('data-file-name')).toBe('report.pdf')
    expect(node?.getAttribute('contenteditable')).toBe('false')
    // Distinct attribute keeps the datatable hydrator away from it.
    expect(node?.hasAttribute('data-embed-title')).toBe(false)
    expect(htmlToMarkdown(html)).toBe(md)
  })

  it('round-trips even after hydration replaced the card contents', () => {
    const html = markdownToHtml(`![[file:${ID}|a.pdf]]`, noResolve)
    const div = document.createElement('div')
    div.innerHTML = html
    const node = div.querySelector('[data-file-embed]') as HTMLElement
    node.innerHTML = '<div>hydrated card with <a href="/api/x">Download</a></div>'
    expect(htmlToMarkdown(div.innerHTML)).toBe(`![[file:${ID}|a.pdf]]`)
  })

  it('does not hijack normal transclusions', () => {
    const html = markdownToHtml('![[My Table]]', noResolve)
    const div = document.createElement('div')
    div.innerHTML = html
    expect(div.querySelector('[data-embed-title]')?.getAttribute('data-embed-title')).toBe(
      'My Table',
    )
    expect(div.querySelector('[data-file-embed]')).toBeNull()
  })
})
