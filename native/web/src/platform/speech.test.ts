/**
 * The two browser engines, against a window that has what a browser has: a `SpeechRecognition` that reports the way
 * Chrome's does, and a `speechSynthesis` whose `cancel()` is as unreliable about `onend` as the real one. Neither
 * makes a sound or opens a microphone.
 */
import { describe, expect, it, vi } from 'vitest'

import { canDictate, canSpeak, hasVoice } from './voice-capabilities'
import { createWebRecognition, failureFor } from './speech-recognition'
import { createWebSynthesis } from './speech-synthesis'

interface FakeResult {
  isFinal: boolean
  0: { transcript: string }
  length: 1
}

const result = (transcript: string, isFinal = false): FakeResult => ({ isFinal, 0: { transcript }, length: 1 })

/** A recogniser constructor whose instances are kept, so a test can say what they hear. */
function recognitionClass() {
  const instances: FakeRecognition[] = []

  class FakeRecognition {
    lang = ''
    continuous = true
    interimResults = false
    started = false
    stopped = false
    aborted = false
    onresult: ((event: { resultIndex: number; results: ArrayLike<FakeResult> }) => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    onend: (() => void) | null = null

    constructor() {
      instances.push(this)
    }

    start(): void {
      this.started = true
    }

    stop(): void {
      this.stopped = true
    }

    abort(): void {
      this.aborted = true
    }

    hear(...results: FakeResult[]): void {
      this.onresult?.({ resultIndex: 0, results })
    }
  }

  return { FakeRecognition, instances }
}

describe('what the browser can do', () => {
  it('speaks where there is a synthesiser and an utterance to give it', () => {
    expect(canSpeak({ speechSynthesis: {}, SpeechSynthesisUtterance: class {} })).toBe(true)
    expect(canSpeak({ speechSynthesis: {} })).toBe(false)
    expect(canSpeak({ SpeechSynthesisUtterance: class {} })).toBe(false)
    expect(canSpeak({})).toBe(false)
    expect(canSpeak(null)).toBe(false)
  })

  it('dictates where there is a recogniser, under either of its names', () => {
    expect(canDictate({ SpeechRecognition: class {} })).toBe(true)
    expect(canDictate({ webkitSpeechRecognition: class {} })).toBe(true)
    expect(canDictate({})).toBe(false)
    expect(canDictate({ webkitSpeechRecognition: 'not a constructor' })).toBe(false)
  })

  it('has voice when it has either half, and none when it has neither (Firefox has the one)', () => {
    expect(hasVoice({})).toBe(false)
    expect(hasVoice({ speechSynthesis: {}, SpeechSynthesisUtterance: class {} })).toBe(true)
    expect(hasVoice({ webkitSpeechRecognition: class {} })).toBe(true)
  })

  it('treats a window that throws on the property as one that has none', () => {
    const hostile = {
      get speechSynthesis(): never {
        throw new Error('blocked by policy')
      }
    }

    expect(canSpeak(hostile)).toBe(false)
  })
})

describe('the recogniser', () => {
  it('is available where the prefixed constructor is, and not where there is none', () => {
    const { FakeRecognition } = recognitionClass()

    expect(createWebRecognition({ webkitSpeechRecognition: FakeRecognition }).available).toBe(true)
    expect(createWebRecognition({}).available).toBe(false)
  })

  it('starts a session with the language asked for, wanting interim results, and reports what it hears', () => {
    const { FakeRecognition, instances } = recognitionClass()
    const engine = createWebRecognition({ SpeechRecognition: FakeRecognition })
    const partial = vi.fn()
    const final = vi.fn()

    engine.start({ language: 'nl', onPartial: partial, onFinal: final })

    const session = instances[0]

    expect(session).toMatchObject({ lang: 'nl', continuous: false, interimResults: true, started: true })

    session?.hear(result('hallo'))
    session?.hear(result('hallo daar', true))

    expect(partial).toHaveBeenCalledExactlyOnceWith('hallo')
    expect(final).toHaveBeenCalledExactlyOnceWith('hallo daar')
  })

  it('says the whole of what has been heard, when the browser returns the utterance in pieces', () => {
    const { FakeRecognition, instances } = recognitionClass()
    const engine = createWebRecognition({ webkitSpeechRecognition: FakeRecognition })
    const partial = vi.fn()

    engine.start({ onPartial: partial })
    instances[0]?.hear(result('first part ', true), result('and the second'))

    expect(partial).toHaveBeenCalledExactlyOnceWith('first part and the second')
  })

  it('reports an error once, then the end, and leaves an abort alone', () => {
    const { FakeRecognition, instances } = recognitionClass()
    const engine = createWebRecognition({ webkitSpeechRecognition: FakeRecognition })
    const error = vi.fn()
    const end = vi.fn()

    engine.start({ onError: error, onEnd: end })
    instances[0]?.onerror?.({ error: 'not-allowed' })
    instances[0]?.onend?.()

    expect(error).toHaveBeenCalledExactlyOnceWith('permission')
    expect(end).toHaveBeenCalledTimes(1)

    engine.start({ onError: error, onEnd: end })
    instances[1]?.onerror?.({ error: 'aborted' })
    expect(error).toHaveBeenCalledTimes(1)
  })

  it('does not report for a session that was aborted or replaced', () => {
    const { FakeRecognition, instances } = recognitionClass()
    const engine = createWebRecognition({ webkitSpeechRecognition: FakeRecognition })
    const first = { onPartial: vi.fn(), onEnd: vi.fn() }
    const second = { onPartial: vi.fn(), onEnd: vi.fn() }

    engine.start(first)
    engine.start(second)

    expect(instances[0]?.aborted).toBe(true)

    instances[0]?.hear(result('stale'))
    instances[0]?.onend?.()
    expect(first.onPartial).not.toHaveBeenCalled()
    expect(first.onEnd).not.toHaveBeenCalled()

    engine.abort()
    instances[1]?.onend?.()
    expect(second.onEnd).not.toHaveBeenCalled()
  })

  it('stops the session it owns', () => {
    const { FakeRecognition, instances } = recognitionClass()
    const engine = createWebRecognition({ webkitSpeechRecognition: FakeRecognition })

    engine.start({})
    engine.stop()

    expect(instances[0]?.stopped).toBe(true)
  })

  it('says unavailable, and ends, where there is nothing to start', () => {
    const error = vi.fn()
    const end = vi.fn()

    createWebRecognition({}).start({ onError: error, onEnd: end })

    expect(error).toHaveBeenCalledExactlyOnceWith('unavailable')
    expect(end).toHaveBeenCalledTimes(1)
  })

  it('reduces the browser’s error codes to the four a caller acts on', () => {
    expect(failureFor('not-allowed')).toBe('permission')
    expect(failureFor('service-not-allowed')).toBe('permission')
    expect(failureFor('no-speech')).toBe('no-speech')
    expect(failureFor('audio-capture')).toBe('unavailable')
    expect(failureFor('language-not-supported')).toBe('unavailable')
    expect(failureFor('network')).toBe('failed')
  })
})

describe('the synthesiser', () => {
  /** `speechSynthesis` and the utterance it takes, with the bug that matters: `cancel()` may not say the end. */
  function synthesis() {
    const spoken: FakeUtterance[] = []
    let cancels = 0

    class FakeUtterance {
      lang = ''
      rate = 1
      onend: (() => void) | null = null
      onerror: (() => void) | null = null

      constructor(readonly text: string) {}
    }

    const speechSynthesis = {
      speak: (utterance: FakeUtterance) => void spoken.push(utterance),
      cancel: () => void (cancels += 1)
    }

    return {
      win: { speechSynthesis, SpeechSynthesisUtterance: FakeUtterance } as never,
      spoken,
      cancels: () => cancels
    }
  }

  it('is available only where there is both a synthesiser and an utterance to give it', () => {
    expect(createWebSynthesis(synthesis().win).available).toBe(true)
    expect(createWebSynthesis({}).available).toBe(false)
  })

  it('speaks with the language and the rate, cutting what was said before', () => {
    const { cancels, spoken, win } = synthesis()
    const engine = createWebSynthesis(win)

    engine.speak({ text: 'hallo', language: 'nl', rate: 1.25 })

    expect(cancels()).toBe(1)
    expect(spoken[0]).toMatchObject({ text: 'hallo', lang: 'nl', rate: 1.25 })
  })

  it('says done once, for the utterance that is current', () => {
    const { spoken, win } = synthesis()
    const engine = createWebSynthesis(win)
    const done = vi.fn()

    engine.speak({ text: 'one', onDone: done })
    spoken[0]?.onend?.()
    spoken[0]?.onend?.()

    expect(done).toHaveBeenCalledTimes(1)
  })

  it('does not take the end of a cut utterance for a completion', () => {
    const { spoken, win } = synthesis()
    const engine = createWebSynthesis(win)
    const done = vi.fn()

    engine.speak({ text: 'one', onDone: done })
    engine.stop()
    spoken[0]?.onend?.()

    expect(done).not.toHaveBeenCalled()

    // And one that was replaced is not the current one either.
    const second = vi.fn()

    engine.speak({ text: 'two', onDone: done })
    engine.speak({ text: 'three', onDone: second })
    spoken[1]?.onend?.()
    expect(done).not.toHaveBeenCalled()
    spoken[2]?.onend?.()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('says it could not, for an empty text or a failure', () => {
    const { spoken, win } = synthesis()
    const engine = createWebSynthesis(win)
    const failed = vi.fn()

    engine.speak({ text: '', onError: failed })
    expect(failed).toHaveBeenCalledTimes(1)

    engine.speak({ text: 'x', onError: failed })
    spoken[0]?.onerror?.()
    expect(failed).toHaveBeenCalledTimes(2)
  })
})
