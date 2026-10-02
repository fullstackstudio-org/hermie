/**
 * The composer: send, stop, the slash popover, and the attachment tray.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'
import { useCallback, useState } from 'react'
import { AccessibilityInfo, Platform, ScrollView, StyleSheet } from 'react-native'

import { Composer } from '../../src/chat-ui'
import { ATTACH_LIST_MIN_WIDTH } from '../../src/chat-ui/AttachMenu'
import {
  ATTACH_POPOVER_MIN_WIDTH,
  COMPOSER_FIELD_INSET,
  COMPOSER_FIELD_RADIUS,
  composerFieldPadding,
  COMPOSER_IOS_TOP_INSET,
  COMPOSER_LINE_HEIGHT,
  COMPOSER_ROUND_SIZE,
  COMPOSER_TEXT_LINE_HEIGHT,
  PASTE_REVERT_POLL_MS,
  PASTE_REVERT_WINDOW_MS,
  SLASH_POPOVER_MAX_HEIGHT,
  SLASH_SLOW_MS
} from '../../src/chat-ui/Composer'
import { SEND_ECHO_WINDOW_MS } from '../../src/chat-ui/send-echo'
import type { ComposerDictation } from '../../src/chat-ui/types'
import { renderScreen, withProviders } from '../support/render'

const mockEscapeListeners = new Set<() => void>()
const mockShortcutListeners = new Set<(action: string) => void>()
let mockShiftDown = false
let mockHardwareKeyboard = false
let mockHasNativePasteboard = false
const mockReadPasteboardAttachment = jest.fn()

// A Mac is the iOS build on Apple Silicon, and this file needs to render as
// both. `COMPOSER_ROUND_SIZE` is read at import time and is therefore fixed at
// the value below for the whole file; only what is read per render follows the
// flag.
jest.mock('../../src/platform/runs-on-mac', () => ({ RUNS_ON_MAC: false }))

const runsOnMac = jest.requireMock('../../src/platform/runs-on-mac') as { RUNS_ON_MAC: boolean }

// ↑, ↓ and Tab reach the composer from the keyboard seam, not from the field: a
// `TextInput` only reports keys that insert text.
jest.mock('../../src/platform/desktop-shortcuts', () => ({
  subscribeToShortcuts: (handler: (event: { action: string; typing: boolean }) => void) => {
    mockShortcutListeners.add(handler)

    return () => mockShortcutListeners.delete(handler)
  },
  setMenuBar: jest.fn(),
  isMenuBarInstalled: jest.fn(() => false)
}))

jest.mock('../../src/platform/keyboard-modifiers', () => ({
  isShiftDown: () => mockShiftDown,
  hasHardwareKeyboard: () => mockHardwareKeyboard,
  subscribeToEscape: (handler: () => void) => {
    mockEscapeListeners.add(handler)

    return () => mockEscapeListeners.delete(handler)
  }
}))

// The pasteboard read ⌘V triggers. `get` so a test can flip `mockHasNativePasteboard`
// after the module has already been imported once — see the same trap noted in
// `quick-look.test.ts`.
jest.mock('../../src/platform/native-paste', () => ({
  get HAS_NATIVE_PASTEBOARD() {
    return mockHasNativePasteboard
  },
  readPasteboardAttachment: () => mockReadPasteboardAttachment()
}))

beforeEach(() => {
  mockEscapeListeners.clear()
  mockShortcutListeners.clear()
  mockShiftDown = false
  mockHasNativePasteboard = false
  mockReadPasteboardAttachment.mockReset().mockResolvedValue([])
})

/** One press of ↑, ↓ or Tab, as the seam delivers it. */
function pressKey(action: 'suggestionUp' | 'suggestionDown' | 'suggestionAccept') {
  act(() => {
    for (const listener of [...mockShortcutListeners]) {
      // Typing: false — these arrive from the menu bar's own key equivalents, or
      // from a keyboard with nothing focused. The typing gate has its own tests.
      listener({ action, typing: false })
    }
  })
}

/** ⌘V, as the same seam delivers it — genuinely `typing: true`, unlike the list keys above. */
function pressPaste() {
  act(() => {
    for (const listener of [...mockShortcutListeners]) {
      listener({ action: 'paste', typing: true })
    }
  })
}

/**
 * A pasteboard read that answers only when a test says so.
 *
 * The whole bug is an ordering between this answer and the field's own render,
 * so every case below has to be able to put those two in either order.
 */
function deferredPaste() {
  let resolve: (files: unknown[]) => void = () => undefined

  mockReadPasteboardAttachment.mockImplementation(
    () =>
      new Promise(r => {
        resolve = r
      })
  )

  return (files: unknown[]) => resolve(files)
}

/** Let a resolved pasteboard promise's continuation run, without letting a timer run. */
async function flushPasteboard() {
  await act(async () => undefined)
}

/** The resolved style of a rendered node, function styles included. */
function styleOf(testID: string): Record<string, number> {
  const raw = screen.getByTestId(testID).props.style as unknown

  return StyleSheet.flatten(typeof raw === 'function' ? (raw as () => unknown)({ pressed: false }) : raw) as Record<
    string,
    number
  >
}

const SUGGESTIONS = [
  { description: 'Compact the conversation', name: 'compact' },
  { description: 'Show the current model', name: 'model' }
]

function renderComposer(props: Record<string, unknown> = {}) {
  const handlers = {
    onAttach: jest.fn(),
    onAttachFile: jest.fn(),
    onChangeText: jest.fn(),
    onPasteFiles: jest.fn(),
    onQuerySlash: jest.fn(),
    onRemoveAttachment: jest.fn(),
    onSend: jest.fn(),
    onStop: jest.fn()
  }

  renderScreen(<Composer value="" {...handlers} {...props} />)

  return handlers
}

/**
 * The same render, with a way to hand the composer a NEW set of props.
 *
 * Several of the cases below are about a prop changing under a mounted
 * composer — a failure clearing, a slow fetch being overtaken by its own answer
 * — and those are the ones a fresh render cannot express: the whole question is
 * what the component does with the transition.
 */
function renderComposerHandle(props: Record<string, unknown> = {}) {
  const handlers = {
    onAttach: jest.fn(),
    onAttachFile: jest.fn(),
    onChangeText: jest.fn(),
    onPasteFiles: jest.fn(),
    onQuerySlash: jest.fn(),
    onRemoveAttachment: jest.fn(),
    onSend: jest.fn(),
    onStop: jest.fn()
  }
  const rendered = renderScreen(<Composer value="" {...handlers} {...props} />)

  return {
    handlers,
    // Through the providers again: `renderScreen` wraps the tree, and a bare
    // rerender would replace the theme and safe-area context with nothing.
    rerender: (next: Record<string, unknown>) =>
      rendered.rerender(withProviders(<Composer value="" {...handlers} {...next} />))
  }
}

/** Escape, as the keyboard seam delivers it. */
function pressEscape() {
  act(() => {
    for (const listener of [...mockEscapeListeners]) {
      listener()
    }
  })
}

