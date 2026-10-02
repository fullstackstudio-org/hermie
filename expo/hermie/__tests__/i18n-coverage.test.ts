/**
 * Completeness: a language that claims a string table has to answer all of it.
 *
 * This is the test that fails when somebody adds an English key and stops
 * there. The claim lives in `i18n/coverage.ts` rather than here, so the list of
 * string tables cannot drift out of step with the app — `ENGLISH_TREES` is what
 * the app itself reads.
 *
 * Three failures, deliberately separate, because they need three different
 * fixes:
 *
 *  - a MISSING key needs a translation, or an allow-list entry naming it;
 *  - a STALE allow-list entry needs deleting, because an allow-list nobody
 *    prunes stops being an allow-list and becomes a hole;
 *  - a STRAY translation needs deleting, because it is a key that was renamed
 *    in English and left a Dutch sentence behind that nothing will ever paint.
 */
import { resetActiveLocale } from '../src/i18n/active-locale'
import { catalogueFor, missingKeys, strayKeys, type TreeName } from '../src/i18n/catalogue'
import { excusedKeys, TRANSLATED_TREES, UNTRANSLATED_KEYS, type TranslatedLocale } from '../src/i18n/coverage'
import { TRANSLATED_LOCALES } from '../src/i18n/locales'
import { ENGLISH_TREES, TREE_NAMES } from '../src/i18n/trees'

beforeEach(() => {
  // The walkers read the English trees through their own proxies, which are
  // transparent under English and not under anything else.
  resetActiveLocale()
})

const claimed = (locale: TranslatedLocale): readonly TreeName[] => TRANSLATED_TREES[locale]

describe.each(TRANSLATED_LOCALES)('%s', locale => {
  it('claims only trees the app actually has', () => {
    for (const tree of claimed(locale)) {
      expect(TREE_NAMES).toContain(tree)
    }
  })

  it('answers every key in the trees it claims', () => {
    const gaps: string[] = []

    for (const tree of claimed(locale)) {
      const excused = excusedKeys(locale, tree)

      for (const key of missingKeys(ENGLISH_TREES[tree], catalogueFor(locale, tree))) {
        if (!excused.has(key)) {
          gaps.push(`${tree}.${key}`)
        }
      }
    }

    // Named rather than counted: the failure message IS the to-do list, and a
    // count would tell whoever reads it nothing about where to start.
    expect(gaps).toEqual([])
  })

  it('keeps no allow-list entry for a key that has since been translated', () => {
    const stale: string[] = []

    for (const entry of UNTRANSLATED_KEYS[locale]) {
      const [tree, ...rest] = entry.split('.')
      const key = rest.join('.')

      if (!tree || !TREE_NAMES.includes(tree as TreeName)) {
        stale.push(`${entry} (no such tree)`)
        continue
      }

      const missing = missingKeys(ENGLISH_TREES[tree as TreeName], catalogueFor(locale, tree as TreeName))

      if (!missing.includes(key)) {
        stale.push(entry)
      }
    }

    expect(stale).toEqual([])
  })

  it('has no translation left behind by a renamed English key', () => {
    const strays: string[] = []

    for (const tree of TREE_NAMES) {
      for (const key of strayKeys(ENGLISH_TREES[tree], catalogueFor(locale, tree))) {
        strays.push(`${tree}.${key}`)
      }
    }

    expect(strays).toEqual([])
  })
})

describe('the harness itself', () => {
  it("walks the app's own list of string tables", () => {
    // Not a list of its own. A twelfth string table added to the app appears
    // here the moment `trees.ts` learns about it, which is the same moment the
    // app starts painting it.
    expect(TREE_NAMES.length).toBeGreaterThan(0)
    expect(Object.keys(ENGLISH_TREES).sort()).toEqual([...TREE_NAMES].sort())
  })

  it('notices a gap in a tree a language claims', () => {
    // An empty catalogue stands in for a language that claimed a tree and then
    // translated none of it. Every English leaf comes back as a gap, which is
    // exactly what the check above reports — and the fixture is empty rather
    // than a real catalogue so that this keeps proving the mechanism as the
    // catalogues fill up.
    const gaps = missingKeys(ENGLISH_TREES.mcp, {})

    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps).toContain('title')
  })
})
