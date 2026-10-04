import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale, setActiveLocale } from './active-locale'
import { createStrings, loadCatalogue, registerEnglish } from './catalogue'

afterEach(() => {
  resetActiveLocale()
})

interface Added {
  hermieTest: {
    page: {
      title: string
      days: readonly string[]
      count: (args: { count: number }) => string
    }
  }
}

describe('registerEnglish', () => {
  it('adds the keys a page loaded on demand reads to the tree, as the three kinds of value', () => {
    registerEnglish({
      'hermieTest.page.title': 'A page',
      'hermieTest.page.days': ['Mon', 'Tue'],
      'hermieTest.page.count': { template: '{count} things' }
    })

    const tree = createStrings<Added>()

    expect(tree.hermieTest.page.title).toBe('A page')
    expect(tree.hermieTest.page.days).toEqual(['Mon', 'Tue'])
    expect(tree.hermieTest.page.count({ count: 3 })).toBe('3 things')
  })

  it('is the same tree the rest of the client reads, which was handed out before', () => {
    const before = createStrings<Record<string, unknown>>()

    registerEnglish({ 'hermieTest.late.word': 'Late' })

    expect((before as unknown as { hermieTest: { late: { word: string } } }).hermieTest.late.word).toBe('Late')
  })

  it('leaves a key that is already there as it is', () => {
    registerEnglish({ 'hermieTest.fixed.word': 'First' })
    registerEnglish({ 'hermieTest.fixed.word': 'Second' })

    expect((createStrings() as { hermieTest: { fixed: { word: string } } }).hermieTest.fixed.word).toBe('First')
  })

  it('reads in the active language where it has the key, and in English where it does not', async () => {
    registerEnglish({ 'hermieTest.only.english': 'Only English' })
    await loadCatalogue('nl')
    setActiveLocale('nl')

    expect((createStrings() as { hermieTest: { only: { english: string } } }).hermieTest.only.english).toBe(
      'Only English'
    )
  })
})
