/**
 * The composer's microphone, from the outside: a press starts and a press stops, what is heard goes into a field at
 * the caret as it is heard, and anything that changes the field by other means (typing, a send, a layer over the
 * page) ends the session. A fake recogniser: no microphone.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { voiceSettingsStore } from '../../state/voice-settings'
import { voiceActivityStore } from './activity'
import { DictationButton } from './DictationButton'
import type { DictationSnapshot } from './dictation'
import type { RecognitionEngine, RecognitionRequest } from '../../platform/speech-engines'

interface FakeEngine extends RecognitionEngine {
  starts: (string | undefined)[]
  stops: number
  aborts: number
  partial: (text: string) => void
  final: (text: string) => void
  fail: (failure: Parameters<NonNullable<RecognitionRequest['onError']>>[0]) => void
  end: () => void
}

function fakeEngine(): FakeEngine {
  let request: RecognitionRequest | null = null

  return {
    available: true,
    starts: [],
    stops: 0,
    aborts: 0,
    start(next: RecognitionRequest) {
      this.starts.push(next.language)
      request = next
    },
    stop() {
      this.stops += 1
    },
    abort() {
      this.aborts += 1
    },
    partial: text => request?.onPartial?.(text),
    final: text => request?.onFinal?.(text),
    fail: failure => request?.onError?.(failure),
    end: () => request?.onEnd?.()
  }
}

/** A field and its microphone, wired the way the composer wires them. */
function Harness({
  engine,
  initial = '',
  onState
}: {
  engine: RecognitionEngine
  initial?: string
  onState?: (snapshot: DictationSnapshot) => void
}): ReactElement {
  const [text, setText] = useState(initial)
  const field = useRef<HTMLTextAreaElement>(null)

  return (
    <div>
      <textarea ref={field} aria-label="message" value={text} onChange={event => setText(event.target.value)} />
      <DictationButton
        engine={engine}
        field={field}
        value={text}
        onValue={setText}
        onState={onState ?? (() => undefined)}
      />
    </div>
  )
}

const field = (): HTMLTextAreaElement => screen.getByLabelText('message')

afterEach(() => {
  resetActiveLocale()
  voiceActivityStore.getState().setDictating(false)
  voiceSettingsStore.getState().reset()
})

describe('the microphone button', () => {
  it('is named for what a press does, and held down while it listens', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} />)

    const button = screen.getByRole('button', { name: 'Dictate' })

    expect(button.getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(button)

    expect(screen.getByRole('button', { name: 'Stop dictating' }).getAttribute('aria-pressed')).toBe('true')
    expect(voiceActivityStore.getState().dictating).toBe(true)
  })

  it('puts what is heard into the field as it is heard, replacing its own last guess', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} initial="Dear team," />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))

    act(() => engine.partial('recognise'))
    expect(field().value).toBe('Dear team, recognise')

    act(() => engine.partial('recognise their'))
    expect(field().value).toBe('Dear team, recognise their')

    act(() => engine.final('recognise there work'))
    act(() => engine.end())
    expect(field().value).toBe('Dear team, recognise there work')
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy()
    expect(voiceActivityStore.getState().dictating).toBe(false)
  })

  it('goes in at the end of a draft the reader has not put the caret in yet', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} initial="Restored draft" />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.partial('and more'))

    expect(field().value).toBe('Restored draft and more')
  })

  it('goes in at the caret, and the caret lands after what was said', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} initial="Ask him about it" />)
    field().focus()
    field().setSelectionRange(8, 8)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.partial('tomorrow'))

    expect(field().value).toBe('Ask him tomorrow about it')
    expect(field().selectionStart).toBe(16)
  })

  it('stops on a second press, and the final result still lands', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.partial('send the report'))
    fireEvent.click(screen.getByRole('button', { name: 'Stop dictating' }))

    expect(engine.stops).toBe(1)

    act(() => engine.final('send the report today'))
    expect(field().value).toBe('send the report today')
  })

  it('starts with the language the reader chose, and with the browser’s own when they chose none', () => {
    const engine = fakeEngine()

    voiceSettingsStore.getState().setDictationLanguage('nl')
    render(<Harness engine={engine} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.end())
    voiceSettingsStore.getState().setDictationLanguage('auto')
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))

    expect(engine.starts).toEqual(['nl', undefined])
  })

  it('ends when the field is changed by hand, and what was written stays', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.partial('hello there'))
    fireEvent.change(field(), { target: { value: 'hello there, friend' } })

    expect(engine.aborts).toBe(1)
    expect(screen.getByRole('button', { name: 'Dictate' })).toBeTruthy()

    // A result for the session that ended must not overwrite the change.
    act(() => engine.final('hello there my friend'))
    expect(field().value).toBe('hello there, friend')
  })

  it('ends when the field is emptied from outside, as a send does', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.partial('ship it'))
    fireEvent.change(field(), { target: { value: '' } })
    act(() => engine.final('ship it now'))

    expect(field().value).toBe('')
  })

  it('writes nothing, and ends, while a layer over the page has made the field inert', () => {
    const engine = fakeEngine()
    const view = render(<Harness engine={engine} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.partial('my password is'))
    expect(field().value).toBe('my password is')

    view.container.setAttribute('inert', '')
    act(() => engine.partial('my password is hunter2'))

    expect(field().value).toBe('my password is')
    expect(engine.aborts).toBe(1)
  })

  it('closes the microphone when the screen goes away', () => {
    const engine = fakeEngine()
    const view = render(<Harness engine={engine} />)

    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    view.unmount()

    expect(engine.aborts).toBe(1)
    expect(voiceActivityStore.getState().dictating).toBe(false)
  })

  it('closes it when the tab goes to the background', () => {
    const engine = fakeEngine()

    render(<Harness engine={engine} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })

    expect(engine.aborts).toBe(1)
  })

  it('tells the composer what happened, so it can say why a try did not work', () => {
    const engine = fakeEngine()
    const phases: string[] = []

    render(<Harness engine={engine} onState={snapshot => phases.push(`${snapshot.phase}:${snapshot.failure ?? ''}`)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dictate' }))
    act(() => engine.fail('permission'))
    act(() => engine.end())

    expect(phases).toEqual(['listening:', 'error:permission'])
  })
})