describe('Composer', () => {
  it('reports typing to the owner of the draft', () => {
    const handlers = renderComposer()

    fireEvent.changeText(screen.getByTestId('composer-input'), 'Hello')
    expect(handlers.onChangeText).toHaveBeenCalledWith('Hello')
  })

  it('cannot send an empty draft', () => {
    const handlers = renderComposer()

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('sends the draft it was given', () => {
    const handlers = renderComposer({ value: 'Check the release notes' })

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).toHaveBeenCalledWith('Check the release notes')
  })

  it('sends what is typed even while a turn runs, rather than stopping it', () => {
    // Sending is always possible: the message is parked behind the running turn
    // and appears at the end of the transcript as a queued bubble. The button
    // under the words you just typed must not throw the reply away.
    const handlers = renderComposer({ running: true, value: 'and one more thing' })

    expect(screen.queryByTestId('composer-stop')).toBeNull()

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).toHaveBeenCalledWith('and one more thing')
    expect(handlers.onStop).not.toHaveBeenCalled()
  })

  it('is a stop button while a turn runs and there is nothing to send', () => {
    const handlers = renderComposer({ running: true })

    expect(screen.queryByTestId('composer-send')).toBeNull()

    fireEvent.press(screen.getByTestId('composer-stop'))
    expect(handlers.onStop).toHaveBeenCalled()
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('can stop with an empty draft', () => {
    const handlers = renderComposer({ running: true })

    fireEvent.press(screen.getByTestId('composer-stop'))
    expect(handlers.onStop).toHaveBeenCalled()
  })

  it('asks for slash candidates on the whole typed line and shows the popover', () => {
    // The LINE, not the name: `complete.slash` completes the argument as well,
    // and it can only do that if it is given what was typed.
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/co' })

    expect(handlers.onQuerySlash).toHaveBeenCalledWith('/co')
    expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()
    expect(screen.getByTestId('slash-option-compact')).toBeTruthy()
  })

  it('keeps asking once there is an argument, which is what completes it', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/model exa' })

    expect(handlers.onQuerySlash).toHaveBeenCalledWith('/model exa')
    expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()
  })

  it('closes the list at a newline, because a multi-line draft is a message', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/note\nsecond line' })

    expect(handlers.onQuerySlash).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
  })

  it('writes what the caller says the row inserts, argument and all', () => {
    const handlers = renderComposer({
      suggestions: [{ description: 'A model', insert: '/model example-large', name: 'example-large' }],
      value: '/model exa'
    })

    fireEvent.press(screen.getByTestId('slash-option-example-large'))
    expect(handlers.onChangeText).toHaveBeenCalledWith('/model example-large')
  })

  it('writes the picked command back into the draft', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: '/' })

    fireEvent.press(screen.getByTestId('slash-option-model'))
    expect(handlers.onChangeText).toHaveBeenCalledWith('/model ')
  })

  it('leaves a mid-sentence slash alone', () => {
    const handlers = renderComposer({ suggestions: SUGGESTIONS, value: 'see src/app' })

    expect(handlers.onQuerySlash).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
  })

  /**
   * A refused completion call, and a slow one, are two facts an empty popover
   * used to say nothing about.
   *
   * The popover opened on `suggestions.length > 0` alone, so against a gateway
   * that refused both calls the composer drew NOTHING — the owner typed `/` on
   * his phone and saw an empty field, while the same build showed the list on
   * the web and on the simulator.
   */
  describe('when the gateway will not answer', () => {
    const FAILURE = { method: 'commands.catalog', reason: '5030 worker exited' }

    it('opens the popover on a failure with no suggestions at all', () => {
      renderComposer({ slashFailure: FAILURE, value: '/' })

      expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()
      expect(screen.getByTestId('slash-failure')).toBeTruthy()
      expect(screen.getByText('Commands unavailable — commands.catalog')).toBeTruthy()
      expect(screen.getByText('5030 worker exited')).toBeTruthy()
    })

    it('draws the failure row as text rather than as something to accept', () => {
      const handlers = renderComposer({ slashFailure: FAILURE, value: '/' })

      // Not a `Pressable`: there is nothing to pick, and a row that took a tap
      // would be offering one.
      const row = screen.getByTestId('slash-failure')

      expect(row.props.accessibilityRole).toBeUndefined()
      expect(row.props.onClick).toBeUndefined()

      // And Return still sends the line rather than being swallowed by a list
      // with nothing in it.
      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      expect(handlers.onSend).toHaveBeenCalledWith('/')
    })

    it('says so beside the list when the catalogue alone refused', () => {
      // `complete.slash` answers from the session and the catalogue is what
      // routing reads, so this is the state where the list looks fine and
      // Return sends the pick as prose.
      renderComposer({ slashFailure: FAILURE, suggestions: SUGGESTIONS, value: '/co' })

      expect(screen.getByTestId('slash-failure')).toBeTruthy()
      expect(screen.getByTestId('slash-option-compact')).toBeTruthy()
    })

    it('clears the row on the next answer that works', () => {
      const { rerender } = renderComposerHandle({ slashFailure: FAILURE, value: '/co' })

      expect(screen.getByTestId('slash-failure')).toBeTruthy()

      rerender({ slashFailure: null, suggestions: SUGGESTIONS, value: '/co' })

      expect(screen.queryByTestId('slash-failure')).toBeNull()
      expect(screen.getByTestId('slash-option-compact')).toBeTruthy()
    })

    it('is dismissed by Escape like any other popover', () => {
      renderComposer({ slashFailure: FAILURE, value: '/' })

      expect(screen.getByTestId('slash-failure')).toBeTruthy()
      pressEscape()
      expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
    })
  })

  /**
   * A slow first fetch is a third fact, and the one that tells a reader to wait
   * rather than to conclude the feature is broken.
   */
  describe('while the first catalogue fetch is slow', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('says nothing at all before the threshold', () => {
      renderComposer({ slashLoading: true, value: '/' })

      act(() => void jest.advanceTimersByTime(SLASH_SLOW_MS - 1))

      expect(screen.queryByTestId('slash-loading')).toBeNull()
      expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
    })

    it('opens a Loading row once the fetch has taken long enough', () => {
      renderComposer({ slashLoading: true, value: '/' })

      act(() => void jest.advanceTimersByTime(SLASH_SLOW_MS))

      expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()
      expect(screen.getByTestId('slash-loading')).toBeTruthy()
    })

    it('gives way to the failure, which is the more specific answer', () => {
      const { rerender } = renderComposerHandle({ slashLoading: true, value: '/' })

      act(() => void jest.advanceTimersByTime(SLASH_SLOW_MS))
      expect(screen.getByTestId('slash-loading')).toBeTruthy()

      rerender({ slashFailure: { method: 'complete.slash', reason: 'no answer' }, slashLoading: false, value: '/' })

      expect(screen.queryByTestId('slash-loading')).toBeNull()
      expect(screen.getByTestId('slash-failure')).toBeTruthy()
    })

    it('never draws the row for a gateway that answers promptly', () => {
      const { rerender } = renderComposerHandle({ slashLoading: true, value: '/' })

      act(() => void jest.advanceTimersByTime(SLASH_SLOW_MS - 100))
      rerender({ slashLoading: false, suggestions: SUGGESTIONS, value: '/' })
      act(() => void jest.advanceTimersByTime(SLASH_SLOW_MS))

      expect(screen.queryByTestId('slash-loading')).toBeNull()
      expect(screen.getByTestId('slash-option-compact')).toBeTruthy()
    })
  })

  /**
   * The highlight has to stay on screen, or the arrow keys are driving a list
   * the reader cannot see.
   *
   * ↑ and ↓ moved the selection and nothing else, and a real gateway answers a
   * bare `/` with thirty-four commands — so the fourth press walked the
   * highlight out of the bottom of the popover and every press after that did
   * nothing visible at all.
   */
  describe('the slash list and the highlight it has to keep on screen', () => {
    const SIX = Array.from({ length: 6 }, (_, index) => ({
      description: `Command number ${index + 1}`,
      name: `cmd${index + 1}`
    }))

    /** Six 50pt rows in a 220pt window: the last two are below the fold. */
    const ROW_HEIGHT = 50

    function layOutList() {
      fireEvent(screen.getByTestId('composer-slash-list'), 'layout', {
        nativeEvent: { layout: { height: SLASH_POPOVER_MAX_HEIGHT, width: 320, x: 0, y: 0 } }
      })

      SIX.forEach((suggestion, index) => {
        fireEvent(screen.getByTestId(`slash-option-${suggestion.name}`), 'layout', {
          nativeEvent: { layout: { height: ROW_HEIGHT, width: 320, x: 0, y: index * ROW_HEIGHT } }
        })
      })
    }

    it('scrolls the last row into view from the bottom, and the first back to zero', () => {
      const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {})

      try {
        renderComposer({ suggestions: SIX, value: '/' })
        layOutList()

        // Down to row 6. Its bottom is at 300 in a 220pt window, so the list has
        // to sit at 80 for the whole row to be visible.
        for (let step = 0; step < 5; step += 1) {
          pressKey('suggestionDown')
        }

        expect(scrollTo).toHaveBeenLastCalledWith({ animated: true, y: 6 * ROW_HEIGHT - SLASH_POPOVER_MAX_HEIGHT })

        // And back to the top, which is the other edge of the same rule.
        for (let step = 0; step < 5; step += 1) {
          pressKey('suggestionUp')
        }

        expect(scrollTo).toHaveBeenLastCalledWith({ animated: true, y: 0 })
      } finally {
        scrollTo.mockRestore()
      }
    })

    it('leaves a row that is already fully visible exactly where it is', () => {
      const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {})

      try {
        renderComposer({ suggestions: SIX, value: '/' })
        layOutList()

        // Rows 1 to 4 all end at or before 200, inside the 220pt window, so
        // walking down through them scrolls nothing.
        for (let step = 0; step < 3; step += 1) {
          pressKey('suggestionDown')
        }

        expect(scrollTo).not.toHaveBeenCalled()
      } finally {
        scrollTo.mockRestore()
      }
    })

    it('asks for the destination rather than the journey under Reduce Motion', async () => {
      /*
        Swapped and put back by hand rather than with `spyOn`/`mockRestore`.

        The preset already supplies this getter, and restoring a spy on it
        reinstates the UNMOCKED module function, which answers `undefined` in
        this environment — so `theme.tsx`'s `?.().then` throws for every test
        that renders afterwards. Keeping the reference is the only restore that
        puts back what was actually there.
      */
      const original = AccessibilityInfo.isReduceMotionEnabled
      // The theme reads the preference asynchronously, so the render has to be
      // allowed to settle before the first key: a scroll requested on the frame
      // before the answer arrives would honestly still be animated.
      AccessibilityInfo.isReduceMotionEnabled = () => Promise.resolve(true)

      const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {})

      try {
        renderComposer({ suggestions: SIX, value: '/' })
        await act(async () => undefined)
        layOutList()

        for (let step = 0; step < 5; step += 1) {
          pressKey('suggestionDown')
        }

        expect(scrollTo).toHaveBeenLastCalledWith({ animated: false, y: 6 * ROW_HEIGHT - SLASH_POPOVER_MAX_HEIGHT })
      } finally {
        scrollTo.mockRestore()
        AccessibilityInfo.isReduceMotionEnabled = original
      }
    })

    it('measures again when the candidates change, rather than trusting old boxes', () => {
      // Index 3 of `/mo` and index 3 of `/model` are different rows at
      // different heights; a kept measurement scrolls to where a row used to be.
      const scrollTo = jest.spyOn(ScrollView.prototype, 'scrollTo').mockImplementation(() => {})

      try {
        const { rerender } = renderComposerHandle({ suggestions: SIX, value: '/' })

        layOutList()
        for (let step = 0; step < 5; step += 1) {
          pressKey('suggestionDown')
        }
        expect(scrollTo).toHaveBeenCalled()
        scrollTo.mockClear()

        // A narrower list, not yet laid out: nothing to aim at, so nothing moves.
        rerender({ suggestions: SIX.slice(0, 2), value: '/cmd' })
        pressKey('suggestionDown')

        expect(scrollTo).not.toHaveBeenCalled()
      } finally {
        scrollTo.mockRestore()
      }
    })
  })

  it('offers attachments and can remove one', () => {
    const handlers = renderComposer({
      attachments: [{ id: 'att-1', kind: 'image', name: 'diagram.png', uri: 'file:///tmp/diagram.png' }]
    })

    expect(screen.getByTestId('composer-attachments')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attachment-remove-att-1'))
    expect(handlers.onRemoveAttachment).toHaveBeenCalledWith('att-1')

    // The "+" opens the MENU now; the picker is the menu's first entry. Nothing
    // asynchronous happens between the tap and the menu, which is the point.
    fireEvent.press(screen.getByTestId('composer-attach'))
    expect(handlers.onAttach).not.toHaveBeenCalled()
    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attach-menu-photo'))
    expect(handlers.onAttach).toHaveBeenCalled()
  })

  it('offers Choose file as the menu\u2019s own entry, not a long press', () => {
    const handlers = renderComposer()

    fireEvent.press(screen.getByTestId('composer-attach'))
    fireEvent.press(screen.getByTestId('composer-attach-menu-file'))

    expect(handlers.onAttachFile).toHaveBeenCalled()
  })

  it('marks the chosen entry busy and refuses a second tap on it', () => {
    // The busy mark is the only feedback there is during the 1.5-2s the system
    // picker takes to come up on a Mac, and a second tap during it would present
    // two pickers.
    const handlers = renderComposer({ attachBusy: 'file' })

    fireEvent.press(screen.getByTestId('composer-attach'))

    expect(screen.getByTestId('composer-attach-menu-file-busy')).toBeTruthy()

    fireEvent.press(screen.getByTestId('composer-attach-menu-file'))
    expect(handlers.onAttachFile).not.toHaveBeenCalled()

    // The other entry is still usable: only the one that is waiting is blocked.
    expect(screen.queryByTestId('composer-attach-menu-photo-busy')).toBeNull()
  })

  it('shows a file as a chip with its size, and an image as a thumbnail', () => {
    renderComposer({
      attachments: [
        { id: 'att-1', kind: 'image', name: 'diagram.png', uri: 'file:///tmp/diagram.png' },
        { id: 'att-2', kind: 'file', name: 'quarterly-report-final-v4.xlsx', size: 48210, status: 'uploaded' }
      ]
    })

    expect(screen.getByTestId('composer-attachment-att-2')).toBeTruthy()
    expect(screen.getByText('47 KB')).toBeTruthy()
  })

  it('says why a rejected file will not be sent', () => {
    renderComposer({
      attachments: [
        { error: 'Too large · 100 MB max', id: 'att-3', kind: 'file', name: 'capture.mov', status: 'error' }
      ]
    })

    expect(screen.getByText('Too large · 100 MB max')).toBeTruthy()
  })

  it('can send an attachment with no text', () => {
    const handlers = renderComposer({ attachments: [{ id: 'att-1', kind: 'image', name: 'diagram.png' }] })

    fireEvent.press(screen.getByTestId('composer-send'))
    expect(handlers.onSend).toHaveBeenCalledWith('')
  })

  it('shows the prompt the backend parked behind the running turn', () => {
    renderComposer({ queuedText: 'Include source links' })

    expect(screen.getByTestId('composer-queued')).toBeTruthy()
    expect(screen.getByText(/Include source links/)).toBeTruthy()
  })

  it('announces the disabled "+" as disabled rather than only dimming it', () => {
    renderScreen(<Composer onChangeText={jest.fn()} onSend={jest.fn()} value="" />)

    expect(screen.getByTestId('composer-attach').props.accessibilityState).toMatchObject({ disabled: true })
  })

  it('offers only the pickers the caller actually gave it', () => {
    renderScreen(<Composer onAttachFile={jest.fn()} onChangeText={jest.fn()} onSend={jest.fn()} value="" />)

    fireEvent.press(screen.getByTestId('composer-attach'))

    expect(screen.getByTestId('composer-attach-menu-file')).toBeTruthy()
    expect(screen.queryByTestId('composer-attach-menu-photo')).toBeNull()
  })
})

