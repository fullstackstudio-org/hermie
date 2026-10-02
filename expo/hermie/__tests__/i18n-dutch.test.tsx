/**
 * Dutch, as a reader meets it.
 *
 * The completeness test next door proves every key is answered. This one is
 * about the answers themselves, and it pins the three things a catalogue gets
 * wrong in ways no type can catch:
 *
 *  1. the register. Hermie addresses one person about their own bots on their
 *     own machine, so it says `je`. A `u` anywhere in the catalogue is a
 *     different product talking;
 *  2. the glossary. `gateway`, `Crons`, `Boards`, `Skills` and `MCP` are the
 *     product's own words — translating them costs the reader a translation
 *     step back the moment they open the gateway's dashboard or run
 *     `hermes skills list`;
 *  3. that it actually reaches a screen, rather than sitting in a file nothing
 *     imports.
 */
import { act, render, screen } from '@testing-library/react-native'

import { resetActiveLocale, setActiveLocale } from '../src/i18n/active-locale'
import { catalogueFor } from '../src/i18n/catalogue'
import { TREE_NAMES } from '../src/i18n/trees'
import { cronStrings } from '../src/features/cron/strings'
import { kanbanStrings } from '../src/features/kanban/strings'
import { mcpStrings } from '../src/features/mcp/strings'
import { skillStrings } from '../src/features/skills/strings'
import { strings } from '../src/i18n/strings'
import { AppearanceSection } from '../src/features/settings/AppearanceSection'
import { resetLanguageStore } from '../src/store/language'
import { withProviders } from './support/render'

beforeEach(() => {
  setActiveLocale('nl')
})

afterEach(() => {
  act(() => {
    resetLanguageStore()
  })
  resetActiveLocale()
})

/** Every static string in a catalogue, with the path it was found at. */
function leaves(node: unknown, prefix = ''): { path: string; value: string }[] {
  if (typeof node === 'string') {
    return [{ path: prefix, value: node }]
  }

  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return []
  }

  return Object.entries(node).flatMap(([key, value]) => leaves(value, prefix ? `${prefix}.${key}` : key))
}

const dutchLeaves = TREE_NAMES.flatMap(tree => leaves(catalogueFor('nl', tree), tree))

describe('the register', () => {
  it('says `je`, never `u`', () => {
    // Word boundaries, because `u` is a letter: `nu`, `uw` inside `nieuw` and
    // the `u` in `menu` are not the pronoun. Capitalised forms count — a
    // sentence that opens with `Uw` is the same mistake.
    const formal = /(^|[\s(„"'])(u|uw|Uw|U)([\s.,;:!?)"']|$)/u

    const offenders = dutchLeaves.filter(leaf => formal.test(leaf.value)).map(leaf => `${leaf.path}: ${leaf.value}`)

    expect(offenders).toEqual([])
  })

  it('carries at least one `je`, so the check above is not passing on an empty set', () => {
    expect(dutchLeaves.some(leaf => /(^|\s)(je|jij|jouw|Je|Jouw)([\s.,;:!?]|$)/u.test(leaf.value))).toBe(true)
    expect(dutchLeaves.length).toBeGreaterThan(500)
  })
})

describe('the glossary', () => {
  it('leaves the product vocabulary in English', () => {
    expect(cronStrings.title).toBe('Crons')
    expect(kanbanStrings.title).toBe('Boards')
    expect(skillStrings.title).toBe('Skills')
    expect(mcpStrings.title).toBe('MCP servers')
    expect(strings.tabs.routines).toBe('Crons')
  })

  it('does not translate a shell command', () => {
    // A terminal does not speak Dutch. These are typed, not read.
    expect(kanbanStrings.absentCommand).toBe('hermes plugins install kanban')
    expect(mcpStrings.emptyHint).toContain('hermes mcp add')
  })

  it('keeps `gateway` untranslated inside a translated sentence', () => {
    expect(strings.onboarding.welcome.action).toBe('Een gateway instellen')
  })
})

describe('a screen', () => {
  it('paints Dutch', () => {
    render(withProviders(<AppearanceSection onOpenAdvanced={() => undefined} />))

    expect(screen.getByText('WEERGAVE')).toBeTruthy()
    // `InsetGroup` uppercases every header at render now (HERM-106), so a
    // section header is 'TAAL' whatever case the string is stored in.
    expect(screen.getByText('TAAL')).toBeTruthy()
    // The languages still name themselves, in every language.
    expect(screen.getByText('Nederlands')).toBeTruthy()
    expect(screen.getByText('Deutsch')).toBeTruthy()
  })
})
