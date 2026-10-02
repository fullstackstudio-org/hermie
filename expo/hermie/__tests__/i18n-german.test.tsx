/**
 * German, as a reader meets it.
 *
 * The same three things the Dutch suite pins, with one difference that matters:
 * German is the language most likely to break a layout. `Einstellungen` is five
 * characters longer than `Settings` and it is a tab label. So this suite also
 * measures the surfaces that have no room to grow, and where German simply does
 * not fit the file says so rather than the test pretending otherwise.
 */
import { act, render, screen } from '@testing-library/react-native'

import { resetActiveLocale, setActiveLocale } from '../src/i18n/active-locale'
import { catalogueFor } from '../src/i18n/catalogue'
import { TREE_NAMES } from '../src/i18n/trees'
import { chatStrings } from '../src/chat-ui/strings'
import { cronStrings } from '../src/features/cron/strings'
import { kanbanStrings } from '../src/features/kanban/strings'
import { mcpStrings } from '../src/features/mcp/strings'
import { skillStrings } from '../src/features/skills/strings'
import { strings } from '../src/i18n/strings'
import { AppearanceSection } from '../src/features/settings/AppearanceSection'
import { resetLanguageStore } from '../src/store/language'
import { withProviders } from './support/render'

beforeEach(() => {
  setActiveLocale('de')
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

const germanLeaves = TREE_NAMES.flatMap(tree => leaves(catalogueFor('de', tree), tree))

describe('the register', () => {
  it('says `du`, never `Sie`', () => {
    // `Sie` capitalised mid-sentence is the formal pronoun; `sie` lower case is
    // "she"/"they" and is fine. A sentence may also legitimately OPEN with
    // `Sie`, so the boundary check is deliberately about the mid-sentence case,
    // plus the possessives, which have no innocent reading here.
    const formal = /(?<=[a-zäöüß,] )(Sie|Ihnen|Ihre|Ihrem|Ihren|Ihrer|Ihres|Ihr)(?=[\s.,;:!?]|$)/u

    const offenders = germanLeaves.filter(leaf => formal.test(leaf.value)).map(leaf => `${leaf.path}: ${leaf.value}`)

    expect(offenders).toEqual([])
  })

  it('carries `du` and its cases, so the check above is not passing on an empty set', () => {
    expect(
      germanLeaves.some(leaf => /(^|\s)(du|dein|deine|deinem|dich|dir|Du|Dein)([\s.,;:!?]|$)/u.test(leaf.value))
    ).toBe(true)
    expect(germanLeaves.length).toBeGreaterThan(500)
  })

  it('spells the sharp s where German spells it', () => {
    // `schliessen` for `schließen` is the tell of a catalogue typed on the
    // wrong keyboard, and it is the kind of thing nothing else would notice.
    const wrong = germanLeaves
      .filter(leaf => /\b(schliessen|heisst|gross|weiss|ausserdem|massgeblich)\b/u.test(leaf.value))
      .map(leaf => leaf.path)

    expect(wrong).toEqual([])
    expect(germanLeaves.some(leaf => leaf.value.includes('ß'))).toBe(true)
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
    expect(kanbanStrings.absentCommand).toBe('hermes plugins install kanban')
    expect(mcpStrings.emptyHint).toContain('hermes mcp add')
  })

  it('keeps `Gateway` as a German noun rather than a translation', () => {
    // German capitalises nouns, so the English word is inflected around rather
    // than replaced: `Gateway-Adresse`, not `Torweg-Adresse`.
    expect(strings.onboarding.address.title).toBe('Gateway-Adresse')
  })
})

describe('the surfaces with no room to grow', () => {
  /**
   * The segmented control splits ONE row evenly between its options
   * (`ui/sheets/controls.tsx`), at 13pt semibold. On a 375pt phone that is
   * roughly 80pt a segment for three options — so the measure that matters is
   * the WIDEST option, not the total.
   *
   * A label that still does not fit wraps onto a second line rather than
   * being clipped (HERM-125, `numberOfLines={2}`), which is what the four-way
   * text-size row needs and the three-way rows below do not — see
   * `chat-text-size.test.tsx` for that one.
   */
  const widest = (values: readonly string[]): number => Math.max(...values.map(value => value.length))

  it('keeps the three-way segmented rows inside the English width', () => {
    // Verbosity, which is the tightest of them: three options on one row.
    expect(widest(Object.values(chatStrings.options.verbosityOptions))).toBeLessThanOrEqual(
      widest(['Quiet', 'Normal', 'Verbose'])
    )
  })

  it('keeps the five-way speaking-rate row inside the English width', () => {
    expect(widest(Object.values(chatStrings.voice.rateOptions))).toBeLessThanOrEqual(
      widest(['Slowest', 'Slow', 'Normal', 'Fast', 'Fastest'])
    )
  })

  it('keeps the light/dark options inside the English width', () => {
    expect(widest(Object.values(strings.settings.themeOptions))).toBeLessThanOrEqual(
      widest(['System', 'Light', 'Dark'])
    )
  })
})

describe('a screen', () => {
  it('paints German', () => {
    render(withProviders(<AppearanceSection onOpenAdvanced={() => undefined} />))

    expect(screen.getByText('DARSTELLUNG')).toBeTruthy()
    // `InsetGroup` uppercases every header at render now (HERM-106), so a
    // section header is 'SPRACHE' whatever case the string is stored in.
    expect(screen.getByText('SPRACHE')).toBeTruthy()
    expect(screen.getByText('Nederlands')).toBeTruthy()
    expect(screen.getByText('Deutsch')).toBeTruthy()
  })
})
