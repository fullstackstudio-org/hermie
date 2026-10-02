/**
 * Who gets ⌘K, and what ⌘W is allowed to be.
 *
 * The shortcuts arrive the way Escape does — one global event from a handler below
 * the responder chain, with no notion of what is on screen — so the same question
 * has to be answered again: which of several registered screens takes it. The
 * answer is deliberately the same one, a stack per action, and this file is where
 * the two are held to it.
 *
 * ⌘W is the interesting case. It is defined as "one level, like Esc", so it is NOT
 * registrable: it goes to the Escape stack. A second stack that also claimed to
 * mean "close one level" would be a second stack to keep in agreement with the
 * first, and they would drift the first time a sheet registered on one and not the
 * other.
 */
import { act, render } from '@testing-library/react-native'
import { Text } from 'react-native'

import type { ShortcutAction, ShortcutEvent } from '../src/platform/desktop-shortcuts'
import { BottomSheet } from '../src/ui/BottomSheet'
import { useEscapeKey } from '../src/ui/useEscapeKey'
import {
  resetShortcutScopes,
  shortcutIsDeliverable,
  useNumberedShortcuts,
  useShortcut,
  useShortcutScope,
  type RegistrableShortcut
} from '../src/ui/useShortcut'
import { withProviders } from './support/render'

// `mock`-prefixed, which is the only way a `jest.mock` factory may reach out of scope.
const mockListeners = new Set<(event: ShortcutEvent) => void>()
let mockSubscriptions = 0

jest.mock('../src/platform/desktop-shortcuts', () => ({
  subscribeToShortcuts: (handler: (event: ShortcutEvent) => void) => {
    mockSubscriptions += 1
    mockListeners.add(handler)

    return () => {
      mockSubscriptions -= 1
      mockListeners.delete(handler)
    }
  },
  setMenuBar: jest.fn(),
  isMenuBarInstalled: jest.fn(() => false)
}))

jest.mock('../src/platform/keyboard-modifiers', () => ({
  isShiftDown: jest.fn(() => false),
  hasHardwareKeyboard: jest.fn(() => false),
  subscribeToEscape: () => () => {}
}))

function press(action: ShortcutAction, typing = false) {
  act(() => {
    for (const listener of [...mockListeners]) {
      listener({ action, typing })
    }
  })
}

/** The same keystroke, arriving from the menu bar instead of from the HID handler. */
const pressFromMenuBar = (action: ShortcutAction) => press(action, false)

beforeEach(() => {
  mockListeners.clear()
  mockSubscriptions = 0
  resetShortcutScopes()
})

function Taker({
  action,
  enabled = true,
  onFire
}: {
  action: RegistrableShortcut
  enabled?: boolean
  onFire: () => void
}) {
  useShortcut(action, onFire, enabled)

  return <Text>{action}</Text>
}