/**
 * The geometry of the composer row.
 *
 * Sebas saw the send button poking through the top of the field's border and
 * sitting off-centre, because all three controls sized themselves independently
 * inside one 28pt corner radius. The first fix was arithmetic: make the three
 * agree on one line box and assert the inequality that made overflow impossible.
 *
 * The mockup's answer is better than the arithmetic. The buttons are **not inside
 * the field at all** — a separate round "+", a pill field, a separate round send —
 * so a button cannot overflow a field it is not in, at any text size, in either
 * theme. These assertions therefore pin the new structure AND keep the old
 * concern: the field stays a true pill at one line and keeps the same caps as it
 * grows, and the two round controls stay round, equal and whole-numbered (the Mac
 * renders this build scaled, so a fractional control size is a visible sliver).
 */
describe('the composer row', () => {
  it('keeps the buttons outside the field, so neither can overflow it', () => {
    renderComposer({ value: 'ready' })

    const field = styleOf('composer-field')

    // Half the single-line height: a true pill at one line, and the same caps
    // once it grows. A larger radius turns a tall field's ends into full
    // semicircles; 28pt on a 40pt box was the original bug.
    //
    // Per corner rather than one `borderRadius`: a glass surface spells all four
    // out so that a bottom sheet can square its lower pair, and a blanket radius
    // beside a per-corner one is two rules for one shape.
    expect(field.borderTopLeftRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(field.borderTopRightRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(field.borderBottomLeftRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(field.borderBottomRightRadius).toBe(COMPOSER_FIELD_RADIUS)
    expect(COMPOSER_FIELD_RADIUS).toBe((COMPOSER_LINE_HEIGHT + 2 * COMPOSER_FIELD_INSET) / 2)

    // The "+" and the send are siblings of the field, not children of it: the
    // field's own testID is not an ancestor of either.
    expect(screen.getByTestId('composer-attach')).toBeTruthy()
    expect(screen.getByTestId('composer-send')).toBeTruthy()
    expect(screen.queryByTestId('composer-field')?.findAllByProps({ testID: 'composer-send' })).toHaveLength(0)
  })

  it('draws both round controls at one whole-numbered size', () => {
    renderComposer({ value: 'ready' })

    // The pressable IS the circle now — `RoundIconButton` draws one box rather
    // than a target with a circle inside it, which is what made "the mark is
    // centred" one claim instead of one per copy.
    const circle = styleOf('composer-send')

    expect(COMPOSER_ROUND_SIZE).toBe(Math.round(COMPOSER_ROUND_SIZE))
    expect(styleOf('composer-attach').height).toBe(COMPOSER_ROUND_SIZE)
    expect(circle.height).toBe(COMPOSER_ROUND_SIZE)
    expect(circle.width).toBe(circle.height)
    expect(circle.borderRadius).toBe(COMPOSER_ROUND_SIZE / 2)
  })

  it('anchors the row to the bottom so a growing input pushes upward', () => {
    renderComposer({ value: 'one\ntwo\nthree\nfour' })

    // The input is the only thing allowed to grow; the round controls ride the
    // bottom line rather than stretching with it.
    expect(styleOf('composer-input').maxHeight).toBeGreaterThan(COMPOSER_LINE_HEIGHT)
    expect(styleOf('composer-send').height).toBe(COMPOSER_ROUND_SIZE)
  })

  /**
   * One line, vertically centred — and why the field has no `minHeight` any more.
   *
   * A `minHeight` made the box taller than its content, and an iOS multiline field
   * lays its text out from the TOP of a box like that: the placeholder sat high with
   * the slack below it, which is what the owner reported. The height of one line now
   * comes from the leading plus the padding, so there is no slack for the platform to
   * put anywhere.
   */
  it('centres one line in the pill from an explicit leading, not from a minimum height', () => {
    renderComposer({ value: '' })

    const style = styleOf('composer-input') as {
      lineHeight?: number
      minHeight?: number
      paddingBottom?: number
      paddingTop?: number
    }

    expect(style.lineHeight).toBe(COMPOSER_TEXT_LINE_HEIGHT)
    expect(style.minHeight).toBeUndefined()

    // Leading plus both paddings IS the single-line field height, so the pill is a
    // true pill at one line without anything having to be a minimum.
    const inset = Platform.OS === 'ios' ? COMPOSER_IOS_TOP_INSET : 0

    expect(COMPOSER_TEXT_LINE_HEIGHT + (style.paddingTop ?? 0) + inset + (style.paddingBottom ?? 0)).toBe(
      COMPOSER_LINE_HEIGHT
    )
  })

  it('leaves the two visible gaps equal, with the platform’s own inset taken off the top', () => {
    // The arithmetic, stated where it is decided. `paddingTop` is deliberately NOT
    // `paddingBottom` on iOS: the platform adds its own space above the first line,
    // and what has to be symmetric is what a reader sees.
    expect(composerFieldPadding(0)).toEqual({ paddingBottom: 5, paddingTop: 5 })
    expect(composerFieldPadding(2)).toEqual({ paddingBottom: 5, paddingTop: 3 })

    // …and never negative, however large a platform's inset turns out to be.
    expect(composerFieldPadding(99).paddingTop).toBe(0)
  })

  it('keeps the stop button on exactly the same geometry', () => {
    renderComposer({ running: true })

    const stop = styleOf('composer-stop')

    expect(stop.height).toBe(COMPOSER_ROUND_SIZE)
    expect(stop.width).toBe(COMPOSER_ROUND_SIZE)
    expect(stop.borderRadius).toBe(COMPOSER_ROUND_SIZE / 2)
  })
})

/**
 * The keyboard path, which is the only way to send on a Mac.
 *
 * Two mechanisms, and which one fires is decided by `submitBehavior`. Where a
 * bare Return sends, iOS suppresses the newline and calls `onSubmitEditing`
 * instead, and `onKeyPress` never sees the key at all — that is what makes a
 * double send structurally impossible rather than guarded against.
 *
 * The rule both enforce: Return SENDS, or does nothing. It used to fall through
 * to the same handler as the round button, so while a reply was streaming the
 * send key cancelled the turn — typing the next message and pressing Return
 * killed the answer being written. A prompt sent mid-turn is parked in the
 * queue; stopping is what the button does with an EMPTY field, and what Escape
 * does always.
 */
/**
 * The slash list under the keyboard.
 *
 * Arrow keys and Tab do not reach a `TextInput` at all — React Native builds its
 * `onKeyPress` payload from the text a field is about to insert — so all three
 * come down the same road as Escape and the desktop shortcuts, and only while
 * the list is open.
 */
describe('the slash list and the keyboard', () => {
  const OPTIONS = [
    { description: 'Compact the conversation', name: 'compact' },
    { description: 'Show the current model', name: 'model' }
  ]

  /** Which row the keyboard is on, as the list itself reports it. */
  const selected = (name: string) =>
    screen.getByTestId(`slash-option-${name}`).props.accessibilityState?.selected === true

  it('starts on the first row and walks down and back up', () => {
    renderComposer({ suggestions: OPTIONS, value: '/' })

    expect(selected('compact')).toBe(true)

    pressKey('suggestionDown')
    expect(selected('model')).toBe(true)
    expect(selected('compact')).toBe(false)

    // …and stops at the end rather than wrapping: a list that wraps under a held
    // arrow key never lets go of the reader.
    pressKey('suggestionDown')
    expect(selected('model')).toBe(true)

    pressKey('suggestionUp')
    expect(selected('compact')).toBe(true)
    pressKey('suggestionUp')
    expect(selected('compact')).toBe(true)
  })

  it('takes the highlighted row on Tab', () => {
    const handlers = renderComposer({ suggestions: OPTIONS, value: '/' })

    pressKey('suggestionDown')
    pressKey('suggestionAccept')

    expect(handlers.onChangeText).toHaveBeenCalledWith('/model ')
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('takes the highlighted row on Enter rather than sending the line', () => {
    mockHardwareKeyboard = true

    try {
      const handlers = renderComposer({ suggestions: OPTIONS, value: '/' })

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

      expect(handlers.onChangeText).toHaveBeenCalledWith('/compact ')
      expect(handlers.onSend).not.toHaveBeenCalled()
    } finally {
      mockHardwareKeyboard = false
    }
  })

  it('sends on Enter with no list open, which is every other line', () => {
    mockHardwareKeyboard = true

    try {
      const handlers = renderComposer({ suggestions: [], value: 'just a message' })

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

      expect(handlers.onSend).toHaveBeenCalledWith('just a message')
    } finally {
      mockHardwareKeyboard = false
    }
  })

  it('gives the keys back the moment the list is closed', () => {
    const handlers = renderComposer({ suggestions: OPTIONS, value: '/' })

    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()

    pressKey('suggestionAccept')
    expect(handlers.onChangeText).not.toHaveBeenCalled()
  })
})

describe('the Composer keyboard', () => {
  const submitEditing = () => fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

  const keyPress = (key: string, extra: Record<string, unknown> = {}) =>
    fireEvent(screen.getByTestId('composer-input'), 'keyPress', { nativeEvent: { key, ...extra } })

  it('asks the platform to submit on Return where a hardware keyboard is certain', () => {
    renderComposer({ hardwareKeyboard: true, value: 'Ship it' })

    expect(screen.getByTestId('composer-input').props.submitBehavior).toBe('submit')
  })

  it('leaves Return as the newline everywhere else', () => {
    renderComposer({ hardwareKeyboard: false, value: 'Ship it' })

    expect(screen.getByTestId('composer-input').props.submitBehavior).toBe('newline')
  })

  it('sends on the Return the platform turned into a submit', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'Ship it' })

    submitEditing()
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })

  it('does not stop a running turn on Return', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, running: true, value: 'the next message' })

    submitEditing()
    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(handlers.onSend).toHaveBeenCalledWith('the next message')
  })

  it('does nothing at all on Return with nothing to send', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, running: true, value: '' })

    submitEditing()
    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('leaves a bare Enter alone where it is the newline', () => {
    const handlers = renderComposer({ hardwareKeyboard: false, value: 'first line' })

    keyPress('Enter')
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('keeps Shift+Enter as the newline where the flag arrives', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'first line' })

    keyPress('Enter', { shiftKey: true })
    expect(handlers.onSend).not.toHaveBeenCalled()
  })

  it('sends on Cmd+Enter even where a bare Enter is a newline', () => {
    const handlers = renderComposer({ hardwareKeyboard: false, value: 'Ship it' })

    keyPress('Enter', { metaKey: true })
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })
})

