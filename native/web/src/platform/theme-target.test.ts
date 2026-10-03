import { describe, expect, it } from 'vitest'

import { applyTheme, SCHEME_ATTRIBUTE, TINT_ATTRIBUTE } from './theme-target'

describe('the theme target', () => {
  it('pins a scheme and names the tint', () => {
    const root = document.createElement('html')

    applyTheme({ scheme: 'dark', tint: 'teal' }, root)

    expect(root.getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')
    expect(root.getAttribute(TINT_ATTRIBUTE)).toBe('teal')
  })

  it('writes no scheme for "system", and takes a pinned one off', () => {
    const root = document.createElement('html')

    applyTheme({ scheme: 'light', tint: 'blue' }, root)
    applyTheme({ scheme: 'system', tint: 'blue' }, root)

    expect(root.hasAttribute(SCHEME_ATTRIBUTE)).toBe(false)
  })

  it('defaults to the page’s own root', () => {
    applyTheme({ scheme: 'dark', tint: 'green' })

    expect(document.documentElement.getAttribute(SCHEME_ATTRIBUTE)).toBe('dark')

    applyTheme({ scheme: 'system', tint: 'blue' })
    document.documentElement.removeAttribute(TINT_ATTRIBUTE)
  })

  it('does nothing without a target', () => {
    expect(() => applyTheme({ scheme: 'dark', tint: 'blue' }, null)).not.toThrow()
  })
})
