/**
 * Dictation: where the words go, and what each refusal says.
 *
 * The engine below never opens a microphone, which is the point of
 * `RecognitionEngine` being a seam — every state the machine can reach is
 * reachable from a test, including the two the simulator will not produce: a
 * permission refused while the reader's finger is still down, and a result
 * arriving for a session that has already been replaced.
 */
import { act, renderHook } from '@testing-library/react-native'

import {
  anchorAt,
  DICTATION_IDLE,
  DictationMachine,
  withTranscript,
  type DictationAnchor
} from '../src/features/voice/dictation'
import { HOLD_MS, PRESS_IDLE, pressIn, pressOut } from '../src/features/voice/press-to-talk'
import { noticeFor, useComposerDictation } from '../src/features/voice/useComposerDictation'
import type { RecognitionEngine, RecognitionPermission, RecognitionRequest } from '../src/platform/platform-contracts'

function fakeEngine(over: { available?: boolean; permission?: RecognitionPermission } = {}) {
  let request: RecognitionRequest | null = null

  return {
    available: over.available ?? true,
    starts: 0,
    stops: 0,
    aborts: 0,
    last: null as RecognitionRequest | null,
    async requestPermission(): Promise<RecognitionPermission> {
      return over.permission ?? 'granted'
    },
    async supportedLanguages(): Promise<string[]> {
      return []
    },
    start(next: RecognitionRequest) {
      this.starts += 1
      this.last = next
      request = next
    },
    stop() {
      this.stops += 1
    },
    abort() {
      this.aborts += 1
    },
    /** The platform reporting something on the session that is running. */
    partial(text: string) {
      request?.onPartial?.(text)
    },
    final(text: string) {
      request?.onFinal?.(text)
    },
    fail(failure: Parameters<NonNullable<RecognitionRequest['onError']>>[0]) {
      request?.onError?.(failure)
    },
    end() {
      request?.onEnd?.()
    },
    volume(level: number) {
      request?.onVolume?.(level)
    }
  } satisfies RecognitionEngine & Record<string, unknown>
}

describe('where a transcript lands in the draft', () => {
  const anchor = (value: string, start: number, end = start): DictationAnchor => anchorAt(value, { start, end })

  it('inserts at the caret rather than appending', () => {
    expect(withTranscript(anchor('Ask him about it', 8), 'tomorrow')).toEqual({
      value: 'Ask him tomorrow about it',
      caret: 16
    })
  })

  it('replaces a selected range, exactly as typing would', () => {
    expect(withTranscript(anchor('Ask him about it', 4, 7), 'her')).toEqual({
      value: 'Ask her about it',
      caret: 7
    })
  })

  it('recomputes from the anchor, so a revised partial replaces the last one', () => {
    /*
      The whole reason an anchor exists. A recognizer revises what it heard, so a
      field that appended each event would end up with every revision in it.
    */
    const at = anchor('Note: ', 6)

    expect(withTranscript(at, 'recognise').value).toBe('Note: recognise')
    expect(withTranscript(at, 'recognise the').value).toBe('Note: recognise the')
    expect(withTranscript(at, 'recognise their voice').value).toBe('Note: recognise their voice')
  })

  it('spaces the insertion against what is already there', () => {
    expect(withTranscript(anchor('hello', 5), 'there').value).toBe('hello there')
    expect(withTranscript(anchor('hello ', 6), 'there').value).toBe('hello there')
    expect(withTranscript(anchor('a  b', 2), 'x').value).toBe('a x b')
    // No space in front of punctuation that would look wrong with one.
    expect(withTranscript(anchor('.', 0), 'Done').value).toBe('Done.')
  })

  it('leaves the draft alone before anything has been heard', () => {
    expect(withTranscript(anchor('half a sentence', 4), '   ')).toEqual({ value: 'half a sentence', caret: 4 })
  })

  it('clamps a selection that does not fit the draft', () => {
    // A stale selection from before the draft was replaced — which a queued
    // message taken back for editing produces.
    expect(anchorAt('ab', { start: 90, end: 99 })).toEqual({ base: 'ab', start: 2, end: 2 })
  })
})