/**
 * Shift+Return is a newline, and it has to be inserted by hand.
 *
 * `submitBehavior="submit"` tells iOS not to insert one, which is what makes a
 * bare Return the send key — and it applies to Shift+Return too, because a text
 * field's key event carries no modifier state on iOS and both arrive as the same
 * `"\n"`. So the composer asks the keyboard which chord it was and, for Shift,
 * writes the newline into the draft itself at the caret.
 */
describe('the Composer and Shift+Return', () => {
  const submitEditing = () => fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

  const moveCaret = (start: number, end: number = start) =>
    fireEvent(screen.getByTestId('composer-input'), 'selectionChange', {
      nativeEvent: { selection: { start, end } }
    })

  it('sends when Shift is up', () => {
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'Ship it' })

    submitEditing()

    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
    expect(handlers.onChangeText).not.toHaveBeenCalled()
  })

  it('inserts a newline at the end when Shift is down, and does not send', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'first line' })

    moveCaret('first line'.length)
    submitEditing()

    expect(handlers.onSend).not.toHaveBeenCalled()
    expect(handlers.onChangeText).toHaveBeenCalledWith('first line\n')
  })

  it('inserts at the caret, not at the end', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'one two' })

    moveCaret(3)
    submitEditing()

    expect(handlers.onChangeText).toHaveBeenCalledWith('one\n two')
  })

  it('replaces a selected range, the way any other character would', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'keep DROP keep' })

    moveCaret(5, 9)
    submitEditing()

    expect(handlers.onChangeText).toHaveBeenCalledWith('keep \n keep')
  })

  it('leaves the caret after the newline it just inserted', () => {
    mockShiftDown = true
    renderComposer({ hardwareKeyboard: true, value: 'one two' })

    moveCaret(3)
    submitEditing()

    expect(screen.getByTestId('composer-input').props.selection).toEqual({ start: 4, end: 4 })
  })

  it('survives a stale caret past the end of the draft', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: true, value: 'short' })

    moveCaret(99, 120)
    submitEditing()

    expect(handlers.onChangeText).toHaveBeenCalledWith('short\n')
  })

  it('ignores Shift where a bare Return is already the newline', () => {
    mockShiftDown = true
    const handlers = renderComposer({ hardwareKeyboard: false, value: 'Ship it' })

    submitEditing()

    // `submitBehavior` is 'newline' there, so the platform inserts it and this
    // handler is not the one that runs — but if it does, it must not double up.
    expect(handlers.onChangeText).not.toHaveBeenCalled()
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
  })

  /**
   * The owner's second report: on an iPad in a keyboard case Enter did nothing
   * useful, while the same build on a Mac sent. The decision had been hung on
   * `RUNS_ON_MAC`, which is a proxy for "is there a keyboard" and is false on
   * exactly that device. It now asks the HID state as well.
   */
  it('sends on a bare Return wherever a keyboard is actually attached', () => {
    mockHardwareKeyboard = true

    try {
      // No `hardwareKeyboard` prop at all: this is the DEFAULT, which is what
      // the chat screen relies on.
      const handlers = renderComposer({ value: 'Ship it' })

      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      expect(handlers.onSend).toHaveBeenCalledWith('Ship it')

      // And Shift+Return there is still the newline.
      mockShiftDown = true
      fireEvent(screen.getByTestId('composer-input'), 'submitEditing')
      expect(handlers.onChangeText).toHaveBeenCalledWith('Ship it\n')
    } finally {
      mockHardwareKeyboard = false
      mockShiftDown = false
    }
  })

  it('leaves a device with no keyboard on the software Return', () => {
    const handlers = renderComposer({ value: 'Ship it' })

    fireEvent(screen.getByTestId('composer-input'), 'submitEditing')

    // `submitBehavior` is 'newline' there, so this handler is not the one that
    // runs; reaching it at all means the platform asked to submit.
    expect(handlers.onSend).toHaveBeenCalledWith('Ship it')
    expect(screen.queryByTestId('composer-key-hint')).toBeNull()
  })

  it('announces the two chords on the Mac and nowhere else', () => {
    // NOT wherever a bare Return sends. On an iPad with a keyboard case it does
    // send, and the line still has nowhere to be: iPadOS keeps its own keyboard
    // bar along the bottom of the window and the hint was drawn straight
    // through it, with the system's keyboard button sitting on the words.
    renderComposer({ hardwareKeyboard: true })
    expect(screen.queryByTestId('composer-key-hint')).toBeNull()

    runsOnMac.RUNS_ON_MAC = true

    try {
      renderComposer({ hardwareKeyboard: true })
      expect(screen.getByTestId('composer-key-hint')).toBeTruthy()
    } finally {
      runsOnMac.RUNS_ON_MAC = false
    }
  })
})

/** Escape stops a running turn, and yields to the slash popover while it is open. */
describe('the Composer and Escape', () => {
  const pressEscape = () =>
    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

  it('stops a running turn', () => {
    const handlers = renderComposer({ running: true, value: 'ignored' })

    pressEscape()

    expect(handlers.onStop).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no turn is running', () => {
    const handlers = renderComposer({ value: 'idle' })

    pressEscape()

    expect(handlers.onStop).not.toHaveBeenCalled()
  })

  it('closes the slash popover first, and leaves the turn running', () => {
    const handlers = renderComposer({ running: true, suggestions: SUGGESTIONS, value: '/' })

    expect(screen.getByTestId('composer-slash-popover')).toBeTruthy()

    pressEscape()

    expect(handlers.onStop).not.toHaveBeenCalled()
    expect(screen.queryByTestId('composer-slash-popover')).toBeNull()
    // The draft is untouched: dismissing the list is not deleting the slash.
    expect(handlers.onChangeText).not.toHaveBeenCalled()

    // With the popover gone the turn is next in line.
    pressEscape()
    expect(handlers.onStop).toHaveBeenCalledTimes(1)
  })
})

/**
 * The attach menu as a POPOVER.
 *
 * It was a list of two rows in a card above the composer; the choices are round icon
 * buttons with their labels underneath now, so two choices read as two objects.
 *
 * It also had a TAIL aimed at the `+`, and the owner's call is that it must not: a
 * tail is a bubble's shape and a menu that wears one reads as something the composer
 * said. What replaces it is the MOTION, which is why the two facts about leaving are
 * asserted here rather than left to the eye — the menu has to animate OUT as well as
 * in, and it must stop taking taps the moment it starts leaving, or the tap that
 * dismissed it lands on it twice.
 */
