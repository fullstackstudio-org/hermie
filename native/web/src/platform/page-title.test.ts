import { describe, expect, it } from 'vitest'

import { formatPageTitle, setPageTitle } from './page-title'

describe('the page title', () => {
  it('reads "<screen> · Hermie", or the app alone', () => {
    expect(formatPageTitle('Chats')).toBe('Chats · Hermie')
    expect(formatPageTitle(undefined)).toBe('Hermie')
    expect(formatPageTitle('')).toBe('Hermie')
    expect(formatPageTitle('Hermie')).toBe('Hermie')
  })

  it('names the tab', () => {
    setPageTitle('Settings')
    expect(document.title).toBe('Settings · Hermie')

    const target = { title: '' }
    setPageTitle(undefined, target)
    expect(target.title).toBe('Hermie')
  })
})
