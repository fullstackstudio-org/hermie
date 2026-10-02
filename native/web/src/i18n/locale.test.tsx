import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { strings } from '../generated/strings'
import {
  activeLocale,
  asLanguageChoice,
  asLocale,
  configureLocale,
  initLocale,
  languageChoice,
  localeForBrowser,
  resetLocale,
  resolveLanguage,
  setLanguageChoice,
  subscribeLocale,
  type LanguageChoice,
  type LocaleEnvironment
} from './locale'
import { useLocale } from './use-locale'

afterEach(() => {
  resetLocale()
  document.documentElement.removeAttribute('lang')
})

/** An environment with a store held in memory and a fixed browser list. */
function environment(stored: string | null, languages: string[]): LocaleEnvironment & { written: LanguageChoice[] } {
  const written: LanguageChoice[] = []

  return {
    written,
    readChoice: () => stored,
    writeChoice: choice => {
      stored = choice
      written.push(choice)
    },
    languages: () => languages
  }
}

describe('folding a tag', () => {
  it('drops the region, so nl-BE, nl_NL and bare nl are Dutch', () => {
    for (const tag of ['nl', 'nl-BE', 'nl_NL', 'NL-nl', ' nl-NL ']) {
      expect(asLocale(tag), tag).toBe('nl')
    }

    expect(asLocale('de-AT')).toBe('de')
    expect(asLocale('de-Latn-CH')).toBe('de')
    expect(asLocale('en-GB')).toBe('en')
  })

  it('does not take a prefix for a language', () => {
    for (const tag of ['nld', 'deu', 'fr', 'fr-DE', '', 'zh-Hans', 'e', undefined, 42]) {
      expect(asLocale(tag), String(tag)).toBeUndefined()
    }
  })

  it('reads a stored choice defensively', () => {
    expect(asLanguageChoice('system')).toBe('system')
    expect(asLanguageChoice('de')).toBe('de')
    expect(asLanguageChoice('nl-NL')).toBeUndefined()
    expect(asLanguageChoice('French')).toBeUndefined()
    expect(asLanguageChoice(null)).toBeUndefined()
  })
})

describe('the browser list', () => {
  it('takes the first entry that is one of ours, in the order the browser gives', () => {
    expect(localeForBrowser(['nl-NL', 'en'])).toBe('nl')
    expect(localeForBrowser(['fr-FR', 'de', 'nl'])).toBe('de')
    expect(localeForBrowser(['fr', 'es', 'nl-BE'])).toBe('nl')
  })

  it('gives English when none is ours, or when there is no list', () => {
    expect(localeForBrowser(['fr-FR', 'es'])).toBe('en')
    expect(localeForBrowser([])).toBe('en')
    expect(localeForBrowser([undefined, null, ''])).toBe('en')
  })

  it('is read only by the system choice', () => {
    expect(resolveLanguage('system', ['nl'])).toBe('nl')
    expect(resolveLanguage('en', ['nl'])).toBe('en')
    expect(resolveLanguage('de', ['nl'])).toBe('de')
  })
})

describe('initLocale', () => {
  it('follows the browser when nothing is stored, and is in that language before it resolves', async () => {
    configureLocale(environment(null, ['nl-NL', 'en']))

    expect(await initLocale()).toBe('nl')
    expect(activeLocale()).toBe('nl')
    expect(languageChoice()).toBe('system')
    expect(strings.app.common.cancel).toBe('Annuleren')
    expect(document.documentElement.lang).toBe('nl')
  })

  it('lets a stored choice win over the browser', async () => {
    configureLocale(environment('de', ['nl']))

    expect(await initLocale()).toBe('de')
    expect(languageChoice()).toBe('de')
  })

  it('reads a stored value it does not know as "follow the browser"', async () => {
    configureLocale(environment('klingon', ['nl']))

    expect(await initLocale()).toBe('nl')
    expect(languageChoice()).toBe('system')
  })

  it('stays English for a browser that speaks none of ours', async () => {
    configureLocale(environment(null, ['fr-FR']))

    expect(await initLocale()).toBe('en')
    expect(strings.app.common.cancel).toBe('Cancel')
  })
})

describe('setLanguageChoice', () => {
  it('persists the choice, switches the language and tells the subscribers once', async () => {
    const env = environment(null, ['en'])
    const listener = vi.fn()

    configureLocale(env)
    subscribeLocale(listener)

    expect(await setLanguageChoice('de')).toBe('de')
    expect(env.written).toEqual(['de'])
    expect(strings.app.common.cancel).toBe('Abbrechen')
    expect(listener).toHaveBeenCalledTimes(1)

    expect(await setLanguageChoice('de')).toBe('de')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('goes back to the browser list on "system"', async () => {
    configureLocale(environment(null, ['nl']))

    await setLanguageChoice('de')
    expect(await setLanguageChoice('system')).toBe('nl')
    expect(languageChoice()).toBe('system')
  })

  it('lets the latest pick win when two are in flight', async () => {
    configureLocale(environment(null, ['en']))

    const first = setLanguageChoice('nl')
    const second = setLanguageChoice('de')

    await Promise.all([first, second])
    expect(activeLocale()).toBe('de')
  })

  it('stops telling a subscriber who has unsubscribed', async () => {
    const listener = vi.fn()

    configureLocale(environment(null, ['en']))
    subscribeLocale(listener)()
    await setLanguageChoice('nl')

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('the browser environment', () => {
  const memory = (): Pick<Storage, 'getItem' | 'setItem'> & { map: Map<string, string> } => {
    const map = new Map<string, string>()

    return {
      map,
      getItem: key => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value)
      }
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads and writes localStorage under its own key', async () => {
    const store = memory()

    vi.stubGlobal('localStorage', store)
    configureLocale()

    await setLanguageChoice('nl')
    expect(store.map.get('hermie.language')).toBe('nl')

    resetLocale()
    configureLocale()
    expect(await initLocale()).toBe('nl')
    expect(languageChoice()).toBe('nl')
  })

  it('survives a store that cannot be read or written', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      }
    }

    vi.stubGlobal('localStorage', blocked)
    configureLocale()

    await expect(initLocale()).resolves.toBe('en')
    await expect(setLanguageChoice('de')).resolves.toBe('de')
  })

  it('reads navigator.languages in order', async () => {
    vi.stubGlobal('localStorage', memory())
    vi.stubGlobal('navigator', { languages: ['fr-FR', 'de-AT', 'nl'], language: 'fr-FR' })
    configureLocale()

    expect(await initLocale()).toBe('de')
  })

  it('falls back to navigator.language when there is no list', async () => {
    vi.stubGlobal('localStorage', memory())
    vi.stubGlobal('navigator', { language: 'nl-BE' })
    configureLocale()

    expect(await initLocale()).toBe('nl')
  })
})

describe('useLocale', () => {
  function Greeting() {
    const locale = useLocale()

    return (
      <p>
        {locale}: {strings.app.common.cancel}
      </p>
    )
  }

  it('re-renders where it stands on a switch, without a remount', async () => {
    configureLocale(environment(null, ['en']))

    const { container } = render(<Greeting />)
    const paragraph = container.querySelector('p')

    expect(screen.getByText('en: Cancel')).toBeTruthy()

    await act(async () => {
      await setLanguageChoice('nl')
    })

    expect(screen.getByText('nl: Annuleren')).toBeTruthy()
    expect(container.querySelector('p')).toBe(paragraph)
  })
})