describe('the attach popover', () => {
  const hidden = { includeHiddenElements: true } as const

  /** The stacked list's `minWidth`; the popover has none, which is how they differ. */
  const widthFloorOf = (testID: string): number | undefined =>
    (StyleSheet.flatten(screen.getByTestId(testID).props.style as never) as { minWidth?: number }).minWidth

  const pressEscape = () =>
    act(() => {
      for (const listener of [...mockEscapeListeners]) {
        listener()
      }
    })

  const openMenu = (props: Record<string, unknown> = {}) => {
    const handlers = renderComposer(props)

    fireEvent.press(screen.getByTestId('composer-attach'))

    return handlers
  }

  it('wears no tail, on either layout', () => {
    openMenu()

    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()
    expect(screen.queryByTestId('composer-attach-menu-pointer', hidden)).toBeNull()
    // The anchor view the tail was positioned against went with it.
    expect(screen.queryByTestId('composer-attach-menu-anchor', hidden)).toBeNull()
  })

  it('draws each choice as an icon with its label underneath, not as a row of text', () => {
    openMenu()

    // A drawn mark, per choice — not a glyph, not a row.
    expect(screen.getByTestId('composer-attach-menu-photo')).toBeTruthy()
    expect(screen.getByTestId('composer-attach-menu-file')).toBeTruthy()
    expect(screen.getByText('Photo library')).toBeTruthy()
    expect(screen.getByText('Choose file')).toBeTruthy()

    // The popover is a ROW of choices; a column of two is the list layout.
    const inner = StyleSheet.flatten(screen.getByTestId('composer-attach-menu').props.style as never)

    expect(inner).toBeTruthy()
  })

  it('dismisses on a tap that is not on it, and leaves by animating out', () => {
    openMenu()

    expect(screen.getByTestId('composer-attach-appear').props.pointerEvents).toBe('auto')

    fireEvent.press(screen.getByTestId('composer-attach-dismiss'))

    // Still mounted: that frame is the exit. It used to be `exit="cut"`, which is
    // the thing the owner asked to change — a menu with no tail has only its
    // motion left to say where it went.
    expect(screen.getByTestId('composer-attach-menu')).toBeTruthy()
    // …and it takes no taps while it goes, so the dismissal cannot land twice.
    expect(screen.getByTestId('composer-attach-appear').props.pointerEvents).toBe('none')
    // The catcher, which is not animated, is gone on the same frame.
    expect(screen.queryByTestId('composer-attach-dismiss')).toBeNull()
  })

  it('dismisses on Escape, before anything else Escape could mean', () => {
    const handlers = openMenu({ running: true })

    pressEscape()

    expect(screen.getByTestId('composer-attach-appear').props.pointerEvents).toBe('none')
    expect(screen.queryByTestId('composer-attach-dismiss')).toBeNull()
    // Registered last, so the running turn is untouched — the menu is the level the
    // reader is looking at.
    expect(handlers.onStop).not.toHaveBeenCalled()
  })

  it('has no catcher to tap when it is closed', () => {
    renderComposer()

    expect(screen.queryByTestId('composer-attach-dismiss')).toBeNull()
  })

  it('falls back to the stacked list where the popover cannot fit', () => {
    renderComposer()

    // The composer's own width, reported as a phone's with the tray open.
    fireEvent(screen.getByTestId('composer-row'), 'layout', {
      nativeEvent: { layout: { width: ATTACH_POPOVER_MIN_WIDTH - 1, height: 60, x: 0, y: 0 } }
    })
    fireEvent.press(screen.getByTestId('composer-attach'))

    // The stacked list is the one with a floor under its width; the popover is as
    // wide as its two labels and no wider.
    expect(widthFloorOf('composer-attach-menu')).toBe(ATTACH_LIST_MIN_WIDTH)
    // …and the choices are still both there and still both work.
    expect(screen.getByText('Photo library')).toBeTruthy()
    expect(screen.getByText('Choose file')).toBeTruthy()
  })

  it('takes the popover at the width a chat column actually has', () => {
    renderComposer()

    fireEvent(screen.getByTestId('composer-row'), 'layout', {
      nativeEvent: { layout: { width: ATTACH_POPOVER_MIN_WIDTH, height: 60, x: 0, y: 0 } }
    })
    fireEvent.press(screen.getByTestId('composer-attach'))

    expect(widthFloorOf('composer-attach-menu')).toBeUndefined()
  })
})

/**
 * The pending tray.
 *
 * The cards in it are deliberately the SAME cards a sent message shows — that
 * is §6.7 — which is exactly what made the state ambiguous: the owner could not
 * tell a file that was attached from one already on its way. So the tray has to
 * say which it is in words, and the send button has to carry the fact too,
 * because the tray scrolls out of reach on a short screen with the keyboard up
 * and the button never does.
 *
 * It stays INSIDE the field. Lifting it back out into a strip of its own is the
 * shape this composer deliberately moved away from, and these assertions are
 * what stop a later change from undoing that by accident.
 */
describe('the Composer pending tray', () => {
  const image = { id: 'att-1', kind: 'image' as const, name: 'shot.png', uri: 'file:///tmp/shot.png' }
  const doc = { id: 'att-2', kind: 'file' as const, name: 'report.pdf', size: 2048 }

  it('says in words that the file has not gone anywhere', () => {
    renderComposer({ attachments: [doc] })

    expect(screen.getByTestId('composer-attachments-pending')).toBeTruthy()
    expect(screen.getByText('Not sent yet')).toBeTruthy()
    expect(screen.getByText('· 1 file')).toBeTruthy()
  })

  it('counts what is waiting', () => {
    renderComposer({ attachments: [image, doc] })

    expect(screen.getByText('· 2 files')).toBeTruthy()
  })

  it('has no tray at all with nothing attached', () => {
    renderComposer({ value: 'just words' })

    expect(screen.queryByTestId('composer-attachments-pending')).toBeNull()
    expect(screen.queryByTestId('composer-attachments')).toBeNull()
  })

  it('keeps the tray inside the field rather than above it', () => {
    renderComposer({ attachments: [doc] })

    // The field is the pill the caret is in; what is attached is attached to
    // the MESSAGE, which is that pill.
    expect(screen.getByTestId('composer-field')).toBeTruthy()
    expect(screen.getByTestId('composer-attachments-pending')).toBeTruthy()
  })

  it('still removes an image from its own ×', () => {
    const handlers = renderComposer({ attachments: [image] })

    fireEvent.press(screen.getByTestId('composer-attachment-remove-att-1'))
    expect(handlers.onRemoveAttachment).toHaveBeenCalledWith('att-1')
  })

  it('still removes a file from its own ×', () => {
    const handlers = renderComposer({ attachments: [doc] })

    fireEvent.press(screen.getByTestId('composer-attachment-att-2-remove'))
    expect(handlers.onRemoveAttachment).toHaveBeenCalledWith('att-2')
  })

  it('shows the count on the send button too', () => {
    renderComposer({ attachments: [image, doc] })

    expect(screen.getByTestId('composer-send-badge')).toBeTruthy()
    expect(screen.getByTestId('composer-send').props.accessibilityLabel).toBe('Send message with 2 attachments')
  })

  it('names a single attachment in the singular', () => {
    renderComposer({ attachments: [doc] })

    expect(screen.getByTestId('composer-send').props.accessibilityLabel).toBe('Send message with 1 attachment')
  })

  it('has no badge with nothing attached', () => {
    renderComposer({ value: 'just words' })

    expect(screen.queryByTestId('composer-send-badge')).toBeNull()
    expect(screen.getByTestId('composer-send').props.accessibilityLabel).toBe('Send message')
  })
})

