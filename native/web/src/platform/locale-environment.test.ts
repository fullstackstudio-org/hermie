import { afterEach, describe, expect, it } from 'vitest'

import { configureLocale, initLocale, languageChoice, resetLocale, setLanguageChoice } from '../i18n/locale'
import { createKeyValueStore, type StorageLike } from './key-value-store'
import { LEGACY_LANGUAGE_KEY, localeEnvironmentFor } from './locale-environment'

/** A `Storage` over a map, with a switch for a browser that refuses. */
function memoryStorage(): StorageLike & { map: Map<string, string>; locked: boolean } {
  const map = new Map<string, string>()
  const storage = {
    map,
    locked: false,
    get length() {
      return map.size
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem(key: string) {
      if (storage.locked) {
        throw new DOMException('Access is denied.', 'SecurityError')
      }

      return map.get(key) ?? null
    },
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem(key: string) {
      if (storage.locked) {
        throw new DOMException('Access is denied.', 'SecurityError')
      }

      map.delete(key)
    }
  }

  return storage
}

afterEach(() => {
  resetLocale()
})

function setup(languages: string[] = ['en']) {
  const page = memoryStorage()
  const legacy = memoryStorage()
  const store = createKeyValueStore({ namespace: '/hermes', storage: page })
  const environment = localeEnvironmentFor(store, { legacy, languages: () => languages })

  return { page, legacy, store, environment }
}

describe('where the language is kept', () => {
  it('writes the choice to the store under device.language, in the base path namespace', async () => {
    const { page, store, environment } = setup()

    configureLocale(environment)
    await setLanguageChoice('nl')

    expect(store.getSync('device.language')).toBe('nl')
    expect([...page.map.keys()]).toEqual(['hermie:/hermes:device.language'])
  })

  it('reads it back on the next start, through the same seam', async () => {
    const { store, environment } = setup(['en'])

    store.setSync('device.language', 'de')
    configureLocale(environment)

    expect(await initLocale()).toBe('de')
    expect(languageChoice()).toBe('de')
  })

  it('survives a sign-out, like the other device settings', async () => {
    const { store, environment } = setup()

    configureLocale(environment)
    await setLanguageChoice('nl')
    store.setSync('draft.researcher', 'unsent')

    expect(store.clearIdentityBound()).toEqual(['draft.researcher'])
    expect(store.getSync('device.language')).toBe('nl')
  })

  it('takes the browser list from the environment it was given', async () => {
    const { environment } = setup(['nl-BE'])

    configureLocale(environment)

    expect(await initLocale()).toBe('nl')
    expect(languageChoice()).toBe('system')
  })
})

describe('the choice an earlier build stored', () => {
  it('is taken over once: written under the new key, removed from the old one', async () => {
    const { page, legacy, store, environment } = setup(['en'])

    legacy.map.set(LEGACY_LANGUAGE_KEY, 'nl')
    configureLocale(environment)

    expect(await initLocale()).toBe('nl')
    expect(store.getSync('device.language')).toBe('nl')
    expect([...page.map.keys()]).toEqual(['hermie:/hermes:device.language'])
    expect(legacy.map.has(LEGACY_LANGUAGE_KEY)).toBe(false)
  })

  it('takes "follow the browser" over too, and never overrides a choice made since', () => {
    const first = setup()

    first.legacy.map.set(LEGACY_LANGUAGE_KEY, 'system')
    expect(first.environment.readChoice()).toBe('system')

    const second = setup()

    second.store.setSync('device.language', 'de')
    second.legacy.map.set(LEGACY_LANGUAGE_KEY, 'nl')

    expect(second.environment.readChoice()).toBe('de')
    // Not read, so not removed either; the next start that has no new key still finds it.
    expect(second.legacy.map.get(LEGACY_LANGUAGE_KEY)).toBe('nl')
  })

  it('drops a value that is not a language choice instead of keeping it for ever', () => {
    const { legacy, store, environment } = setup()

    legacy.map.set(LEGACY_LANGUAGE_KEY, 'klingon')

    expect(environment.readChoice()).toBeUndefined()
    expect(store.getSync('device.language')).toBeNull()
    expect(legacy.map.has(LEGACY_LANGUAGE_KEY)).toBe(false)
  })

  it('reads nothing from a browser that refuses the old store, and still works', async () => {
    const { legacy, store, environment } = setup(['nl'])

    legacy.locked = true
    configureLocale(environment)

    expect(await initLocale()).toBe('nl')
    await expect(setLanguageChoice('de')).resolves.toBe('de')
    expect(store.getSync('device.language')).toBe('de')
  })

  it('has nothing to migrate where there was nothing stored', () => {
    const { page, environment } = setup()

    expect(environment.readChoice()).toBeUndefined()
    expect(page.map.size).toBe(0)
  })
})
