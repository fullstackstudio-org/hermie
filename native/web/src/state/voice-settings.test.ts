import { describe, expect, it } from 'vitest'

import { createKeyValueStore } from '../platform/key-value-store'
import {
  asLanguage,
  asRate,
  autoReadFor,
  createVoiceSettingsStore,
  DEFAULT_RATE,
  DICTATION_AUTO,
  ensureVoiceSettings,
  VOICE_KEY
} from './voice-settings'

const memoryStorage = () => {
  const data = new Map<string, string>()

  return {
    data,
    storage: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
      key: (index: number) => [...data.keys()][index] ?? null,
      get length() {
        return data.size
      }
    }
  }
}

describe('the voice settings', () => {
  it('start on the defaults', () => {
    const state = createVoiceSettingsStore().getState()

    expect(state).toMatchObject({
      rate: DEFAULT_RATE,
      dictationLanguage: DICTATION_AUTO,
      stopOnBackground: true,
      confirmBeforeSending: true,
      autoReadByChat: {},
      loaded: false
    })
  })

  it('clamp a stored rate instead of throwing it away, and take only what is a language', () => {
    expect(asRate(3)).toBe(1.5)
    expect(asRate(0.1)).toBe(0.5)
    expect(asRate(1.25)).toBe(1.25)
    expect(asRate('fast')).toBeUndefined()
    expect(asRate(Number.NaN)).toBeUndefined()

    expect(asLanguage('auto')).toBe('auto')
    expect(asLanguage('nl')).toBe('nl')
    expect(asLanguage('nl-NL')).toBe('nl-NL')
    expect(asLanguage('not a tag!')).toBeUndefined()
    expect(asLanguage(7)).toBeUndefined()
  })

  it('persist every choice under one device-local key, so a sign-out keeps them', () => {
    const { data, storage } = memoryStorage()
    const kv = createKeyValueStore({ namespace: '/', storage })
    const store = createVoiceSettingsStore()

    store.getState().hydrate(kv)
    store.getState().setRate(1.5)
    store.getState().setDictationLanguage('de')
    store.getState().setStopOnBackground(false)
    store.getState().setAutoRead('writer', true)

    expect(VOICE_KEY.startsWith('device.')).toBe(true)
    expect(JSON.parse(data.get(`hermie:/:${VOICE_KEY}`) ?? '{}')).toMatchObject({
      rate: 1.5,
      dictationLanguage: 'de',
      stopOnBackground: false,
      autoReadByChat: { writer: true }
    })

    const again = createVoiceSettingsStore()

    again.getState().hydrate(kv)
    expect(again.getState()).toMatchObject({ rate: 1.5, dictationLanguage: 'de', stopOnBackground: false })
    expect(autoReadFor(again.getState(), 'writer')).toBe(true)
    expect(autoReadFor(again.getState(), 'researcher')).toBe(false)
  })

  it('keep only the chats that read aloud: off is the default and is not stored', () => {
    const { data, storage } = memoryStorage()
    const store = createVoiceSettingsStore()

    store.getState().hydrate(createKeyValueStore({ namespace: '/', storage }))
    store.getState().setAutoRead('writer', true)
    store.getState().setAutoRead('researcher', true)
    store.getState().setAutoRead('writer', false)

    expect(JSON.parse(data.get(`hermie:/:${VOICE_KEY}`) ?? '{}').autoReadByChat).toEqual({ researcher: true })
  })

  it('leave a blob they cannot read alone and use the defaults for the page', () => {
    const { data, storage } = memoryStorage()

    data.set(`hermie:/:${VOICE_KEY}`, '{not json')

    const store = createVoiceSettingsStore()

    store.getState().hydrate(createKeyValueStore({ namespace: '/', storage }))

    expect(store.getState().rate).toBe(DEFAULT_RATE)
    expect(data.get(`hermie:/:${VOICE_KEY}`)).toBe('{not json')
  })

  it('read a field at a time: one bad value does not take the others with it', () => {
    const { data, storage } = memoryStorage()

    data.set(
      `hermie:/:${VOICE_KEY}`,
      JSON.stringify({
        rate: 'quick',
        dictationLanguage: 'nl',
        stopOnBackground: false,
        autoReadByChat: { a: true, b: false }
      })
    )

    const store = createVoiceSettingsStore()

    store.getState().hydrate(createKeyValueStore({ namespace: '/', storage }))

    expect(store.getState()).toMatchObject({
      rate: DEFAULT_RATE,
      dictationLanguage: 'nl',
      stopOnBackground: false,
      autoReadByChat: { a: true }
    })
  })

  it('hold a choice for as long as the page is open when there is no store to write to', () => {
    const store = createVoiceSettingsStore()

    store.getState().setRate(0.75)

    expect(store.getState().rate).toBe(0.75)
  })

  it('are read once, from the store the page already opened', () => {
    const { data, storage } = memoryStorage()
    const kv = createKeyValueStore({ namespace: '/', storage })
    const store = createVoiceSettingsStore()

    data.set(`hermie:/:${VOICE_KEY}`, JSON.stringify({ rate: 0.5 }))
    ensureVoiceSettings(store, kv)
    expect(store.getState().rate).toBe(0.5)

    // Not read again over what was chosen since.
    store.getState().setRate(1.25)
    ensureVoiceSettings(store, kv)
    expect(store.getState().rate).toBe(1.25)

    // And nothing to read from is not an error.
    ensureVoiceSettings(createVoiceSettingsStore(), null)
  })
})
