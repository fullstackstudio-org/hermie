/**
 * The Settings skin: the coloured marks, the header card, and the sidebar.
 *
 * HERM-108 landed the right structure and the wrong surface — the owner's verdict
 * was that it does not look like anything. This file is what keeps the answer
 * true, and it is deliberately about the RULES rather than about pixels:
 *
 *  - every category has a mark and a colour, and the colour comes out of the
 *    accent set rather than out of a component,
 *  - no two categories NEXT to each other share a colour, in every build this
 *    app ships (a platform with no voice, a release with no Advanced),
 *  - no category borrows a hue that `ok` or `danger` owns, so a coloured square
 *    can never be read as a state,
 *  - white on every well clears AA, measured with the same arithmetic
 *    `npm run contrast:check` uses,
 *  - a category page has ONE heading — the card — and the bar above it has none,
 *  - the sidebar's search actually searches, including the pages a category holds
 *    rather than only the twelve names.
 *
 * Where a back control goes is not asserted here: `settings-routes.test.tsx` walks
 * all 28 routes for that, and this file must not be a second, weaker copy of it.
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react-native'

import { catalogueFor } from '../src/i18n/catalogue'
import { strings } from '../src/i18n/strings'
import { SettingsScreen } from '../src/features/settings'
import {
  CATEGORY_TINTS,
  categoryWell,
  SETTINGS_CATEGORIES,
  SETTINGS_CATEGORY_LOOK,
  settingsCategory,
  settingsTitle,
  visibleCategories,
  type SettingsCategoryName,
  type SettingsRouteName
} from '../src/features/settings/navigation'
import { AA_TEXT, contrastRatio, parseColor } from '../src/ui/contrast'
import { ACCENT_ORDER, lightColors } from '../src/ui/tokens'
import { renderScreen } from './support/render'

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: () => () => undefined
}))

jest.mock('../src/features/settings/licences-data', () => ({
  loadLicenceData: async () => ({
    generatedBy: 'scripts/generate-third-party-licenses.mjs',
    scope: 'production dependencies of expo/hermie',
    excludesWorkspacePackages: [],
    packages: [],
    texts: {}
  })
}))

/**
 * `mock`-prefixed so the hoisted `jest.mock` factory below is allowed to close
 * over it. Tests for the account row's bold-line rule reassign this before
 * rendering, to reach the cases a fixed config cannot: a host with no name, and
 * neither.
 */
let mockGatewayConfig: Record<string, unknown> | null = {
  authMode: 'native_pkce',
  baseUrl: 'https://gateway.example.com',
  userDisplayName: 'Sam',
  version: '1'
}

