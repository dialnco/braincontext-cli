// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderInboxBody } from './inboxText'

describe('renderInboxBody (escape-first)', () => {
  it.each([
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '"><svg onload=alert(1)>',
    '[x](javascript:alert(1))',
    '**<b onmouseover=alert(1)>x</b>**',
    '[[<img src=x onerror=alert(1)>]]',
    '`<script>`',
    '```\n</code></pre><script>alert(1)</script>\n```',
    'https://evil.example/"onmouseover="alert(1)',
  ])('never emits live markup for %s', (payload) => {
    const host = document.createElement('div')
    host.innerHTML = renderInboxBody(payload)
    const allowed = new Set(['P', 'BR', 'CODE', 'PRE', 'STRONG', 'SPAN', 'A'])
    for (const el of host.querySelectorAll('*')) {
      expect(allowed.has(el.tagName)).toBe(true)
      for (const attr of el.getAttributeNames()) {
        expect(['href', 'target', 'rel', 'class', 'data-wikilink']).toContain(attr)
      }
      const href = el.getAttribute('href')
      if (href !== null) expect(href).toMatch(/^https?:\/\//)
    }
  })

  it('formats the safe subset', () => {
    const html = renderInboxBody(
      'Hi **there**, see [[Billing API]] and https://x.dev/a?b=1&c=2\n\n`npm i`',
    )
    expect(html).toContain('<strong>there</strong>')
    expect(html).toContain('data-wikilink="Billing API"')
    expect(html).toContain('<a href="https://x.dev/a?b=1&amp;c=2"')
    expect(html).toContain('<code>npm i</code>')
  })
})
