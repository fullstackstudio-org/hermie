/**
 * `PageChrome`, `usePageScroll` and the `InsetGroup` casing fix (HERM-101/106).
 *
 * Standalone: nothing in the app renders `PageChrome` yet, so this is the only
 * place its contract is proved before later tasks wire it into real screens.
 */
import { act, fireEvent, screen } from '@testing-library/react-native'
import { Platform } from 'react-native'

import { catalogueFor } from '../src/i18n/catalogue'
import { chatStrings } from '../src/chat-ui/strings'
import { strings } from '../src/i18n/strings'
import { PageChrome, pageScrollProps, usePageScroll } from '../src/ui/chrome'
import { Text } from '../src/ui/primitives'
import { renderScreen } from './support/render'

const mockEscapeListeners = new Set<() => void>()

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

/** Press Escape, the way the native module would deliver it — see `escape-key.test.tsx`. */
function pressEscape() {
  act(() => {
    for (const listener of [...mockEscapeListeners]) {
      listener()
    }
  })
}

beforeEach(() => mockEscapeListeners.clear())

describe('PageChrome — the back control', () => {
  it('renders exactly one page-back control when back is given', () => {
    renderScreen(<PageChrome back={{ label: 'Bots', onPress: jest.fn() }} title="Activity" />)

    // `getByTestId` throws on zero OR more than one match, which is exactly
    // "exactly one" — a second back control anywhere in the tree fails this
    // the same way a missing one does.
    expect(screen.getByTestId('page-back')).toBeTruthy()
  })

  it('renders no back control at all when back is absent', () => {
    renderScreen(<PageChrome title="Bots" />)

    expect(screen.queryByTestId('page-back')).toBeNull()
  })

  it('reads out and fires the label it was given, not a generic "Back"', () => {
    const onPress = jest.fn()

    renderScreen(<PageChrome back={{ label: 'Gateways', onPress }} title="Gateway" />)

    const back = screen.getByTestId('page-back')

    expect(back.props.accessibilityLabel).toBe('Gateways')

    fireEvent.press(back)
    expect(onPress).toHaveBeenCalledTimes(1)
  })
})

describe('PageChrome — Escape', () => {
  it('calls back.onPress when back is present', () => {
    const onPress = jest.fn()

    renderScreen(<PageChrome back={{ label: 'Bots', onPress }} title="Activity" />)

    pressEscape()

    expect(onPress).toHaveBeenCalledTimes(1)
  })

  it('registers nothing, and does nothing, when back is absent', () => {
    renderScreen(<PageChrome title="Bots" />)

    // A tab root must not swallow Escape on behalf of whatever opened over it —
    // it never even joins the stack.
    expect(mockEscapeListeners.size).toBe(0)

    expect(() => pressEscape()).not.toThrow()
  })
})

describe('pageScrollProps — the platform split', () => {
  const ORIGINAL_OS = Platform.OS

  afterEach(() => {
    Platform.OS = ORIGINAL_OS
  })

  it('carries contentInset on iOS, so a sticky header stops under the glass', () => {
    Platform.OS = 'ios'

    const props = pageScrollProps(64)

    expect(props.contentInset).toEqual({ top: 64 })
    expect(props.contentOffset).toEqual({ x: 0, y: -64 })
    expect(props.scrollIndicatorInsets).toEqual({ top: 64 })
    expect(props.contentContainerStyle).toBeUndefined()
  })

  it('carries contentContainerStyle.paddingTop on Android, not contentInset', () => {
    Platform.OS = 'android'

    const props = pageScrollProps(64)

    expect(props.contentContainerStyle).toEqual({ paddingTop: 64 })
    expect(props.contentInset).toBeUndefined()
  })

  it('carries contentContainerStyle.paddingTop on web too', () => {
    Platform.OS = 'web'

    const props = pageScrollProps(48)

    expect(props.contentContainerStyle).toEqual({ paddingTop: 48 })
  })
})

