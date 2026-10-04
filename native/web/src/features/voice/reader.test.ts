/**
 * The reading queue, against an engine that never makes a sound. The fake is the whole point of `SpeechEngine` being
 * a seam: every state the queue can be in is reachable from here, including the two orderings a real browser produces
 * and a unit test does not: a completion arriving after a stop, and a failure in the middle of a queue.
 */
import { describe, expect, it } from 'vitest'

import { autoReadCandidates, freshMemory, seed, type ReadableEntry } from './auto-read'
import type { SpeechEngine, SpeechUtterance } from '../../platform/speech-engines'
import { IDLE, SpeechReader } from './reader'

interface FakeEngine extends SpeechEngine {
  utterances: SpeechUtterance[]
  stops: number
  /** The utterance in flight ends the way one does: said. */
  finish: () => void
  /** Or could not be. */
  fail: () => void
}

function fakeEngine(available = true): FakeEngine {
  const utterances: SpeechUtterance[] = []

  return {
    available,
    utterances,
    stops: 0,
    speak(utterance) {
      utterances.push(utterance)
    },
    stop() {
      this.stops += 1
    },
    finish: () => utterances[utterances.length - 1]?.onDone?.(),
    fail: () => utterances[utterances.length - 1]?.onError?.()
  }
}

const request = (id: string, language?: string) => ({ id, text: `text ${id}`, ...(language ? { language } : {}) })

describe('SpeechReader', () => {
  it('starts idle and speaks the first thing it is given', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    expect(reader.state).toEqual(IDLE)

    reader.enqueue(request('a', 'nl'))

    expect(engine.utterances.map(utterance => [utterance.text, utterance.language])).toEqual([['text a', 'nl']])
    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: [] })
  })

  it('queues a second reply behind the first instead of talking over it', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))

    expect(engine.utterances).toHaveLength(1)
    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: ['b'] })

    engine.finish()
    expect(reader.state).toEqual({ speakingId: 'b', queuedIds: [] })

    engine.finish()
    expect(reader.state).toEqual(IDLE)
  })

  it('never queues the same reply twice', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('a'))
    reader.enqueue(request('b'))
    reader.enqueue(request('b'))

    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: ['b'] })
  })

  it('says a row is in flight both while it is spoken and while it waits', () => {
    const reader = new SpeechReader(fakeEngine())

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))

    expect([reader.has('a'), reader.has('b'), reader.has('c')]).toEqual([true, true, false])
  })

  it('does nothing for an empty text, or a browser with no engine', () => {
    const reader = new SpeechReader(fakeEngine())

    reader.enqueue({ id: 'a', text: '   ' })
    expect(reader.state).toEqual(IDLE)

    const silent = fakeEngine(false)
    const mute = new SpeechReader(silent)

    mute.enqueue(request('a'))
    expect(mute.state).toEqual(IDLE)
    expect(silent.utterances).toEqual([])
  })

  it('takes a waiting reply back out, and stops everything when the one spoken is taken out', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.toggle(request('a'))
    reader.toggle(request('b'))
    reader.toggle(request('b'))
    expect(reader.state).toEqual({ speakingId: 'a', queuedIds: [] })

    reader.toggle(request('c'))
    reader.toggle(request('a'))
    expect(reader.state).toEqual(IDLE)
    expect(engine.stops).toBe(1)
  })

  it('does not take a stop for a completion: the utterance it cut must not start the next one', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))

    const cut = engine.utterances[0]

    reader.stop()
    expect(reader.state).toEqual(IDLE)

    // A browser may report the cut utterance's end late, whichever order it likes.
    cut?.onDone?.()
    expect(reader.state).toEqual(IDLE)

    reader.enqueue(request('c'))
    cut?.onDone?.()
    expect(reader.state).toEqual({ speakingId: 'c', queuedIds: [] })
    expect(engine.utterances).toHaveLength(2)
  })

  it('goes on to the next reply when one could not be read, instead of stalling on it', () => {
    const engine = fakeEngine()
    const reader = new SpeechReader(engine)

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))
    engine.fail()

    expect(reader.state).toEqual({ speakingId: 'b', queuedIds: [] })
  })

  it('reads the rate when an utterance starts, so a change applies to the next one', () => {
    const engine = fakeEngine()
    let rate = 1
    const reader = new SpeechReader(engine, { rate: () => rate })

    reader.enqueue(request('a'))
    rate = 1.5
    reader.enqueue(request('b'))
    engine.finish()

    expect(engine.utterances.map(utterance => utterance.rate)).toEqual([1, 1.5])
  })

  it('tells whoever listens about every change', () => {
    const states: string[] = []
    const engine = fakeEngine()
    const reader = new SpeechReader(engine, {
      onChange: state => states.push(`${state.speakingId ?? '-'}|${state.queuedIds.join(',')}`)
    })

    reader.enqueue(request('a'))
    reader.enqueue(request('b'))
    reader.stop()

    expect(states).toEqual(['a|', 'a|b', '-|'])
  })
})

describe('the automatic read', () => {
  const reply = (id: string, text = 'words', over: Partial<ReadableEntry['item']> = {}): ReadableEntry => ({
    item: { id, kind: 'assistant', text, ...over }
  })

  it('offers what arrived since the seed, oldest first, and only once', () => {
    const memory = freshMemory()

    seed([reply('a1'), reply('a2')], memory)

    const arrived = [reply('a1'), reply('a2'), reply('a3'), reply('a4')]

    expect(autoReadCandidates(arrived, memory, false).map(candidate => candidate.id)).toEqual(['a3', 'a4'])

    memory.offered.add('a3')
    memory.offered.add('a4')
    memory.frontier = 'a4'

    expect(autoReadCandidates(arrived, memory, false)).toEqual([])
  })

  it('offers nothing while a turn runs: a reply being written will be different in a moment', () => {
    const memory = freshMemory()

    seed([], memory)

    expect(autoReadCandidates([reply('a1')], memory, true)).toEqual([])
    expect(autoReadCandidates([reply('a1')], memory, false)).toHaveLength(1)
  })

  it('does not offer older history paged in above the newest reply seen', () => {
    const memory = freshMemory()

    seed([reply('a5'), reply('a6')], memory)

    expect(autoReadCandidates([reply('a1'), reply('a2'), reply('a5'), reply('a6')], memory, false)).toEqual([])
  })

  it('reads only the bot’s finished words: not the reader’s turns, notes, failures or bot-to-bot traffic', () => {
    const memory = freshMemory()

    seed([], memory)

    const entries = [
      { item: { id: 'u1', kind: 'user', text: 'mine' } },
      reply('a1', 'a note', { interim: true }),
      reply('a2', 'it broke', { error: { message: 'no' } }),
      { item: { id: 'b1', kind: 'bot_dm_in', text: 'from another bot' } },
      reply('a3', '   '),
      reply('a4', 'finished')
    ]

    expect(autoReadCandidates(entries, memory, false).map(candidate => candidate.id)).toEqual(['a4'])
  })

  it('treats a frontier that is no longer in the transcript (a new conversation) as no limit', () => {
    const memory = freshMemory()

    seed([reply('a1'), reply('a2')], memory)

    expect(autoReadCandidates([reply('b1')], memory, false).map(candidate => candidate.id)).toEqual(['b1'])
  })
})
