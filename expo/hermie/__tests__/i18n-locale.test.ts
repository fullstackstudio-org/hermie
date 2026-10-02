/**
 * Which language a device asks for, and what the reader can do about it.
 *
 * The rules this pins are the ones a reader would notice being wrong:
 *
 *  - a region is not a language. `nl-BE`, `nl_NL` and `nl` are one catalogue,
 *    because Hermie has no Flemish copy and pretending otherwise would mean
 *    three catalogues that are 99% the same;
 *  - a device set to a language Hermie does not speak gets ENGLISH, which is
 *    the app's own language rather than a failure;
 *  - a pinned choice ignores the device entirely, which is the only reason to
 *    offer pinning at all.
 */
import {
  asLanguageChoice,
  asLocale,
  DEFAULT_LANGUAGE_CHOICE,
  LANGUAGE_ENDONYMS,
  localeForDevice,
  LOCALES,
  resolveLanguage
} from '../src/i18n/locales'

describe('reading a device tag', () => {
  it('drops the region', () => {
    expect(asLocale('nl-NL')).toBe('nl')
    expect(asLocale('nl_BE')).toBe('nl')
    expect(asLocale('de-AT')).toBe('de')
    expect(asLocale('en-GB')).toBe('en')
  })

  it('takes a bare language, in any case', () => {
    expect(asLocale('NL')).toBe('nl')
    expect(asLocale(' de ')).toBe('de')
  })

  it('answers nothing for a language this app does not speak', () => {
    expect(asLocale('fr-FR')).toBeUndefined()
    expect(asLocale('')).toBeUndefined()
    expect(asLocale(null)).toBeUndefined()
    expect(asLocale(42)).toBeUndefined()
  })

  it('falls back to English rather than to nothing when a device is the caller', () => {
    expect(localeForDevice('fr-FR')).toBe('en')
    expect(localeForDevice(null)).toBe('en')
    expect(localeForDevice('de-DE')).toBe('de')
  })
})

describe('reading a stored choice', () => {
  it('keeps "follow the device" apart from a pinned language', () => {
    expect(asLanguageChoice('system')).toBe('system')
    expect(asLanguageChoice('nl')).toBe('nl')
  })

  it('refuses anything else, which leaves the default', () => {
    expect(asLanguageChoice('fr')).toBeUndefined()
    expect(asLanguageChoice({ language: 'nl' })).toBeUndefined()
    expect(DEFAULT_LANGUAGE_CHOICE).toBe('system')
  })
})

describe('resolving a choice against a device', () => {
  it('reads the device only when the choice says to', () => {
    expect(resolveLanguage('system', 'nl-NL')).toBe('nl')
    expect(resolveLanguage('system', 'fr-FR')).toBe('en')
  })

  it('ignores the device for a pinned language', () => {
    expect(resolveLanguage('de', 'nl-NL')).toBe('de')
    expect(resolveLanguage('en', 'de-DE')).toBe('en')
  })
})

describe('the names in the picker', () => {
  it('gives every language its own name for itself', () => {
    // Not translated, and a test rather than a comment: a reader hunting for
    // their language hunts for the word THEY use, so "Dutch" on a Dutch screen
    // would be the one row a Dutch reader scrolls past.
    expect(LANGUAGE_ENDONYMS).toEqual({ en: 'English', nl: 'Nederlands', de: 'Deutsch' })
    expect(Object.keys(LANGUAGE_ENDONYMS).sort()).toEqual([...LOCALES].sort())
  })
})