describe('usePageScroll — reading PageChrome’s own measured height', () => {
  const ORIGINAL_OS = Platform.OS

  afterEach(() => {
    Platform.OS = ORIGINAL_OS
  })

  function ScrollProbe() {
    const props = usePageScroll()

    return <Text testID="scroll-probe">{JSON.stringify(props)}</Text>
  }

  it('is 0 before anything has measured, and updates once the header lays out', () => {
    Platform.OS = 'ios'

    renderScreen(<PageChrome title="Activity" trailing={<ScrollProbe />} />)

    // JSON has no signed zero, so a still-unmeasured -0 comes back as 0 —
    // `pageScrollProps` itself is exercised precisely on that sign above.
    expect(JSON.parse(screen.getByTestId('scroll-probe').props.children)).toEqual({
      contentInset: { top: 0 },
      contentOffset: { x: 0, y: 0 },
      scrollIndicatorInsets: { top: 0 }
    })

    fireEvent(screen.getByTestId('page-chrome'), 'layout', {
      nativeEvent: { layout: { height: 88, width: 402, x: 0, y: 0 } }
    })

    expect(JSON.parse(screen.getByTestId('scroll-probe').props.children)).toEqual({
      contentInset: { top: 88 },
      contentOffset: { x: 0, y: -88 },
      scrollIndicatorInsets: { top: 88 }
    })
  })

  it('an explicit height overrides the measured one', () => {
    Platform.OS = 'android'

    expect(pageScrollProps(40).contentContainerStyle).toEqual({ paddingTop: 40 })
  })
})

/**
 * The other half of HERM-106: `InsetGroup` now uppercases every header at
 * render (see `InsetGroup.tsx`), so a header STORED in capitals would render
 * SHOUTING SHOUTING — doubly uppercase, and a string that still carries its own
 * presentation casing the architecture decision says strings must not carry
 * again. Walked across all three locales, because a translation copied from
 * the old English constant would carry the same mistake forward.
 */
describe('i18n — no InsetGroup header string is stored uppercase', () => {
  // Every source key an InsetGroup header on screen currently reads, as a
  // dotted path into the `app` tree (`strings.ts`).
  const HEADER_PATHS = [
    'onboarding.signIn.chooseProvider',
    'onboarding.signIn.webview.fallbackLabel',
    'onboarding.done.gateway',
    'signedOut.stopped.gateway',
    'settings.gateway',
    'settings.webUpdate.header',
    'settings.notifications.header',
    'settings.notifications.types',
    'settings.gateways.header',
    'settings.account',
    'settings.developer',
    'settings.chat',
    'settings.appearance',
    'settings.about'
  ]

  function at(tree: unknown, path: string): unknown {
    return path.split('.').reduce<unknown>((node, step) => {
      if (node && typeof node === 'object' && step in node) {
        return (node as Record<string, unknown>)[step]
      }

      return undefined
    }, tree)
  }

  /** All letters, no lower case — the shape a `.toLocaleUpperCase()` header would double up on. */
  function isShouting(value: string): boolean {
    return value.length > 0 && value === value.toLocaleUpperCase() && value !== value.toLocaleLowerCase()
  }

  it('English source strings are sentence case', () => {
    for (const path of HEADER_PATHS) {
      const value = at(strings, path)

      expect(typeof value).toBe('string')
      expect(isShouting(value as string)).toBe(false)
    }
  })

  it.each(['nl', 'de'] as const)('%s translations are sentence case where translated at all', locale => {
    const tree = catalogueFor(locale, 'app')

    for (const path of HEADER_PATHS) {
      const value = at(tree, path)

      // Absent is fine — the coverage allow-list excuses a handful of these
      // (`i18n/coverage.ts`), and an absent key falls back to the English one
      // asserted above.
      if (typeof value !== 'string') {
        continue
      }

      expect(isShouting(value)).toBe(false)
    }
  })

  /**
   * HERM-125: `chat-ui/strings.ts` is its own tree (`chat`, not `app`), and
   * `export.header` is the one source string this file's `HEADER_PATHS` never
   * walked — which is exactly how it stayed stored as `'EXPORT'` through
   * HERM-106. It answers to three different roles (the sheet's group heading,
   * the popover's row label, the page's title), and only the first of those
   * runs through `InsetGroup`'s uppercase-at-render; the other two showed the
   * stored casing verbatim.
   */
  it('the chat tree’s export heading is sentence case in every locale', () => {
    expect(isShouting(chatStrings.export.header)).toBe(false)

    for (const locale of ['nl', 'de'] as const) {
      const value = catalogueFor(locale, 'chat').export as { header?: unknown } | undefined
      const header = value?.header

      expect(typeof header).toBe('string')
      expect(isShouting(header as string)).toBe(false)
    }
  })
})