describe('the dictation machine', () => {
  it('starts idle, asks for permission, and listens', async () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    expect(machine.state).toEqual(DICTATION_IDLE)

    const started = machine.start({ language: 'nl-NL' })

    expect(machine.state.phase).toBe('starting')

    await started

    expect(machine.state.phase).toBe('listening')
    expect(engine.last?.language).toBe('nl-NL')
  })

  it('reports every result, marking which one is final', async () => {
    const engine = fakeEngine()
    const seen: [string, boolean][] = []
    const machine = new DictationMachine(engine, { onTranscript: (text, final) => seen.push([text, final]) })

    await machine.start()
    engine.partial('hel')
    engine.partial('hello')
    engine.final('hello there')

    expect(seen).toEqual([
      ['hel', false],
      ['hello', false],
      ['hello there', true]
    ])
    expect(machine.state.partial).toBe('hello there')
  })

  it('explains a refused microphone, and offers nothing else', async () => {
    const engine = fakeEngine({ permission: 'denied' })
    const machine = new DictationMachine(engine)

    await machine.start()

    expect(machine.state).toMatchObject({ phase: 'error', failure: 'permission' })
    // Never started: the dialog said no, so there is no session to tear down.
    expect(engine.starts).toBe(0)
  })

  it('refuses outright where there is no recognizer', async () => {
    const machine = new DictationMachine(fakeEngine({ available: false }))

    await machine.start()

    expect(machine.state).toMatchObject({ phase: 'error', failure: 'unavailable' })
  })

  it('keeps an error through the end of the session that produced it', async () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    await machine.start()
    engine.fail('no-speech')
    engine.end()

    // `end` always follows an error on Android, and it must not quietly wipe the
    // one thing the reader was about to be told.
    expect(machine.state).toMatchObject({ phase: 'error', failure: 'no-speech' })

    machine.clearError()

    expect(machine.state).toEqual(DICTATION_IDLE)
  })

  it('ignores a result from a session it has already replaced', async () => {
    const engine = fakeEngine()
    const seen: string[] = []
    const machine = new DictationMachine(engine, { onTranscript: text => seen.push(text) })

    await machine.start()

    const stale = engine.last

    machine.cancel()
    await machine.start()

    // The platform reporting the PREVIOUS utterance late. Acting on it would put
    // the last sentence into the field the reader is dictating into now.
    stale?.onPartial?.('from the old session')

    expect(seen).toEqual([])
  })

  it('cancels rather than stopping while the permission dialog is up', async () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)
    const started = machine.start()

    machine.stop()

    expect(engine.aborts).toBe(1)

    await started

    // The session that the dialog eventually granted must not start under a
    // reader who has already let go.
    expect(engine.starts).toBe(0)
  })

  it('follows the input level while listening and drops it at the end', async () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    await machine.start()
    engine.volume(0.7)

    expect(machine.state.level).toBeCloseTo(0.7)

    engine.end()

    expect(machine.state.level).toBe(0)
  })
})

describe('hold to talk, or tap to toggle', () => {
  it('starts on the way down and keeps listening after a quick tap', () => {
    const down = pressIn(PRESS_IDLE, false, 1000)

    expect(down.do).toBe('start')
    expect(pressOut(down.state, 1000 + HOLD_MS - 1).do).toBe('none')
  })

  it('stops when the finger has been down long enough to have been talking', () => {
    const down = pressIn(PRESS_IDLE, false, 1000)

    expect(pressOut(down.state, 1000 + HOLD_MS).do).toBe('stop')
  })

  it('stops on a second tap, and the release of that tap does nothing', () => {
    const down = pressIn(PRESS_IDLE, true, 2000)

    expect(down.do).toBe('stop')
    // Without this the release would stop an already-idle recognizer, which on
    // a slow tap would also cut a session the NEXT press had just started.
    expect(pressOut(down.state, 2000 + HOLD_MS + 50).do).toBe('none')
  })
})

/*
  A send in the middle of a session.

  Every result is written as the anchor PLUS the whole transcript, so a result
  that arrives after the draft was sent does not add to an empty field — it puts
  the entire sent sentence back. Tapping the mic off asks the recognizer for its
  final result, which arrives a moment later, and a Return in that moment is
  exactly the reader's report: the message went, and its words are still in the
  field.
*/
describe('dictating into a draft that is then sent', () => {
  it('stops the session and never writes the sent words back', async () => {
    const engine = fakeEngine()
    const writes: string[] = []
    const { rerender, result } = renderHook(
      ({ value }: { value: string }) =>
        useComposerDictation({ engine, onChangeText: text => void writes.push(text), value }),
      { initialProps: { value: '' } }
    )

    act(() => result.current.onPressIn())
    await act(async () => undefined)

    act(() => engine.partial('hello there'))
    rerender({ value: 'hello there' })

    expect(writes).toEqual(['hello there'])

    act(() => result.current.onSent?.())
    rerender({ value: '' })

    act(() => engine.partial('hello there again'))
    act(() => engine.final('hello there again'))

    expect(writes).toEqual(['hello there'])
    expect(engine.aborts).toBe(1)
    expect(result.current.listening).toBe(false)
  })

  it('leaves an idle recognizer alone', () => {
    const engine = fakeEngine()
    const { result } = renderHook(() => useComposerDictation({ engine, onChangeText: () => undefined, value: '' }))

    act(() => result.current.onSent?.())

    expect(engine.aborts).toBe(0)
  })
})

describe('what a failure says', () => {
  it('says something different for each one, and nothing for none', () => {
    expect(noticeFor(null)).toBeNull()
    expect(noticeFor('permission')).toContain('microphone')
    expect(noticeFor('no-speech')).toBe('Nothing was heard.')
    expect(noticeFor('unavailable')).toContain('not available')
    expect(noticeFor('failed')).toContain('unexpectedly')
  })
})