jest.mock('../src/gateway', () => ({
  useGateway: () => ({
    changeGateway: jest.fn(),
    config: mockGatewayConfig,
    signOut: jest.fn(),
    status: 'ready'
  })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({ useChatRuntime: () => ({ push: null }) }))

/** Open Settings on one page, with its ancestors under it. */
async function open(route: SettingsRouteName) {
  renderScreen(<SettingsScreen initialRoute={route} />)

  await waitFor(() => expect(screen.getByTestId(`settings-page-${route}`)).toBeTruthy())
}

/** Report a width the way a real layout pass would, so the split layout comes up. */
function layout(width: number) {
  fireEvent(screen.getByTestId('settings-host'), 'layout', { nativeEvent: { layout: { width, height: 900 } } })
}

/** The sidebar, once the host is wide enough to draw one. */
async function openSidebar() {
  await open('Root')
  act(() => layout(1200))

  return waitFor(() => screen.getByTestId('settings-category-column'))
}

describe('the mark each category carries', () => {
  it('gives all twelve an icon and a colour', () => {
    for (const name of SETTINGS_CATEGORIES) {
      const look = SETTINGS_CATEGORY_LOOK[name]

      expect(look.icon).toBeTruthy()
      expect(CATEGORY_TINTS).toContain(look.tint)
    }
  })

  /**
   * The narrowing, as a rule rather than as a comment.
   *
   * `green` and `red` are what `ok` and `danger` mean, and `lime` is the studio's
   * ring colour — white on its fill measures 1.18 : 1. A category that reached for
   * any of the three would be a square that either lies about a state or cannot be
   * seen.
   */
  it('leaves the status hues and the ring colour out of the set', () => {
    for (const reserved of ['green', 'red', 'lime'] as const) {
      expect(ACCENT_ORDER).toContain(reserved)
      expect(CATEGORY_TINTS).not.toContain(reserved)
    }
  })

  it('keeps white legible on every well, by the contrast check’s own arithmetic', () => {
    for (const name of SETTINGS_CATEGORIES) {
      expect(contrastRatio(lightColors.onAccent, parseColor(categoryWell(name)).rgb)).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })

  /**
   * Adjacent rows differ, in EVERY build.
   *
   * Two categories hide themselves — Voice where the platform has neither speech
   * engine nor recogniser, Advanced in a release build — and hiding one closes a
   * gap, which can put two rows of the same colour against each other in a list
   * nobody tested. So the check is over every subset of the hideable ones rather
   * than over the full order alone, and the hideable set is read off the registry
   * instead of typed here.
   */
  it('never puts two of one colour next to each other, whichever categories this build shows', () => {
    const hideable = SETTINGS_CATEGORIES.filter(name => settingsCategory(name).visible)

    expect(hideable.length).toBeGreaterThan(0)

    for (let mask = 0; mask < 2 ** hideable.length; mask += 1) {
      const hidden = new Set(hideable.filter((_, at) => (mask >> at) % 2 === 1))
      const order = SETTINGS_CATEGORIES.filter(name => !hidden.has(name))

      for (let at = 1; at < order.length; at += 1) {
        const previous = order[at - 1] as SettingsCategoryName
        const current = order[at] as SettingsCategoryName

        expect(`${previous}/${current}: ${SETTINGS_CATEGORY_LOOK[current].tint}`).not.toBe(
          `${previous}/${current}: ${SETTINGS_CATEGORY_LOOK[previous].tint}`
        )
      }
    }
  })

  it('draws one beside every row in the list', async () => {
    await open('Root')

    // Not Account: it has no list row of its own here any more, only the
    // account row above the list, which carries an avatar rather than a mark.
    for (const name of visibleCategories().filter(candidate => candidate !== 'Account')) {
      expect(screen.getByTestId(`settings-mark-${name}`)).toBeTruthy()
    }
  })
})

describe('the sentence on each category’s card', () => {
  it('is a sentence in English for all twelve, and not the category’s own name', () => {
    for (const name of SETTINGS_CATEGORIES) {
      const blurb = SETTINGS_CATEGORY_LOOK[name].blurb()

      expect(blurb.length).toBeGreaterThan(20)
      expect(blurb).not.toBe(settingsTitle(name))
      expect(blurb.endsWith('.')).toBe(true)
    }
  })

  it.each(['nl', 'de'] as const)('is translated into %s, and says something different', locale => {
    const tree = catalogueFor(locale, 'app') as {
      settings?: { categories?: { blurb?: Record<string, string> } }
    }
    const translated = tree.settings?.categories?.blurb ?? {}
    const english = strings.settings.categories.blurb as unknown as Record<string, string>

    for (const key of Object.keys(english)) {
      expect(typeof translated[key]).toBe('string')
      expect(translated[key]).not.toBe(english[key])
      expect((translated[key] ?? '').length).toBeGreaterThan(20)
    }
  })
})

describe('a category page', () => {
  it('opens with the header card, and draws no title bar over it', async () => {
    await open('Appearance')

    const card = screen.getByTestId('settings-header-Appearance')

    expect(within(card).getByTestId('settings-header-Appearance-title')).toHaveTextContent(
      strings.settings.categories.appearance
    )
    expect(within(card).getByTestId('settings-header-Appearance-blurb')).toHaveTextContent(
      strings.settings.categories.blurb.appearance
    )

    /*
      One heading, not two. The chrome above still draws its back control — the
      route walk proves that for all 28 — and the name is the card's, once, so the
      category's title appears exactly once on the page.
    */
    expect(screen.getAllByText(strings.settings.categories.appearance)).toHaveLength(1)
    expect(screen.getByTestId('page-back')).toBeTruthy()
  })

  it('leaves the root’s own title bar alone', async () => {
    await open('Root')

    // `Root` is not a category: it keeps the centred title it always had, and it
    // grows no header card.
    expect(screen.getByText(strings.settings.title)).toBeTruthy()
    expect(screen.queryByTestId('settings-header-Root')).toBeNull()
  })

  it('carries the same mark the row that opened it did', async () => {
    await open('Notifications')

    expect(screen.getByTestId('settings-mark-Notifications')).toBeTruthy()
  })
})

describe('the sidebar', () => {
  it('leads with who this device is signed in as', async () => {
    const column = await openSidebar()

    expect(within(column).getByTestId('settings-account-name')).toHaveTextContent('Sam')
    expect(within(column).getByText('gateway.example.com')).toBeTruthy()
  })

  it('opens Account from that row', async () => {
    const column = await openSidebar()

    fireEvent.press(within(column).getByTestId('settings-account-row'))

    await waitFor(() => expect(screen.getByTestId('settings-page-Account')).toBeTruthy())
  })

  it('marks the category whose page is open beside it', async () => {
    const column = await openSidebar()
    // Not `visibleCategories()[0]` (Account): that category has no row of its
    // own in the list any more, so "the one that's open" is proven with a
    // category the account row does not also stand for.
    const open = visibleCategories().find(name => name !== 'Account') as SettingsCategoryName

    fireEvent.press(within(column).getByTestId(`settings-cat-${open}`))

    await waitFor(() =>
      expect(within(column).getByTestId(`settings-cat-${open}`).props.accessibilityState.selected).toBe(true)
    )
  })

  it('is the only place the search field is drawn', async () => {
    await open('Root')

    expect(screen.queryByTestId('settings-search')).toBeNull()

    act(() => layout(1200))
    await waitFor(() => expect(screen.getByTestId('settings-search')).toBeTruthy())
  })

  it('has no separate Account row: the account row is the only way in', async () => {
    const column = await openSidebar()

    expect(within(column).getByTestId('settings-account-row')).toBeTruthy()
    expect(within(column).queryByTestId('settings-cat-Account')).toBeNull()
  })
})

describe('the phone list', () => {
  it('leads with the account row too, and drops the separate Account row', async () => {
    await open('Root')

    expect(screen.getByTestId('settings-account-row')).toBeTruthy()
    expect(screen.queryByTestId('settings-cat-Account')).toBeNull()
    // The rest of the list is untouched.
    expect(screen.getByTestId('settings-cat-Gateways')).toBeTruthy()
  })

  it('opens Account from the account row', async () => {
    await open('Root')

    fireEvent.press(screen.getByTestId('settings-account-row'))

    await waitFor(() => expect(screen.getByTestId('settings-page-Account')).toBeTruthy())
  })
})

describe('the account row’s bold line', () => {
  const defaultConfig = mockGatewayConfig

  afterEach(() => {
    mockGatewayConfig = defaultConfig
  })

  it('bolds the name and puts the host underneath, when a name is known', async () => {
    // The suite's default config already has a name; this is the baseline the
    // other two cases are a fallback FROM.
    await open('Root')

    expect(screen.getByTestId('settings-account-name')).toHaveTextContent('Sam')
    expect(screen.getByText('gateway.example.com')).toBeTruthy()
  })

  it('bolds the host and puts the auth mode underneath, when there is no name', async () => {
    mockGatewayConfig = {
      authMode: 'session_token',
      baseUrl: 'http://127.0.0.1:8787',
      version: '1'
    }

    await open('Root')

    // The bug this fixes: bold and quiet were swapped, so the host sat under
    // an auth mode wrongly given the bold line.
    expect(screen.getByTestId('settings-account-name')).toHaveTextContent('127.0.0.1')
    expect(screen.getByText(strings.settings.authModeToken)).toBeTruthy()
  })

  it('keeps the plain signed-out wording when there is neither a name nor a host', async () => {
    mockGatewayConfig = null

    await open('Root')

    expect(screen.getByTestId('settings-account-name')).toHaveTextContent(strings.settings.categories.summary.signedOut)
  })
})

describe('the sidebar’s search', () => {
  /** Type into the field, the way a keyboard would. */
  async function type(text: string) {
    const column = await openSidebar()

    act(() => fireEvent.changeText(within(column).getByTestId('settings-search'), text))

    return column
  }

  it('narrows the list to the categories that match a name', async () => {
    const column = await type('memory')

    expect(within(column).getByTestId('settings-cat-Memory')).toBeTruthy()
    expect(within(column).queryByTestId('settings-cat-Appearance')).toBeNull()
  })

  it('finds a page by the state under a category rather than by its name', async () => {
    const column = await type('gateway.example.com')

    // Nothing is called that; it is the line under Gateways and under Account.
    expect(within(column).getByTestId('settings-cat-Gateways')).toBeTruthy()
    expect(within(column).queryByTestId('settings-cat-Memory')).toBeNull()
  })

  /**
   * The half that makes it worth building: the licences are two levels down from
   * About, and a search over twelve category names would answer nothing while the
   * page sat right there in the registry.
   */
  it('reaches the pages a category holds, and says which one matched', async () => {
    const column = await type('licence')

    const row = within(column).getByTestId('settings-cat-About')

    expect(row).toBeTruthy()
    expect(within(column).getByTestId('settings-cat-About-summary')).toHaveTextContent(strings.settings.licences)
    expect(within(column).queryByTestId('settings-cat-Account')).toBeNull()
  })

  it('says so when nothing matches, rather than showing an empty column', async () => {
    const column = await type('zzzzz nothing')

    expect(within(column).getByTestId('settings-search-empty')).toHaveTextContent(strings.settings.search.noMatches)
    expect(within(column).queryByTestId('settings-cat-Account')).toBeNull()
  })

  it('puts the whole list back when the field is cleared', async () => {
    const column = await type('memory')

    expect(within(column).queryByTestId('settings-cat-Appearance')).toBeNull()

    act(() => fireEvent.changeText(within(column).getByTestId('settings-search'), ''))

    expect(within(column).getByTestId('settings-cat-Appearance')).toBeTruthy()
    expect(within(column).getByTestId('settings-account-row')).toBeTruthy()
  })

  it('still opens a category the ordinary way once it has been found', async () => {
    const column = await type('memory')

    fireEvent.press(within(column).getByTestId('settings-cat-Memory'))

    await waitFor(() => expect(screen.getByTestId('settings-page-Memory')).toBeTruthy())
  })
})
