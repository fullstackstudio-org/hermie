/**
 * Dictation: where the words go, and what each refusal says. The engine below never opens a microphone, which is the
 * point of `RecognitionEngine` being a seam: every state the machine can reach is reachable from a test, including
 * the two a browser will not produce on demand: a result arriving for a session that has already been replaced, and
 * a session that ends having heard nothing.
 */
import { describe, expect, it } from 'vitest'

import { anchorAt, DICTATION_IDLE, DictationMachine, withTranscript, type DictationAnchor } from './dictation'
import { noticeFor } from './dictation-notice'
import type { RecognitionEngine, RecognitionFailure, RecognitionRequest } from '../../platform/speech-engines'

interface FakeEngine extends RecognitionEngine {
  starts: number
  stops: number
  aborts: number
  last: RecognitionRequest | null
  partial: (text: string) => void
  final: (text: string) => void
  fail: (failure: RecognitionFailure) => void
  end: () => void
}

function fakeEngine(available = true): FakeEngine {
  let request: RecognitionRequest | null = null

  return {
    available,
    starts: 0,
    stops: 0,
    aborts: 0,
    last: null,
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
    /** The browser reporting something on the session that is running. */
    partial: text => request?.onPartial?.(text),
    final: text => request?.onFinal?.(text),
    fail: failure => request?.onError?.(failure),
    end: () => request?.onEnd?.()
  }
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
    expect(withTranscript(anchor('Ask him about it', 4, 7), 'her')).toEqual({ value: 'Ask her about it', caret: 7 })
  })

  it('recomputes from the anchor, so a revised partial replaces the last one', () => {
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
    expect(anchorAt('ab', { start: 90, end: 99 })).toEqual({ base: 'ab', start: 2, end: 2 })
  })
})

describe('the dictation machine', () => {
  it('starts idle and listens at once: the browser asks for the microphone itself', () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    expect(machine.state).toEqual(DICTATION_IDLE)

    machine.start({ language: 'nl' })

    expect(machine.state.phase).toBe('listening')
    expect(engine.last?.language).toBe('nl')
  })

  it('reports every result, marking which one is final', () => {
    const engine = fakeEngine()
    const seen: [string, boolean][] = []
    const machine = new DictationMachine(engine, { onTranscript: (text, final) => seen.push([text, final]) })

    machine.start()
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

  it('ends back at idle once the session finished having heard something', () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    machine.start()
    engine.final('done')
    engine.end()

    expect(machine.state.phase).toBe('idle')
  })

  it('says so when a session ends having heard nothing, and leaves it to the caller to leave the draft alone', () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    machine.start()
    machine.stop()
    expect(engine.stops).toBe(1)
    engine.end()

    expect(machine.state).toEqual({ phase: 'error', partial: '', failure: 'no-speech' })
  })

  it('keeps the failure the recogniser reported, and a late end does not turn it into something else', () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    machine.start()
    engine.fail('permission')
    engine.end()

    expect(machine.state.failure).toBe('permission')

    machine.clearError()
    expect(machine.state).toEqual(DICTATION_IDLE)
  })

  it('says unavailable, and does not start, where the browser has no recogniser', () => {
    const engine = fakeEngine(false)
    const machine = new DictationMachine(engine)

    machine.start()

    expect(machine.available).toBe(false)
    expect(machine.state.failure).toBe('unavailable')
    expect(engine.starts).toBe(0)
  })

  it('ignores what a replaced session says: its words belong to nobody now', () => {
    const engine = fakeEngine()
    const seen: string[] = []
    const machine = new DictationMachine(engine, { onTranscript: text => seen.push(text) })

    machine.start()

    const old = engine.last

    machine.cancel()
    machine.start()
    old?.onPartial?.('from the old session')
    old?.onEnd?.()

    expect(seen).toEqual([])
    expect(machine.state.phase).toBe('listening')
    expect(engine.aborts).toBe(1)
  })

  it('does not take a result after it was cancelled', () => {
    const engine = fakeEngine()
    const seen: string[] = []
    const machine = new DictationMachine(engine, { onTranscript: text => seen.push(text) })

    machine.start()
    machine.cancel()
    engine.final('too late')

    expect(seen).toEqual([])
    expect(machine.state).toEqual(DICTATION_IDLE)
  })

  it('does not start a second session over the first', () => {
    const engine = fakeEngine()
    const machine = new DictationMachine(engine)

    machine.start()
    machine.start()

    expect(engine.starts).toBe(1)
  })
})

describe('what a failure says', () => {
  it('has one line for each failure, and none for no failure', () => {
    expect(noticeFor('permission')).toBe('Hermie needs the microphone to take dictation.')
    expect(noticeFor('no-speech')).toBe('Nothing was heard.')
    expect(noticeFor('unavailable')).toBe('Dictation is not available on this device.')
    expect(noticeFor('failed')).toBe('Dictation stopped unexpectedly.')
    expect(noticeFor(null)).toBeNull()
  })
})
