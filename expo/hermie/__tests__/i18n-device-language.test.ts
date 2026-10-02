/**
 * What a phone set to another language opens on.
 *
 * "Follow device" is the default, so this is the common path rather than an
 * edge one, and the property worth pinning is about TIMING: the device's
 * language has to be live before the first paint, not after the first disk
 * read. `hydrate` runs in an effect, so a store that waited for it would open a
 * Dutch phone on an English screen and flip a moment later.
 *
 * The device seam is mocked per case and the modules are re-imported inside an
 * isolated registry, because the thing under test happens at module load — once
 * — and a test that imported the store at the top of the file would only ever
 * see the first answer.
 */
import type * as ActiveLocale from '../src/i18n/active-locale'
import type * as Language from '../src/store/language'

/**
 * The tag the mocked seam answers with.
 *
 * A box rather than a `jest.fn` the test reconfigures, because
 * `jest.isolateModules` builds a fresh module registry and runs the mock
 * FACTORY again inside it — so the function a test held a handle to is not the
 * one the isolated store calls. The box is closed over by the factory and
 * survives, which is what makes the two agree. The `mock` prefix is what lets
 * the factory reference it at all.
 */
const mockDeviceTag = { value: 'en-US' }

jest.mock('../src/platform/device-facts', () => ({ deviceLocale: () => mockDeviceTag.value }))

type ActiveLocaleModule = typeof ActiveLocale
type LanguageModule = typeof Language

/** Load the store fresh, with the device answering `tag`. */
function launchWith(tag: string) {
  let modules!: {
    activeLocale: ActiveLocaleModule['activeLocale']
    useLanguageStore: LanguageModule['useLanguageStore']
  }

  mockDeviceTag.value = tag

  jest.isolateModules(() => {
    const active = require('../src/i18n/active-locale') as ActiveLocaleModule
    const store = require('../src/store/language') as LanguageModule

    modules = { activeLocale: active.activeLocale, useLanguageStore: store.useLanguageStore }
  })

  return modules
}

afterEach(() => {
  jest.resetModules()
})

describe('a device that speaks one of ours', () => {
  it('is in that language before anything is read from disk', () => {
    const { activeLocale, useLanguageStore } = launchWith('nl-NL')

    expect(useLanguageStore.getState().loaded).toBe(false)
    expect(activeLocale()).toBe('nl')
    expect(useLanguageStore.getState().locale).toBe('nl')
    expect(useLanguageStore.getState().choice).toBe('system')
  })

  it('drops the region', () => {
    expect(launchWith('de-AT').activeLocale()).toBe('de')
  })
})

describe('a device that does not', () => {
  it('gets English, which is the language the app is written in', () => {
    expect(launchWith('fr-FR').activeLocale()).toBe('en')
    expect(launchWith('').activeLocale()).toBe('en')
  })
})

describe('the store and the active locale', () => {
  it('never disagree', () => {
    // Two places holding one fact. A window where the store says Dutch and the
    // proxy says English is a bug waiting for somebody to read the wrong one.
    const { activeLocale, useLanguageStore } = launchWith('nl-BE')

    expect(useLanguageStore.getState().locale).toBe(activeLocale())

    useLanguageStore.getState().setChoice('de')

    expect(useLanguageStore.getState().locale).toBe(activeLocale())
    expect(activeLocale()).toBe('de')
  })
})
