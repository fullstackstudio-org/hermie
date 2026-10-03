import { describe, expect, it } from 'vitest'

import { createKeyValueStore } from '../platform/key-value-store'
import {
  asSchemeChoice,
  asTint,
  bindTheme,
  createSettingsStore,
  DEFAULT_SCHEME,
  DEFAULT_TINT,
  SCHEME_KEY,
  TINT_KEY,
  TINTS
} from './settings'

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

describe('the settings store', () => {
  it('starts on the system scheme and the default tint', () => {
    const state = createSettingsStore().getState()

    expect([state.scheme, state.tint]).toEqual([DEFAULT_SCHEME, DEFAULT_TINT])
    expect(DEFAULT_SCHEME).toBe('system')
  })

  it('reads the stored choices, and treats anything unknown as the default', () => {
    expect(asSchemeChoice('dark')).toBe('dark')
    expect(asSchemeChoice('sepia')).toBe('system')
    expect(asSchemeChoice(null)).toBe('system')
    expect(asTint('teal')).toBe('teal')
    expect(asTint('plaid')).toBe('blue')
  })

  it('persists a choice under device-local keys of the base-path namespace, so a sign-out keeps it', () => {
    const { data, storage } = memoryStorage()
    const kv = createKeyValueStore({ namespace: '/', storage })
    const store = createSettingsStore()

    store.getState().hydrate(kv)
    store.getState().setScheme('dark')
    store.getState().setTint('green')

    expect(data.get(`hermie:/:${SCHEME_KEY}`)).toBe('dark')
    expect(data.get(`hermie:/:${TINT_KEY}`)).toBe('green')
    expect(kv.clearIdentityBound()).toEqual([])
    expect(data.size).toBe(2)
  })

  it('hydrates what an earlier visit stored', () => {
    const { storage } = memoryStorage()
    const first = createKeyValueStore({ namespace: '/gw', storage })
    const earlier = createSettingsStore()

    earlier.getState().hydrate(first)
    earlier.getState().setScheme('light')
    earlier.getState().setTint('orange')

    const later = createSettingsStore()

    later.getState().hydrate(createKeyValueStore({ namespace: '/gw', storage }))

    expect([later.getState().scheme, later.getState().tint]).toEqual(['light', 'orange'])
  })

  it('keeps two gateways on one host apart', () => {
    const { storage } = memoryStorage()
    const a = createSettingsStore()
    const b = createSettingsStore()

    a.getState().hydrate(createKeyValueStore({ namespace: '/a', storage }))
    a.getState().setScheme('dark')
    b.getState().hydrate(createKeyValueStore({ namespace: '/b', storage }))

    expect(b.getState().scheme).toBe('system')
  })

  it('writes nothing before the store is known, and keeps the choice for the page', () => {
    const store = createSettingsStore()

    store.getState().setScheme('dark')

    expect(store.getState().scheme).toBe('dark')
  })

  it('offers a tint for every name the stylesheet has a block for', () => {
    expect(TINTS).toContain(DEFAULT_TINT)
    expect(new Set(TINTS).size).toBe(TINTS.length)
  })
})

describe('bindTheme', () => {
  it('applies the theme now and on every change, and only on a change', () => {
    const store = createSettingsStore()
    const applied: unknown[] = []
    const stop = bindTheme(store, theme => applied.push(theme))

    store.getState().setScheme('dark')
    store.getState().setScheme('dark')
    store.getState().setTint('teal')
    stop()
    store.getState().setScheme('light')

    expect(applied).toEqual([
      { scheme: 'system', tint: 'blue' },
      { scheme: 'dark', tint: 'blue' },
      { scheme: 'dark', tint: 'teal' }
    ])
  })
})