describe('pasting from the general pasteboard', () => {
  it('reads the pasteboard on ⌘V while the field is focused, and hands over what it finds', async () => {
    mockHasNativePasteboard = true
    mockReadPasteboardAttachment.mockResolvedValue([
      { uri: 'file:///tmp/pasted.png', name: 'pasted.png', size: 10, mimeType: 'image/png' }
    ])

    const handlers = renderComposer()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    pressPaste()

    await waitFor(() =>
      expect(handlers.onPasteFiles).toHaveBeenCalledWith([
        { uri: 'file:///tmp/pasted.png', name: 'pasted.png', size: 10, mimeType: 'image/png' }
      ])
    )
    expect(mockReadPasteboardAttachment).toHaveBeenCalled()
  })

  it('does not ask the pasteboard when the field is unfocused', () => {
    mockHasNativePasteboard = true
    renderComposer()

    // No `fireEvent(..., 'focus')`: the field never took the caret.
    pressPaste()

    expect(mockReadPasteboardAttachment).not.toHaveBeenCalled()
  })

  it('does not ask on a build with no native pasteboard reader', () => {
    mockHasNativePasteboard = false
    renderComposer()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    pressPaste()

    expect(mockReadPasteboardAttachment).not.toHaveBeenCalled()
  })

  it('reports nothing when the pasteboard held only text, and leaves the field alone', async () => {
    mockHasNativePasteboard = true
    mockReadPasteboardAttachment.mockResolvedValue([])

    const handlers = renderComposer()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    pressPaste()

    await waitFor(() => expect(mockReadPasteboardAttachment).toHaveBeenCalled())
    expect(handlers.onPasteFiles).not.toHaveBeenCalled()
    // A plain-text ⌘V is the field's own `UITextView` doing what it always
    // does; this seam has nothing to say about it either way.
    expect(handlers.onChangeText).not.toHaveBeenCalled()
  })

  it('hands over every file from one paste, none of them dropped or repeated', async () => {
    mockHasNativePasteboard = true
    mockReadPasteboardAttachment.mockResolvedValue([
      { uri: 'file:///tmp/a.pdf', name: 'a.pdf', size: 10, mimeType: 'application/pdf' },
      { uri: 'file:///tmp/b.pdf', name: 'b.pdf', size: 20, mimeType: 'application/pdf' }
    ])

    const handlers = renderComposer()

    fireEvent(screen.getByTestId('composer-input'), 'focus')
    pressPaste()

    await waitFor(() =>
      expect(handlers.onPasteFiles).toHaveBeenCalledWith([
        { uri: 'file:///tmp/a.pdf', name: 'a.pdf', size: 10, mimeType: 'application/pdf' },
        { uri: 'file:///tmp/b.pdf', name: 'b.pdf', size: 20, mimeType: 'application/pdf' }
      ])
    )
    // Called exactly once: two files in one paste are one attach, not two.
    expect(handlers.onPasteFiles).toHaveBeenCalledTimes(1)
  })

  /**
   * The bug the owner rejected: on the Mac, `UIPasteboard` answers `true` to
   * `hasStrings` for a plain file just as readily as for typed words — see
   * `paste-revert.ts` — so `UITextView`'s own Edit ▸ Paste inserts the file's
   * path as text through the ordinary responder chain, entirely outside this
   * component, before `readPasteboardAttachment` even answers. These three
   * simulate that by calling `onChangeText` and re-rendering with the new
   * value BETWEEN `pressPaste()` and the mocked promise resolving — exactly
   * the order those two independent paths race in on a real Mac.
   */
  describe('undoing the stray text a file paste leaves behind', () => {
    it('removes a file path pasted into an empty field, and still attaches the file', async () => {
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers, rerender } = renderComposerHandle({ value: '' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      pressPaste()

      fireEvent.changeText(screen.getByTestId('composer-input'), 'file:///.file/id=6571367.77787307')
      rerender({ value: 'file:///.file/id=6571367.77787307' })

      resolvePaste([{ uri: 'file:///tmp/report.pdf', name: 'report.pdf', size: 1, mimeType: 'application/pdf' }])

      await waitFor(() =>
        expect(handlers.onPasteFiles).toHaveBeenCalledWith([
          { uri: 'file:///tmp/report.pdf', name: 'report.pdf', size: 1, mimeType: 'application/pdf' }
        ])
      )
      expect(handlers.onChangeText).toHaveBeenLastCalledWith('')
    })

    it('leaves what was already typed on both sides of a file pasted mid-sentence', async () => {
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers, rerender } = renderComposerHandle({ value: 'check this  before you send' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      fireEvent(screen.getByTestId('composer-input'), 'selectionChange', {
        nativeEvent: { selection: { start: 11, end: 11 } }
      })
      pressPaste()

      fireEvent.changeText(screen.getByTestId('composer-input'), 'check this file:///tmp/a.pdf before you send')
      rerender({ value: 'check this file:///tmp/a.pdf before you send' })

      resolvePaste([{ uri: 'file:///tmp/a.pdf', name: 'a.pdf', size: 1, mimeType: 'application/pdf' }])

      await waitFor(() => expect(handlers.onPasteFiles).toHaveBeenCalled())
      expect(handlers.onChangeText).toHaveBeenLastCalledWith('check this  before you send')
    })

    it('does not touch the field when nothing was inserted in between', async () => {
      // Some builds and some pasteboard contents never trigger the UIKit
      // quirk at all — an image with no string representation, for one. There
      // must be nothing here that fires on every file paste regardless.
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers } = renderComposerHandle({ value: 'draft' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      pressPaste()

      resolvePaste([{ uri: 'file:///tmp/photo.png', name: 'photo.png', size: 1, mimeType: 'image/png' }])

      await waitFor(() => expect(handlers.onPasteFiles).toHaveBeenCalled())
      expect(handlers.onChangeText).not.toHaveBeenCalled()
    })
  })

  /**
   * The window those two arrivals are raced in.
   *
   * The cases above put the field's render FIRST, which is only one of the two
   * orderings — and the one a single check at the moment the pasteboard answers
   * happens to get right. These put the bridge first, which is what a ⌘V on a
   * machine with a busy render queue actually looks like, and then hold the
   * window open while the reader keeps using the field. Fake timers because the
   * window is the subject: every case here is about what a given number of
   * milliseconds does, and does not, let happen.
   */
  describe('the window it looks for that insertion in', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('still reverts when the pasteboard answers before the field holds the path', async () => {
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers, rerender } = renderComposerHandle({ value: '' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      pressPaste()

      // The bridge wins the race, so the window opens against a field UIKit has
      // not reached yet and the first look has nothing to undo. This is the
      // ordering the one-shot check answered "nothing happened" to.
      resolvePaste([{ uri: 'file:///tmp/report.pdf', name: 'report.pdf', size: 1, mimeType: 'application/pdf' }])
      await flushPasteboard()

      expect(handlers.onPasteFiles).toHaveBeenCalled()
      expect(handlers.onChangeText).not.toHaveBeenCalled()

      // UIKit's own paste commits a render later — one tick, in this test.
      fireEvent.changeText(screen.getByTestId('composer-input'), 'file:///.file/id=6571367.77787307')
      rerender({ value: 'file:///.file/id=6571367.77787307' })

      act(() => void jest.advanceTimersByTime(PASTE_REVERT_POLL_MS))

      expect(handlers.onChangeText).toHaveBeenLastCalledWith('')
    })

    it('leaves a character the reader typed inside the window alone', async () => {
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers, rerender } = renderComposerHandle({ value: '' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      pressPaste()

      // An image, which has no string representation for UIKit to paste — so the
      // only thing that lands in the field while the window is open is a
      // keystroke, and a window that reverted any growth at all would eat it.
      resolvePaste([{ uri: 'file:///tmp/photo.png', name: 'photo.png', size: 1, mimeType: 'image/png' }])
      await flushPasteboard()

      fireEvent.changeText(screen.getByTestId('composer-input'), 'h')
      rerender({ value: 'h' })

      act(() => void jest.advanceTimersByTime(PASTE_REVERT_WINDOW_MS + PASTE_REVERT_POLL_MS))

      expect(handlers.onChangeText).toHaveBeenCalledTimes(1)
      expect(handlers.onChangeText).toHaveBeenLastCalledWith('h')
    })

    it('leaves a pasted path on screen once a word has been typed after it — the typing wins, the path stays', async () => {
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers, rerender } = renderComposerHandle({ value: '' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      pressPaste()

      resolvePaste([{ uri: 'file:///tmp/a.pdf', name: 'a.pdf', size: 1, mimeType: 'application/pdf' }])
      await flushPasteboard()

      // Both arrive before the next look: UIKit's path, and then a word typed
      // after it. The span is no longer one bare reference, and there is nothing
      // in the string to say how much of it was the paste — so nothing comes
      // out. A path left in the draft is something the reader can delete; a
      // sentence deleted out from under them is not something they can get back.
      fireEvent.changeText(screen.getByTestId('composer-input'), 'file:///tmp/a.pdf have a look')
      rerender({ value: 'file:///tmp/a.pdf have a look' })

      act(() => void jest.advanceTimersByTime(PASTE_REVERT_WINDOW_MS + PASTE_REVERT_POLL_MS))

      expect(handlers.onChangeText).toHaveBeenCalledTimes(1)
      expect(handlers.onChangeText).toHaveBeenLastCalledWith('file:///tmp/a.pdf have a look')
    })

    it('does not fire into the draft that replaced a sent one', async () => {
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers, rerender } = renderComposerHandle({ value: 'ship it' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      // The whole draft selected, which is a paste OVER it: that is the shape
      // whose snapshot has neither a prefix nor a suffix, so the bracket check
      // matches any later draft and the cancellation is the only thing left
      // standing between the two messages.
      fireEvent(screen.getByTestId('composer-input'), 'selectionChange', {
        nativeEvent: { selection: { start: 0, end: 7 } }
      })
      pressPaste()

      resolvePaste([{ uri: 'file:///tmp/a.pdf', name: 'a.pdf', size: 1, mimeType: 'application/pdf' }])
      await flushPasteboard()

      // Sent while the window was still open, and a next message begun that
      // happens to be a path — a reader pointing at a log file.
      fireEvent.press(screen.getByTestId('composer-send'))
      rerender({ value: '' })
      rerender({ value: '/var/log/system.log' })

      act(() => void jest.advanceTimersByTime(PASTE_REVERT_WINDOW_MS + PASTE_REVERT_POLL_MS))

      expect(handlers.onSend).toHaveBeenCalledWith('ship it')
      expect(handlers.onChangeText).not.toHaveBeenCalled()
    })

    it('lets the second ⌘V own the window, not the first', async () => {
      mockHasNativePasteboard = true

      const resolvers: ((files: unknown[]) => void)[] = []

      mockReadPasteboardAttachment.mockImplementation(
        () => new Promise(resolve => resolvers.push(resolve as (files: unknown[]) => void))
      )

      const { handlers, rerender } = renderComposerHandle({ value: 'one' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      fireEvent(screen.getByTestId('composer-input'), 'selectionChange', {
        nativeEvent: { selection: { start: 0, end: 3 } }
      })
      pressPaste()
      pressPaste()

      // The first ⌘V's bridge call answers LAST, which a bridge is free to do.
      // Its snapshot is two pastes old by then and must not open a window.
      resolvers[1]([{ uri: 'file:///tmp/b.pdf', name: 'b.pdf', size: 1, mimeType: 'application/pdf' }])
      await flushPasteboard()
      resolvers[0]([{ uri: 'file:///tmp/a.pdf', name: 'a.pdf', size: 1, mimeType: 'application/pdf' }])
      await flushPasteboard()

      // Both files are attached either way: two ⌘V are two pastes, not one
      // paste and a correction.
      expect(handlers.onPasteFiles).toHaveBeenCalledTimes(2)

      fireEvent.changeText(screen.getByTestId('composer-input'), '/tmp/a.pdf')
      rerender({ value: '/tmp/a.pdf' })

      act(() => void jest.advanceTimersByTime(PASTE_REVERT_POLL_MS))

      // Once, by the window the second ⌘V owns. Two live windows would both
      // revert on the same tick.
      expect(handlers.onChangeText).toHaveBeenCalledTimes(2)
      expect(handlers.onChangeText).toHaveBeenLastCalledWith('one')
    })

    it('stops looking when the window closes, rather than polling on', async () => {
      mockHasNativePasteboard = true

      const resolvePaste = deferredPaste()
      const { handlers } = renderComposerHandle({ value: 'draft' })

      fireEvent(screen.getByTestId('composer-input'), 'focus')
      pressPaste()

      resolvePaste([{ uri: 'file:///tmp/photo.png', name: 'photo.png', size: 1, mimeType: 'image/png' }])
      await flushPasteboard()

      act(() => void jest.advanceTimersByTime(PASTE_REVERT_WINDOW_MS + PASTE_REVERT_POLL_MS))

      expect(handlers.onChangeText).not.toHaveBeenCalled()
      // Nothing left on the clock: the window is a window, not a subscription.
      expect(jest.getTimerCount()).toBe(0)
    })
  })
})

/**
 * The field after a send, with the native side of the text view modelled.
 *
 * `fireEvent.changeText` cannot show this bug, because it has no native side:
 * the jest preset replaces `TextInput` with a plain host element, so a value the
 * composer is handed is the value on screen by definition. On a device it is
 * not. React Native keeps the `UITextView` and the JavaScript `value` in step
 * with an event counter (`mostRecentEventCount`), and the model below is that
 * protocol, taken from the 0.81 sources rather than invented:
 *
 *  - every edit made ON the native side bumps the counter and is reported to
 *    JavaScript as a change carrying the new count
 *    (`RCTTextInputComponentView -textInputDidChange` / `-_updateState`);
 *  - the text a Return submits travels with the count it was pressed at
 *    (`-textInputShouldSubmitOnReturn`, `_textInputMetrics`);
 *  - after each commit, JavaScript pushes its `value` to the view whenever it
 *    differs from the last text the view reported
 *    (`useTextInputStateSynchronization` in `TextInput.js`), stamped with the
 *    newest count JavaScript has SEEN;
 *  - and the view throws that push away if its own count has moved on since
 *    (`-setTextAndSelection:` returns early on `_mostRecentEventCount !=
 *    eventCount`). The state-update road to the same view has the same guard
 *    (`-updateState:oldState:`).
 *
 * Events are delivered in groups, and every event in a group reaches the
 * handlers the tree had BEFORE the group — `EventQueueProcessor::flushEvents`
 * dispatches the whole batch in one JavaScript task, and a discrete update
 * renders in the microtask after it. A group of one is the idle case; a group of
 * several is what a keyboard produces while the JavaScript thread is busy with
 * something else, which on a chat screen is a streaming reply.
 */
describe('the field after a send, against the native text view', () => {
  const ORIGINAL_OS = Platform.OS

  // Deadlines are read off `Date.now()`, which fake timers hold still until a
  // test moves them — so "at once" and "much later" are both exact.
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => {
    jest.useRealTimers()
    Platform.OS = ORIGINAL_OS
  })

  interface Owner {
    /** Put a draft in from outside, the way a failed send or a prefill does. */
    setDraft: (text: string) => void
  }

  function nativeField({
    clearOnSend = true,
    dictation,
    slowCommitMs = 0,
    withAttachment = false
  }: {
    clearOnSend?: boolean
    dictation?: ComposerDictation
    /** Time that passes between a send and the commit that pushes its clear out. */
    slowCommitMs?: number
    withAttachment?: boolean
  } = {}) {
    const view = { count: 0, text: '' }
    const js = { count: 0, lastNativeText: '' }
    const queue: ((props: Record<string, ((...args: unknown[]) => void) | undefined>) => void)[] = []
    const pushes: { count: number; text: string }[] = []
    const sent: string[] = []
    const owner: Owner = { setDraft: () => undefined }

    /**
     * One draft per chat and one setter per chat, the way `ChatScreen` hands
     * them to a composer the wide layout keeps mounted across a switch.
     */
    function Host({ chat }: { chat: string }) {
      const [drafts, setDrafts] = useState<Record<string, string>>({})
      // An unchanged draft changes no state, the way a store's selector does not
      // re-render its reader for an equal value.
      const setDraft = useCallback(
        (text: string) => setDrafts(all => ((all[chat] ?? '') === text ? all : { ...all, [chat]: text })),
        [chat]
      )

      owner.setDraft = setDraft

      return (
        <Composer
          hardwareKeyboard
          onChangeText={setDraft}
          onSend={text => {
            sent.push(text)

            // Cleared in the same event, the way `ChatScreen` does it.
            if (clearOnSend) {
              setDraft('')
            }

            if (slowCommitMs) {
              jest.advanceTimersByTime(slowCommitMs)
            }
          }}
          value={drafts[chat] ?? ''}
          {...(withAttachment ? { attachments: [{ id: 'att-1', kind: 'image', name: 'diagram.png' }] } : {})}
          {...(dictation ? { dictation } : {})}
        />
      )
    }

    const rendered = renderScreen(<Host chat="a" />)

    const field = () => screen.getByTestId('composer-input')

    /** The layout effect after a commit: push `value` if the view last said something else. */
    const sync = () => {
      const value = field().props.value as string

      if (value !== js.lastNativeText) {
        pushes.push({ count: js.count, text: value })
        js.lastNativeText = value
      }
    }

    /** One native edit, handled by the view before anything else and then reported. */
    const edit = (next: string) => {
      view.text = next
      view.count += 1

      const text = view.text
      const eventCount = view.count

      queue.push(props => {
        props.onChange?.({ nativeEvent: { eventCount, text } })
        props.onChangeText?.(text)
        js.lastNativeText = text
        js.count = eventCount
      })
    }

    /** Keys on the hardware keyboard, one edit each. */
    const type = (keys: string) => {
      for (const key of keys) {
        edit(view.text + key)
      }
    }

    /** A paste, a QuickType suggestion, one emoji key: several characters in ONE edit. */
    const insert = (text: string) => edit(view.text + text)

    /** Backspace, one code point. */
    const backspace = () => edit(Array.from(view.text).slice(0, -1).join(''))

    /**
     * A key that rewrites the character before the caret instead of adding one:
     * the Korean keyboard building a syllable, the Japanese 12-key keyboard's
     * multi-tap and voiced-sound key.
     */
    const replaceLast = (character: string) => edit(`${Array.from(view.text).slice(0, -1).join('')}${character}`)

    /** UIKit reporting the same text a second time, with no edit of its own in between. */
    const repeatReport = () => {
      const text = view.text

      queue.push(props => props.onChangeText?.(text))
    }

    /** A tap on the send button, in the same group as whatever is queued before it. */
    const tapSend = () => {
      queue.push(() => fireEvent.press(screen.getByTestId('composer-send')))
    }

    /** The wide layout's chat switch: same composer, the next chat's draft and setter. */
    const switchChat = (chat: string) => {
      rendered.rerender(withProviders(<Host chat={chat} />))
      sync()
    }

    /** The owner writes the draft itself, outside any event from the field. */
    const ownerWrites = (text: string) => {
      act(() => owner.setDraft(text))
      sync()
    }

    /** Time passing with nothing typed. */
    const wait = (ms: number) => act(() => void jest.advanceTimersByTime(ms))

    /** A bare Return, which `submitBehavior: 'submit'` turns into a submit and nothing else. */
    const pressReturn = () => {
      const text = view.text
      const eventCount = view.count

      queue.push(props => props.onSubmitEditing?.({ nativeEvent: { eventCount, text } }))
    }

    /** Deliver everything queued as ONE group, then commit. */
    const deliver = () => {
      const props = field().props as Record<string, ((...args: unknown[]) => void) | undefined>
      const group = queue.splice(0)

      act(() => {
        for (const event of group) {
          event(props)
        }
      })
      sync()
    }

    /** Let the view act on what JavaScript pushed at it. */
    const land = () => {
      for (const push of pushes.splice(0)) {
        if (push.count === view.count) {
          view.text = push.text
        }
      }
    }

    /** Type and let everything settle, so the next step starts from rest. */
    const settle = (keys: string) => {
      for (const key of keys) {
        type(key)
        deliver()
        land()
      }
    }

    /** Deliver and land until nothing is left in flight. */
    const rest = () => {
      deliver()
      land()
    }

    return {
      backspace,
      deliver,
      edit,
      field,
      insert,
      land,
      ownerWrites,
      pressReturn,
      repeatReport,
      replaceLast,
      rest,
      sent,
      settle,
      switchChat,
      tapSend,
      type,
      view,
      wait
    }
  }

  /** Send `text` and let the clear land cleanly: the view is empty and nothing is in flight. */
  function sentCleanly(f: ReturnType<typeof nativeField>, text: string) {
    f.settle(text)
    f.pressReturn()
    f.rest()
    expect(f.view.text).toBe('')
  }

  /** What is on screen and what the owner holds, which must agree once everything has landed. */
  function expectField(f: ReturnType<typeof nativeField>, text: string) {
    expect(f.field().props.value).toBe(text)
    expect(f.view.text).toBe(text)
  }

  it('clears the field when nothing else happens, which is the ordinary send', () => {
    const f = nativeField()

    f.settle('hello')
    f.pressReturn()
    f.deliver()
    f.land()

    expect(f.sent).toEqual(['hello'])
    expect(f.view.text).toBe('')
    expect(f.field().props.value).toBe('')
  })

  it('does not bring the sent words back when the next key lands before the clear can render', () => {
    // Return and the first key of the next message arrive in one group: the
    // key's report was made from the field as it stood BEFORE the send, so
    // taking it at face value writes the sent message back into the draft.
    const f = nativeField()

    f.settle('hello')
    f.pressReturn()
    f.type('n')
    f.deliver()
    f.land()

    expect(f.sent).toEqual(['hello'])
    expect(f.field().props.value).toBe('n')
    expect(f.view.text).toBe('n')
  })

  it('does not keep the sent words when the view refuses the clear because a key beat it there', () => {
    // The clear goes out stamped with the count of the Return. A key typed
    // while it is on its way moves the view's count on, the view drops the
    // clear as stale, and the next report still starts with the sent message.
    const f = nativeField()

    f.settle('hello')
    f.pressReturn()
    f.deliver()
    f.type('n')
    f.land()
    f.deliver()
    f.land()

    expect(f.sent).toEqual(['hello'])
    expect(f.field().props.value).toBe('n')
    expect(f.view.text).toBe('n')
  })

  it('keeps up with a reader who goes on typing while the view keeps refusing', () => {
    const f = nativeField()

    f.settle('hello')
    f.pressReturn()
    f.deliver()
    f.type('n')
    f.land()
    f.deliver()
    f.type('e')
    f.land()
    f.deliver()
    f.type('w')
    f.deliver()
    f.land()

    expect(f.sent).toEqual(['hello'])
    expect(f.field().props.value).toBe('new')
    expect(f.view.text).toBe('new')
  })

  it('sends what the field held at the Return, not the draft one render behind it', () => {
    // The last key and the Return in one group: the submit reaches a handler
    // that has not re-rendered since `hell`, while the text view has `hello`.
    const f = nativeField()

    f.settle('hell')
    f.type('o')
    f.pressReturn()
    f.deliver()
    f.land()

    expect(f.sent).toEqual(['hello'])
    expect(f.view.text).toBe('')
    expect(f.field().props.value).toBe('')
  })

  it('never eats the first key of the next message, even one that repeats the last', () => {
    // A one-letter message, and the next one starts with the same letter: once
    // the clear has landed, every report is the reader's own typing.
    const f = nativeField()

    f.settle('k')
    f.pressReturn()
    f.deliver()
    f.land()
    f.settle('ko')

    expect(f.sent).toEqual(['k'])
    expect(f.field().props.value).toBe('ko')
    expect(f.view.text).toBe('ko')
  })

  it('never eats a next message that begins with the whole of the last one', () => {
    const f = nativeField()

    f.settle('ok')
    f.pressReturn()
    f.deliver()
    f.land()
    f.settle('okay then')

    expect(f.field().props.value).toBe('okay then')
    expect(f.view.text).toBe('okay then')
  })

  it('never eats it either when the first key of it raced the clear', () => {
    const f = nativeField()

    f.settle('ok')
    f.pressReturn()
    f.type('o')
    f.deliver()
    f.land()
    f.settle('kay')

    expect(f.sent).toEqual(['ok'])
    expect(f.field().props.value).toBe('okay')
    expect(f.view.text).toBe('okay')
  })

  it('tells the dictation binding that the draft it was writing into has gone', () => {
    const onSent = jest.fn()
    const f = nativeField({
      dictation: {
        available: true,
        caret: null,
        listening: true,
        notice: null,
        onPressIn: jest.fn(),
        onPressOut: jest.fn(),
        onSelection: jest.fn(),
        onSent
      }
    })

    f.settle('hello')
    expect(onSent).not.toHaveBeenCalled()

    f.pressReturn()
    f.deliver()

    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it('takes a Backspace inside an echo as a Backspace on the next message', () => {
    // `n` raced the clear and was rewritten; Backspace beats that rewrite to
    // the view too, which then reports the sent message alone.
    const f = nativeField()

    f.settle('hello')
    f.pressReturn()
    f.deliver()
    f.type('n')
    f.land()
    f.deliver()
    f.backspace()
    f.land()
    f.rest()

    expect(f.sent).toEqual(['hello'])
    expectField(f, '')
  })

  it('counts the window from the commit that pushes the clear, not from the Return', () => {
    // A render slower than the window, between the send and its clear.
    const f = nativeField({ slowCommitMs: SEND_ECHO_WINDOW_MS + 100 })

    f.settle('hello')
    f.pressReturn()
    f.deliver()
    f.type('n')
    f.land()
    f.rest()

    expect(f.sent).toEqual(['hello'])
    expectField(f, 'n')
  })

  it('does not bring a window that has run out back to life on a later commit', () => {
    // A rewrite to the draft the owner already holds commits nothing, so its
    // request to restart the window is still pending when an unrelated commit
    // comes along long after the window closed.
    const f = nativeField()

    f.settle('hello')
    f.pressReturn()
    f.deliver()
    f.type('n')
    f.land()
    f.deliver()
    f.repeatReport()
    f.rest()
    expectField(f, 'n')

    f.wait(SEND_ECHO_WINDOW_MS * 2)
    // Same chat: a commit with nothing changed.
    f.switchChat('a')
    // Select all and paste: the one shape an echo of `hello` could have.
    f.edit('hello!')
    f.rest()

    expectField(f, 'hello!')
  })

  describe('keyboards that type by rewriting the last character', () => {
    /** Send `sent`, have `first` race the clear and be caught, then let the rewrite land. */
    function caughtAfter(sent: string, first: string) {
      const f = nativeField()

      f.settle(sent)
      f.pressReturn()
      f.deliver()
      f.type(first)
      f.land()
      f.deliver()
      f.land()
      expectField(f, first)

      return f
    }

    it('keeps a Korean syllable built on a caught jamo', () => {
      // Send 네, then ㄴ + ㅔ is 네 again: the keyboard rewrites ㄴ in place.
      const f = caughtAfter('네', 'ㄴ')

      f.replaceLast('네')
      f.rest()

      expect(f.sent).toEqual(['네'])
      expectField(f, '네')
    })

    it('keeps a Japanese multi-tap on a caught kana', () => {
      // Send き, then the か key tapped once and again: か, then き.
      const f = caughtAfter('き', 'か')

      f.replaceLast('き')
      f.rest()

      expectField(f, 'き')
    })

    it('keeps the voiced-sound key on a caught kana', () => {
      const f = caughtAfter('が', 'か')

      f.replaceLast('が')
      f.rest()

      expectField(f, 'が')
    })

    it('keeps a QuickType word that finishes a caught character, space and all', () => {
      // `ok` sent, a fast `o` caught, then the suggestion turns `o` into `ok `.
      const f = caughtAfter('ok', 'o')

      f.replaceLast('ok ')
      f.rest()

      expect(f.sent).toEqual(['ok'])
      expectField(f, 'ok ')
    })

    it('keeps the same for a one-letter start', () => {
      const f = caughtAfter('hi', 'h')

      f.replaceLast('hi ')
      f.rest()

      expectField(f, 'hi ')
    })

    it('still takes the echo off when the syllable is built before the rewrite lands', () => {
      const f = nativeField()

      f.settle('네')
      f.pressReturn()
      f.deliver()
      f.type('ㄴ')
      f.land()
      f.deliver()
      // ㅔ reaches the view while it still holds 네ㄴ: it reports 네네.
      f.replaceLast('네')
      f.land()
      f.rest()

      expect(f.sent).toEqual(['네'])
      expectField(f, '네')
    })
  })

  describe('a second Return', () => {
    it('sends once when it reaches the view before the clear, in the same group', () => {
      const f = nativeField()

      f.settle('hello')
      f.pressReturn()
      f.pressReturn()
      f.rest()

      expect(f.sent).toEqual(['hello'])
      expectField(f, '')
    })

    it('sends once when it reaches the view before the clear, one group later', () => {
      const f = nativeField()

      f.settle('hello')
      f.pressReturn()
      f.deliver()
      // The clear is still on its way: the view holds `hello` for this Return.
      f.pressReturn()
      f.rest()

      expect(f.sent).toEqual(['hello'])
      expectField(f, '')
    })

    it('sends a one-letter message once too', () => {
      const f = nativeField()

      f.settle('k')
      f.pressReturn()
      f.deliver()
      f.pressReturn()
      f.rest()

      expect(f.sent).toEqual(['k'])
    })

    it('does not send the attachments a second time', () => {
      // The owner keeps the tray until the send is accepted, so a Return the
      // view took before the clear used to be a send of the tray on its own.
      const f = nativeField({ withAttachment: true })

      f.settle('look')
      f.pressReturn()
      f.deliver()
      f.pressReturn()
      f.rest()

      expect(f.sent).toEqual(['look'])
    })

    it('is not followed by a send-button tap in the same group sending the tray again', () => {
      const f = nativeField({ withAttachment: true })

      f.settle('look')
      f.pressReturn()
      f.tapSend()
      f.rest()

      expect(f.sent).toEqual(['look'])
    })

    it('sends the next message, not the stale text the view carried, when a key came between', () => {
      // `ok`, Return, `?`, Return, all in one group while a reply streams.
      const f = nativeField()

      f.settle('ok')
      f.pressReturn()
      f.type('?')
      f.pressReturn()
      f.rest()

      expect(f.sent).toEqual(['ok', '?'])
      expectField(f, '')
    })

    it('still takes the echo of both messages off the key after them', () => {
      const f = nativeField()

      f.settle('ok')
      f.pressReturn()
      f.type('?')
      f.pressReturn()
      f.deliver()
      f.type('!')
      f.land()
      f.rest()
      f.land()

      expect(f.sent).toEqual(['ok', '?'])
      expectField(f, '!')
    })
  })

  describe('an insertion that begins with the message just sent', () => {
    it('keeps a paste at once', () => {
      const f = nativeField()

      sentCleanly(f, '1')
      f.insert('10.0.0.5 is the IP')
      f.rest()

      expectField(f, '10.0.0.5 is the IP')
    })

    it('keeps a paste much later', () => {
      const f = nativeField()

      sentCleanly(f, 'y')
      f.wait(60_000)
      f.insert('yarn build failed')
      f.rest()

      expectField(f, 'yarn build failed')
    })

    it('keeps a pasted link that extends the one just sent', () => {
      const f = nativeField()

      sentCleanly(f, 'https://x.io/a')
      f.insert('https://x.io/a/b')
      f.rest()

      expectField(f, 'https://x.io/a/b')
    })

    it('keeps a multi-character insert at once', () => {
      const f = nativeField()

      sentCleanly(f, 'ok')
      f.insert('okay')
      f.rest()

      expectField(f, 'okay')
    })

    it('keeps a QuickType word once the window has closed', () => {
      const f = nativeField()

      sentCleanly(f, 'Thanks')
      f.wait(1000)
      f.insert('Thanks ')
      f.rest()

      expectField(f, 'Thanks ')
    })

    it('keeps an emoji whose skin tone the same key added', () => {
      const f = nativeField()

      sentCleanly(f, '👍')
      f.insert('👍🏽')
      f.rest()

      expectField(f, '👍🏽')
    })

    it('keeps the one shape an echo has, once the window has closed — the app was away', () => {
      // `hello!` in one go is exactly what an echo of `hello` looks like. The
      // only thing that tells them apart is time: backgrounding, a chat switch
      // or anything else a reader does between two messages is longer than
      // the window.
      const f = nativeField()

      sentCleanly(f, 'hello')
      f.wait(5000)
      f.insert('hello!')
      f.rest()

      expectField(f, 'hello!')
    })
  })

  describe('where nothing is ever taken off', () => {
    it.each(['web', 'android'] as const)('on %s', os => {
      Platform.OS = os

      const f = nativeField()

      sentCleanly(f, 'hello')
      f.insert('hello!')
      f.rest()

      expectField(f, 'hello!')
    })

    it('in the next chat, when the composer stays mounted across the switch', () => {
      const f = nativeField()

      sentCleanly(f, 'hello')
      f.switchChat('b')
      f.insert('hello!')
      f.rest()

      expectField(f, 'hello!')
    })

    it('after a failed send puts the message back', () => {
      const f = nativeField()

      sentCleanly(f, 'hello')
      f.ownerWrites('hello')
      f.land()
      f.type('!')
      f.rest()

      expectField(f, 'hello!')
    })

    it('after a prefill hands back the text that was sent', () => {
      // `/undo` and `/queue edit` put text in the field from outside; that is
      // the owner's word on the draft, whatever it happens to begin with.
      const f = nativeField()

      sentCleanly(f, '/retry')
      f.ownerWrites('/retry')
      f.land()
      f.type('!')
      f.rest()

      expectField(f, '/retry!')
    })

    it('when the owner keeps the draft instead of clearing it', () => {
      const f = nativeField({ clearOnSend: false })

      f.settle('hello')
      f.pressReturn()
      f.rest()
      f.type('!')
      f.rest()

      expect(f.sent).toEqual(['hello'])
      expectField(f, 'hello!')
    })
  })
})
