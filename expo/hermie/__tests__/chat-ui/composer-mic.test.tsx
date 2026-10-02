/**
 * The composer's microphone: whether it is there, what it says, and the one line
 * that appears under the row when the recognizer refuses.
 *
 * The button is bound to a `ComposerDictation`, which is plain data — so
 * everything here is about what the kit DRAWS for a given binding. The machine
 * behind it has its own suite (`dictation.test.ts`) and no microphone in it.
 */
import { fireEvent, screen } from '@testing-library/react-native'

import { Composer } from '../../src/chat-ui'
import type { ComposerDictation } from '../../src/chat-ui/types'
import { renderScreen, withProviders } from '../support/render'

function binding(over: Partial<ComposerDictation> = {}): ComposerDictation {
  return {
    available: true,
    listening: false,
    notice: null,
    onPressIn: jest.fn(),
    onPressOut: jest.fn(),
    caret: null,
    onSelection: jest.fn(),
    ...over
  }
}

function renderComposer(props: Record<string, unknown> = {}) {
  const rendered = renderScreen(
    <Composer onChangeText={() => undefined} onSend={() => undefined} value="" {...props} />
  )

  return {
    ...rendered,
    // Wrapped, because `rerender` replaces the WHOLE tree: a bare element would
    // drop the theme and the safe-area provider on the floor.
    rerender: (next: Record<string, unknown>) =>
      rendered.rerender(
        withProviders(
          <Composer onChangeText={() => undefined} onSend={() => undefined} value="" {...props} {...next} />
        )
      )
  }
}

describe('the composer’s mic button', () => {
  it('is not drawn at all where the platform has no recognizer', () => {
    // Hidden rather than disabled: there is no later in which a browser grows a
    // speech API, so a permanently dimmed button would be a promise.
    renderComposer({ dictation: binding({ available: false }) })

    expect(screen.queryByTestId('composer-mic')).toBeNull()
  })

  it('is absent when the host passes no binding at all', () => {
    renderComposer()

    expect(screen.queryByTestId('composer-mic')).toBeNull()
  })

  it('reports both edges of the press, because the press IS the gesture', () => {
    const dictation = binding()

    renderComposer({ dictation })
    fireEvent(screen.getByTestId('composer-mic'), 'pressIn')
    fireEvent(screen.getByTestId('composer-mic'), 'pressOut')

    expect(dictation.onPressIn).toHaveBeenCalledTimes(1)
    expect(dictation.onPressOut).toHaveBeenCalledTimes(1)
  })

  it('says what the next press will do, and reports that it is on', () => {
    const view = renderComposer({ dictation: binding() })

    expect(screen.getByTestId('composer-mic').props.accessibilityLabel).toBe('Dictate')
    expect(screen.getByTestId('composer-mic').props['aria-pressed']).toBe(false)

    view.rerender({ dictation: binding({ listening: true }) })

    expect(screen.getByTestId('composer-mic').props.accessibilityLabel).toBe('Stop dictating')
    expect(screen.getByTestId('composer-mic').props['aria-pressed']).toBe(true)
  })

  it('offers voice mode as an accessibility action rather than on a long press', () => {
    /*
      The long press is how you HOLD the mic to talk, so a menu on it would take
      the gesture away from the feature the button exists for. VoiceOver's rotor
      and a secondary click both reach this instead.
    */
    const onOpenVoiceMode = jest.fn()

    renderComposer({ dictation: binding({ onOpenVoiceMode }) })

    const mic = screen.getByTestId('composer-mic')

    expect(mic.props.accessibilityActions).toEqual([{ name: 'voiceMode', label: 'Start voice mode' }])

    fireEvent(mic, 'accessibilityAction', { nativeEvent: { actionName: 'voiceMode' } })

    expect(onOpenVoiceMode).toHaveBeenCalled()
  })

  it('carries no such action where the host does not offer voice mode', () => {
    renderComposer({ dictation: binding() })

    expect(screen.getByTestId('composer-mic').props.accessibilityActions).toBeUndefined()
  })
})

describe('the one line under the row', () => {
  it('is absent while there is nothing to explain', () => {
    renderComposer({ dictation: binding() })

    expect(screen.queryByTestId('composer-mic-notice')).toBeNull()
  })

  it('explains a refused microphone and offers the way to undo it', () => {
    const onAction = jest.fn()

    renderComposer({
      dictation: binding({
        notice: { message: 'Hermie needs the microphone to take dictation.', actionLabel: 'Open Settings', onAction }
      })
    })

    expect(screen.getByTestId('composer-mic-notice')).toBeTruthy()
    fireEvent.press(screen.getByTestId('composer-mic-settings'))
    expect(onAction).toHaveBeenCalled()
  })

  it('shows the words alone where there is nowhere to send the reader', () => {
    // A browser: microphone permission lives in the site popover, which no page
    // can open, so naming a button that is not there would be worse than silence.
    renderComposer({ dictation: binding({ notice: { message: 'Nothing was heard.' } }) })

    expect(screen.getByTestId('composer-mic-notice')).toBeTruthy()
    expect(screen.queryByTestId('composer-mic-settings')).toBeNull()
  })
})

describe('where the caret goes after a result', () => {
  it('follows the binding, and moves again when the position repeats', () => {
    const field = () => screen.getByTestId('composer-input')

    const view = renderComposer({ dictation: binding({ caret: { start: 3, end: 3 } }), value: 'abcdef' })

    expect(field().props.selection).toEqual({ start: 3, end: 3 })

    /*
      A NEW object with the SAME numbers.

      Two results in a row can land the caret in the same place — a revision of
      the same length — and both are still events. The composer applies this on
      identity for exactly that reason.
    */
    view.rerender({ dictation: binding({ caret: { start: 3, end: 3 } }), value: 'abcdef' })

    expect(field().props.selection).toEqual({ start: 3, end: 3 })

    // And the field taking a position of its own releases the override, so the
    // caret is not fought over on every subsequent keystroke.
    fireEvent(field(), 'selectionChange', { nativeEvent: { selection: { start: 6, end: 6 } } })

    expect(field().props.selection).toBeUndefined()
  })

  it('tells the binding where the caret is, so dictation can take its anchor', () => {
    const dictation = binding()

    renderComposer({ dictation, value: 'abcdef' })
    fireEvent(screen.getByTestId('composer-input'), 'selectionChange', {
      nativeEvent: { selection: { start: 2, end: 4 } }
    })

    expect(dictation.onSelection).toHaveBeenCalledWith(2, 4)
  })
})
