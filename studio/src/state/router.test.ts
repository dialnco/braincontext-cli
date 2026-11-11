import { describe, expect, it } from 'vitest'
import { viewOf } from './router'

describe('viewOf', () => {
  it('maps every top-level view route to its own view', () => {
    expect(viewOf(['contexts'])).toBe('contexts')
    expect(viewOf(['contexts', '01H'])).toBe('contexts')
    expect(viewOf(['inbox'])).toBe('inbox')
    expect(viewOf(['inbox', '42'])).toBe('inbox')
    expect(viewOf(['settings'])).toBe('settings')
  })

  it('treats everything else as the wiki', () => {
    expect(viewOf([])).toBe('wiki')
    expect(viewOf(['page', '01H'])).toBe('wiki')
    expect(viewOf(['graph'])).toBe('wiki')
    expect(viewOf(['wiki'])).toBe('wiki')
  })
})
