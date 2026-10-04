/**
 * The reading runtime for one chat screen: the words flattened for the ear and handed to the queue at the reader's
 * rate, the automatic read's seeding, and what stops it. A fake engine that never makes a sound.
 */
import { describe, expect, it } from 'vitest'

import { createVoiceSettingsStore } from '../../state/voice-settings'
import type { ReadableEntry } from './auto-read'
import type { SpeechEngine, SpeechUtterance } from '../../platform/speech-engines'
import { createReadAloud } from './read-aloud'

interface FakeEngine extends SpeechEngine {
  utterances: SpeechUtterance[]
  stops: number
}

function fakeEngine(available = true): FakeEngine {
  const utterances: SpeechUtterance[] = []

  return {
    available,
    utterances,
    stops: 0,
    speak: utterance => void utterances.push(utterance),
    stop() {
      this.stops += 1
    }
  }
}

const reply = (id: string, text = 'words'): ReadableEntry => ({ item: { id, kind: 'assistant', text } })

function make(options: { blocked?: () => boolean; available?: boolean } = {}) {
  const engine = fakeEngine(options.available)
  const settings = createVoiceSettingsStore()
  const runtime = createReadAloud({
    engine,
    settings,
    doc: document,
    ...(options.blocked ? { blocked: options.blocked } : {})
  })

  return { engine, settings, runtime }
}

describe('reading aloud', () => {
  it('speaks a reply flattened for the ear, in the language it guessed, at the reader’s rate', () => {
    const { engine, runtime, settings } = make()

    settings.getState().setRate(1.25)
    runtime.toggle('a1', '**Het** is niet duidelijk dat de gateway een antwoord voor ons heeft.')

    expect(engine.utterances).toHaveLength(1)
    expect(engine.utterances[0]).toMatchObject({
      text: 'Het is niet duidelijk dat de gateway een antwoord voor ons heeft.',
      language: 'nl',
      rate: 1.25
    })
    expect(runtime.readingIds()).toEqual(['a1'])
  })

  it('is one gesture: asking again for the reply being read stops it', () => {
    const { engine, runtime } = make()

    runtime.toggle('a1', 'first')
    runtime.toggle('a1', 'first')

    expect(runtime.readingIds()).toEqual([])
    expect(engine.stops).toBe(1)
  })

  it('keeps the same array of ids until something changed, so a menu is not redrawn for nothing', () => {
    const { runtime } = make()
    const idle = runtime.readingIds()

    expect(runtime.readingIds()).toBe(idle)

    runtime.toggle('a1', 'first')
    const reading = runtime.readingIds()

    expect(reading).not.toBe(idle)
    expect(runtime.readingIds()).toBe(reading)
  })

  it('tells whoever listens when what is being read changes', () => {
    const { runtime } = make()
    let calls = 0

    const off = runtime.subscribe(() => (calls += 1))

    runtime.toggle('a1', 'first')
    const after = calls

    off()
    runtime.toggle('a2', 'second')

    expect(after).toBeGreaterThan(0)
    expect(calls).toBe(after)
  })

  it('says it is not available where the browser cannot speak, and reads nothing', () => {
    const { engine, runtime } = make({ available: false })

    runtime.toggle('a1', 'first')

    expect(runtime.available).toBe(false)
    expect(engine.utterances).toEqual([])
  })

  it('reads nothing while the microphone has the audio', () => {
    const { engine, runtime } = make({ blocked: () => true })

    runtime.toggle('a1', 'first')

    expect(engine.utterances).toEqual([])
  })
})

describe('the automatic read', () => {
  it('seeds with what is on screen, then reads what arrives, once', () => {
    const { engine, runtime, settings } = make()

    settings.getState().setAutoRead('writer', true)
    runtime.autoRead([reply('a1'), reply('a2')], { bot: 'writer', turnRunning: false })
    expect(engine.utterances).toEqual([])

    const arrived = [reply('a1'), reply('a2'), reply('a3', 'news')]

    runtime.autoRead(arrived, { bot: 'writer', turnRunning: false })
    runtime.autoRead(arrived, { bot: 'writer', turnRunning: false })

    expect(engine.utterances.map(utterance => utterance.text)).toEqual(['news.'])
  })

  it('does nothing for a chat that does not read aloud, and forgets where it was when it is switched off', () => {
    const { engine, runtime, settings } = make()

    runtime.autoRead([reply('a1')], { bot: 'writer', turnRunning: false })
    expect(engine.utterances).toEqual([])

    settings.getState().setAutoRead('writer', true)
    runtime.autoRead([reply('a1')], { bot: 'writer', turnRunning: false })
    settings.getState().setAutoRead('writer', false)
    runtime.autoRead([reply('a1'), reply('a2')], { bot: 'writer', turnRunning: false })

    // Back on: what arrived while it was off is not read.
    settings.getState().setAutoRead('writer', true)
    runtime.autoRead([reply('a1'), reply('a2')], { bot: 'writer', turnRunning: false })
    expect(engine.utterances).toEqual([])
  })

  it('offers nothing while a turn runs', () => {
    const { engine, runtime, settings } = make()

    settings.getState().setAutoRead('writer', true)
    runtime.autoRead([], { bot: 'writer', turnRunning: false })
    runtime.autoRead([reply('a1')], { bot: 'writer', turnRunning: true })
    expect(engine.utterances).toEqual([])

    runtime.autoRead([reply('a1')], { bot: 'writer', turnRunning: false })
    expect(engine.utterances).toHaveLength(1)
  })

  it('marks what arrives while the microphone is open as offered, so its end does not read it all', () => {
    let blocked = true
    const { engine, runtime, settings } = make({ blocked: () => blocked })

    settings.getState().setAutoRead('writer', true)
    runtime.autoRead([], { bot: 'writer', turnRunning: false })
    runtime.autoRead([reply('a1')], { bot: 'writer', turnRunning: false })

    blocked = false
    runtime.autoRead([reply('a1')], { bot: 'writer', turnRunning: false })

    expect(engine.utterances).toEqual([])
  })
})

describe('what stops it', () => {
  const hide = (state: 'hidden' | 'visible'): void => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
    document.dispatchEvent(new Event('visibilitychange'))
  }

  it('is the tab going to the background, when the reader asked for that', () => {
    const { runtime, settings } = make()

    runtime.toggle('a1', 'first')
    hide('hidden')
    expect(runtime.readingIds()).toEqual([])

    settings.getState().setStopOnBackground(false)
    runtime.toggle('a2', 'second')
    hide('hidden')
    expect(runtime.readingIds()).toEqual(['a2'])

    hide('visible')
    runtime.dispose()
  })

  it('is leaving the chat: the speaker goes quiet and the page is let go of', () => {
    const { engine, runtime } = make()

    runtime.toggle('a1', 'first')
    runtime.dispose()

    expect(engine.stops).toBe(1)

    // A tab that goes to the background afterwards is not this reader's business any more.
    hide('hidden')
    expect(engine.stops).toBe(1)
    hide('visible')
  })
})
