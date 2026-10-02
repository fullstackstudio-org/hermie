/**
 * The reading queue, against an engine that never makes a sound.
 *
 * The fake below is the whole point of `SpeechEngine` being a seam: every state
 * this machine can be in is reachable from here, including the two orderings a
 * real browser produces and a simulator does not — a completion arriving after a
 * stop, and a failure in the middle of a queue.
 */
import { autoReadCandidates, seenIds } from '../src/features/voice/auto-read'
import { IDLE, SpeechReader } from '../src/features/voice/reader'
import type { SpeechEngine, SpeechUtterance } from '../src/platform/platform-contracts'

function fakeEngine(available = true): SpeechEngine & {
  spoken: string[]
  finish: () => void
  fail: () => void
  stops: number
} {
  let pending: SpeechUtterance | null = null

  return {
    available,
    spoken: [],
    stops: 0,
    speak(utterance) {
      pending = utterance
      this.spoken.push(utterance.text)
    },
    stop() {
      this.stops += 1
      pending = null
    },
    /** The platform reporting that the current utterance finished on its own. */
    finish() {
      const current = pending

      pending = null
      current?.onDone?.()
    },
    fail() {
      const current = pending

      pending = null
      current?.onError?.()
    }
  }
}

const request = (id: string) => ({ id, text: `text ${id}` })

describe('SpeechReader', () => {
  it('starts idle and speaks the first thing it is given', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    expect(reader.state).toEqual(IDLE)

    reader.enqueue(request('a'))

    expect(engine.spoken).toEqual(['text a'])
    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: [] })
  })

  it('queues a reply that arrives while another is being read', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))

    expect(engine.spoken).toEqual(['text a'])
    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: ['b'] })

    engine.finish()

    expect(engine.spoken).toEqual(['text a', 'text b'])
    expect(reader.state).toEqual({ speakingId: 'b', queuedIds: [] })

    engine.finish()

    expect(reader.state).toEqual(IDLE)
  })

  it('refuses the same id twice, because an auto-read effect re-runs', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))
    reader.enqueue(request('b'))
    reader.enqueue(request('a'))

    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: ['b'] })
  })

  it('says nothing for an empty text or an engine that cannot speak', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue({ id: 'a', text: '   ' })

    expect(reader.state).toEqual(IDLE)

    const silent = fakeEngine(false)
    const other = new SpeechReader(silent)

    other.enqueue(request('a'))

    expect(silent.spoken).toEqual([])
    expect(other.state).toEqual(IDLE)
  })

  it('stops everything, and does not treat the cut utterance as finished', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))
    reader.stop()

    expect(reader.state).toEqual(IDLE)
    expect(engine.stops).toBe(1)

    /*
      The ordering a browser produces and a simulator does not: `cancel()` can
      still deliver an `end` for the utterance it just cut. If that advanced the
      queue, a stop would start the NEXT reply instead of silence.
    */
    engine.finish()

    expect(engine.spoken).toEqual(['text a'])
    expect(reader.state).toEqual(IDLE)
  })

  it('moves on when an utterance fails rather than stalling the queue', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))
    engine.fail()

    expect(engine.spoken).toEqual(['text a', 'text b'])
    expect(reader.state).toEqual({ speakingId: 'b', queuedIds: [] })
  })

  it('toggles: the speaking row stops, a queued row is taken out, anything else starts', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.toggle(request('a'))

    expect(reader.state.speakingId).toBe('a')

    reader.toggle(request('b'))

    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: ['b'] })

    // A queued row leaves the queue without silencing what is being spoken.
    reader.toggle(request('b'))

    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: [] })

    reader.toggle(request('a'))

    expect(reader.state).toEqual(IDLE)
  })

  it('reports each change to its owner, so a screen can redraw the menu', () => {
    const engine = fakeEngine()
    const seen: string[] = []
    const reader = new SpeechReader(engine, { onChange: state => seen.push(state.speakingId ?? '-') })

    reader.enqueue(request('a'))
    engine.finish()

    expect(seen).toEqual(['a', '-'])
  })

  it('reads the rate afresh for every utterance', () => {
    const engine = fakeEngine()
    const rates: (number | undefined)[] = []
    let rate = 1

    // Wrapped rather than replaced: the fake's own `speak` is what remembers the
    // pending utterance, and a replacement would make `finish()` a no-op.
    const speak = engine.speak.bind(engine)

    engine.speak = utterance => {
      rates.push(utterance.rate)
      speak(utterance)
    }

    const reader = new SpeechReader(engine, { rate: () => rate })

    reader.enqueue(request('a'))
    rate = 1.5
    reader.enqueue(request('b'))

    // `b` was queued before the change and is spoken after it: the rate the
    // reader has NOW is the one that applies, which is what makes moving the
    // control mid-read feel like it did something.
    expect(rates).toEqual([1])
    engine.finish()
    expect(rates).toEqual([1, 1.5])
  })
})

describe('autoReadCandidates', () => {
  const entry = (id: string, kind: string, text = 'hello') => ({ item: { id, kind, text } })

  it('offers nothing while a turn is running', () => {
    expect(autoReadCandidates([entry('a', 'assistant')], new Set(), true)).toEqual([])
  })

  it('offers replies that have not been offered before, oldest first', () => {
    const entries = [entry('a', 'assistant'), entry('b', 'assistant')]

    expect(autoReadCandidates(entries, new Set(['a']), false)).toEqual([{ id: 'b', text: 'hello' }])
  })

  it('offers only assistant replies', () => {
    const entries = [entry('u', 'user'), entry('d', 'bot_dm_in'), entry('t', 'tool'), entry('a', 'assistant')]

    expect(autoReadCandidates(entries, new Set(), false).map(candidate => candidate.id)).toEqual(['a'])
  })

  it('skips a reply with no words in it', () => {
    expect(autoReadCandidates([entry('a', 'assistant', '  ')], new Set(), false)).toEqual([])
  })

  it('seeds from what is already on screen, which is what stops the back catalogue', () => {
    const entries = [entry('a', 'assistant'), entry('b', 'assistant')]
    const seeded = seenIds(entries)

    expect(autoReadCandidates(entries, seeded, false)).toEqual([])
    expect(autoReadCandidates([...entries, entry('c', 'assistant')], seeded, false)).toEqual([
      { id: 'c', text: 'hello' }
    ])
  })
})