describe('useShortcut', () => {
  it('holds one native subscription however many screens register', () => {
    const view = render(
      <>
        <Taker action="search" onFire={jest.fn()} />
        <Taker action="settings" onFire={jest.fn()} />
        <Taker action="nextChat" onFire={jest.fn()} />
      </>
    )

    expect(mockSubscriptions).toBe(1)

    view.unmount()
    expect(mockSubscriptions).toBe(0)
  })

  it('delivers to whoever registered that action LAST', () => {
    const first = jest.fn()
    const second = jest.fn()

    render(
      <>
        <Taker action="search" onFire={first} />
        <Taker action="search" onFire={second} />
      </>
    )

    press('search')

    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('hands the action back when the thing that took it goes away', () => {
    const list = jest.fn()
    const sheet = jest.fn()

    const view = render(
      <>
        <Taker action="search" onFire={list} />
        <Taker action="search" onFire={sheet} />
      </>
    )

    view.rerender(<Taker action="search" onFire={list} />)
    press('search')

    expect(list).toHaveBeenCalledTimes(1)
    expect(sheet).not.toHaveBeenCalled()
  })

  it('keeps the actions apart: one screen’s ⌘K is not another screen’s ⌘,', () => {
    const search = jest.fn()
    const settings = jest.fn()

    render(
      <>
        <Taker action="search" onFire={search} />
        <Taker action="settings" onFire={settings} />
      </>
    )

    press('search')

    expect(search).toHaveBeenCalledTimes(1)
    expect(settings).not.toHaveBeenCalled()
  })

  it('does not fire for a screen that is registered but disabled', () => {
    const hidden = jest.fn()

    render(<Taker action="search" enabled={false} onFire={hidden} />)
    press('search')

    expect(hidden).not.toHaveBeenCalled()
  })
})

describe('⌘1…9', () => {
  it('counts from one on the keyboard and from zero in the list', () => {
    const open = jest.fn()

    function Numbered() {
      useNumberedShortcuts(open)

      return <Text>numbered</Text>
    }

    render(<Numbered />)

    press('chat1')
    press('chat9')

    expect(open.mock.calls).toEqual([[0], [8]])
  })
})

describe('⌘W', () => {
  it('closes one level through the Escape stack rather than a stack of its own', () => {
    const closeSheet = jest.fn()
    const closePanel = jest.fn()

    function EscapeTaker({ onEscape }: { onEscape: () => void }) {
      useEscapeKey(onEscape)

      return <Text>taker</Text>
    }

    render(
      <>
        {/* Something has to hold a shortcut subscription open for the event to arrive. */}
        <Taker action="search" onFire={jest.fn()} />
        <EscapeTaker onEscape={closePanel} />
        <EscapeTaker onEscape={closeSheet} />
      </>
    )

    press('close')

    // The thing that opened last, exactly as Escape would.
    expect(closeSheet).toHaveBeenCalledTimes(1)
    expect(closePanel).not.toHaveBeenCalled()
  })

  it('does nothing at all when there is no level to close', () => {
    render(<Taker action="search" onFire={jest.fn()} />)

    // A ⌘W on a bare chat list is a no-op rather than a crash or a closed window:
    // the standard Close item is removed from the Mac's menu bar, so this really is
    // where the keystroke ends.
    expect(() => press('close')).not.toThrow()
  })
})

/**
 * The two gates in front of the stacks.
 *
 * `shortcutIsDeliverable` is pure and is asked directly, because the three things
 * it decides between — a bare list key, an app-wide chord, and a chord that
 * switches surface — are exactly what cannot be produced from a test renderer
 * with no keyboard in it.
 */
describe('shortcutIsDeliverable', () => {
  const idle = { modalDepth: 0, typing: false }

  it('delivers everything on an idle chat list', () => {
    for (const action of ['search', 'settings', 'close', 'nextChat', 'chat1', 'suggestionUp'] as ShortcutAction[]) {
      expect(shortcutIsDeliverable(action, idle)).toBe(true)
    }
  })

  it('drops an app-wide shortcut while a text input has the caret', () => {
    for (const action of ['search', 'settings', 'toggleSidebar', 'nextChat', 'chat1'] as ShortcutAction[]) {
      expect(shortcutIsDeliverable(action, { ...idle, typing: true })).toBe(false)
    }
  })

  it('still delivers the composer’s own list keys while typing, because that is what they are for', () => {
    for (const action of ['suggestionUp', 'suggestionDown', 'suggestionAccept'] as ShortcutAction[]) {
      expect(shortcutIsDeliverable(action, { ...idle, typing: true })).toBe(true)
    }
  })

  it('still delivers ⌘W while typing: leaving is not switching', () => {
    expect(shortcutIsDeliverable('close', { ...idle, typing: true })).toBe(true)
  })

  it('drops a surface switch while something modal is open', () => {
    for (const action of ['search', 'toggleSidebar', 'nextChat', 'previousChat', 'chat5'] as ShortcutAction[]) {
      expect(shortcutIsDeliverable(action, { ...idle, modalDepth: 1 })).toBe(false)
    }
  })

  /**
   * ⌘N is not a move, and is gated like one anyway.
   *
   * It retires the session and empties the transcript of the chat UNDERNEATH
   * whatever is open, so a reader with a sheet up who presses it would come back
   * to a conversation that is not the one they left. The typing gate takes it
   * too: on a Mac and an iPad it comes back through the menu bar's key
   * equivalent, where the focused field has already declined the keystroke.
   */
  it('gates ⌘N like a surface switch, although it moves nobody', () => {
    expect(shortcutIsDeliverable('newConversation', { typing: false, modalDepth: 0 })).toBe(true)
    expect(shortcutIsDeliverable('newConversation', { typing: false, modalDepth: 1 })).toBe(false)
    expect(shortcutIsDeliverable('newConversation', { typing: true, modalDepth: 0 })).toBe(false)
  })

  it('leaves ⌘, and ⌘W alone under a modal: neither goes to the surface underneath', () => {
    expect(shortcutIsDeliverable('settings', { ...idle, modalDepth: 1 })).toBe(true)
    expect(shortcutIsDeliverable('close', { ...idle, modalDepth: 2 })).toBe(true)
  })
})

describe('the typing gate, through the dispatcher', () => {
  it('is the owner’s report: the chat list does not take a keystroke aimed at a field', () => {
    const focusSearch = jest.fn()

    render(<Taker action="search" onFire={focusSearch} />)
    press('search', true)

    expect(focusSearch).not.toHaveBeenCalled()
  })

  it('lets the same shortcut through from the menu bar, which the responder chain already arbitrated', () => {
    const focusSearch = jest.fn()

    render(<Taker action="search" onFire={focusSearch} />)
    pressFromMenuBar('search')

    expect(focusSearch).toHaveBeenCalledTimes(1)
  })
})

describe('the modal-scope gate', () => {
  function Scope({ open = true }: { open?: boolean }) {
    useShortcutScope(open)

    return <Text>scope</Text>
  }

  it('takes ⌘K away from the list underneath an open panel', () => {
    const focusSearch = jest.fn()

    render(
      <>
        <Taker action="search" onFire={focusSearch} />
        <Scope />
      </>
    )

    press('search')

    expect(focusSearch).not.toHaveBeenCalled()
  })

  it('gives it back when the panel closes', () => {
    const focusSearch = jest.fn()
    const view = render(
      <>
        <Taker action="search" onFire={focusSearch} />
        <Scope />
      </>
    )

    view.rerender(<Taker action="search" onFire={focusSearch} />)
    press('search')

    expect(focusSearch).toHaveBeenCalledTimes(1)
  })

  it('counts, so a sheet over a panel does not reopen the gate when the panel goes', () => {
    const focusSearch = jest.fn()
    const view = render(
      <>
        <Taker action="search" onFire={focusSearch} />
        <Scope />
        <Scope />
      </>
    )

    view.rerender(
      <>
        <Taker action="search" onFire={focusSearch} />
        <Scope />
      </>
    )
    press('search')

    expect(focusSearch).not.toHaveBeenCalled()
  })

  it('is opened by a real bottom sheet, not only by the hook', () => {
    const focusSearch = jest.fn()

    render(
      withProviders(
        <>
          <Taker action="search" onFire={focusSearch} />
          <BottomSheet onRequestClose={jest.fn()} visible>
            <Text>a sheet</Text>
          </BottomSheet>
        </>
      )
    )

    press('search')

    expect(focusSearch).not.toHaveBeenCalled()
  })
})
