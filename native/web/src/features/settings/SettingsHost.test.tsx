/**
 * The Settings host: the home lists every section with a link and what is in it, a section opens under
 * a way back, an unknown one is the home (and the address says so), and the chunks are asked for early
 * when a link is reached.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale, setLanguageChoice } from '../../i18n/locale'
import { createHashRouter, type HashRouter } from '../../platform/hash-router'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { resetShellStores } from '../../test-support/shell-stores'
import { isSettingsSection, listedSections, SETTINGS_SECTIONS, sectionBlurb, sectionTitle } from './sections'
import { SettingsHost } from './SettingsHost'
import { SettingsRuntimeContext } from './settings-runtime'

let router: HashRouter

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  router = createHashRouter(null)
})

afterEach(() => {
  cleanup()
  resetLocale()
  resetActiveLocale()
  Reflect.deleteProperty(window, 'webkitSpeechRecognition')
})

const mount = (section?: string) =>
  render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime()}>
      <SettingsHost {...(section === undefined ? {} : { section })} router={router} />
    </SettingsRuntimeContext.Provider>
  )

describe('the sections', () => {
  it('are the ones this client has, in the order the home lists them, and nothing else', () => {
    expect(SETTINGS_SECTIONS).toEqual([
      'account',
      'gateway',
      'passkeys',
      'mcp',
      'memory',
      'skills',
      'mcp-servers',
      'chats',
      'notifications',
      'chat-list',
      'appearance',
      'voice',
      'about'
    ])
    expect(isSettingsSection('about')).toBe(true)
    expect(isSettingsSection('voice')).toBe(true)
    expect(isSettingsSection('notifications')).toBe(true)
    expect(isSettingsSection('operator')).toBe(false)
    expect(isSettingsSection(undefined)).toBe(false)
  })

  it('each have a title and a blurb in every language', async () => {
    for (const locale of ['en', 'nl', 'de'] as const) {
      await setLanguageChoice(locale)

      for (const section of SETTINGS_SECTIONS) {
        expect(sectionTitle(section), `${section} [${locale}]`).not.toBe('')
        expect(sectionBlurb(section), `${section} [${locale}]`).not.toBe('')
      }
    }
  })
})

describe('the home', () => {
  it('links to every section by its title, and says what is in it', () => {
    // A browser that can take dictation has a Voice section; this one is listed below.
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: class {} })
    mount()

    const links = screen.getAllByRole('link')

    expect(links.map(link => link.textContent)).toEqual([
      'Account',
      'This gateway',
      'Passkeys',
      'MCP',
      'Memory',
      'Skills',
      'MCP servers',
      'Chats & messages',
      'Notifications',
      'Chat list',
      'Appearance',
      'Voice',
      'About'
    ])
    expect(links.map(link => link.getAttribute('href'))).toEqual(
      SETTINGS_SECTIONS.map(section => `#/settings/${section}`)
    )

    // The blurb is the link's description, not part of its name.
    for (const link of links) {
      const description = document.getElementById(link.getAttribute('aria-describedby') ?? '')

      expect(description?.textContent?.length).toBeGreaterThan(10)
    }
  })

  it('does not list Voice in a browser that can neither read aloud nor take dictation', () => {
    mount()

    expect(listedSections()).toEqual(SETTINGS_SECTIONS.filter(section => section !== 'voice'))
    expect(screen.queryByRole('link', { name: 'Voice' })).toBeNull()
  })

  it('has no operator settings (those are the plugin’s configuration)', () => {
    mount()

    expect(screen.queryByRole('link', { name: /operator|admin/iu })).toBeNull()
  })

  it('is the answer for an unknown section too, and rewrites the address to say so', () => {
    router.navigate('#/settings/nothing')
    mount('nothing')

    expect(screen.getAllByRole('link')).toHaveLength(listedSections().length)
    expect(router.current()).toBe('#/settings')
  })

  it('reads in the language in use', async () => {
    await setLanguageChoice('nl')
    mount()

    expect(screen.getByRole('link', { name: 'Weergave' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Deze gateway' })).toBeTruthy()
  })
})

describe('a section', () => {
  it('opens under a way back to the home, and says its own title as the page’s h2', async () => {
    mount('appearance')

    expect(await screen.findByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to settings' }).getAttribute('href')).toBe('#/settings')
  })

  it.each([
    ['account', 'Account'],
    ['gateway', 'This gateway'],
    ['passkeys', 'Passkeys'],
    ['mcp', 'MCP'],
    ['chats', 'Chats & messages'],
    ['chat-list', 'Chat list'],
    ['appearance', 'Appearance'],
    ['voice', 'Voice'],
    ['about', 'About']
  ])('%s opens its page', async (section, title) => {
    mount(section)

    expect(await screen.findByRole('heading', { level: 2, name: title })).toBeTruthy()
  })

  it('asks for a section’s chunk when its link is pointed at or focused', () => {
    mount()

    const link = screen.getByRole('link', { name: 'Chat list' })

    // Nothing to assert on the network here; the call must not throw, whether or not the chunk loads.
    expect(() => {
      fireEvent.pointerEnter(link)
      fireEvent.focus(link)
    }).not.toThrow()
  })
})

describe('on a gateway without sign-in', () => {
  const mountUngated = (section: string) =>
    render(
      <SettingsRuntimeContext.Provider value={aSettingsRuntime({ gated: false })}>
        <SettingsHost section={section} router={router} />
      </SettingsRuntimeContext.Provider>
    )

  it.each([
    ['passkeys', 'Passkeys', /Passkeys belong to a person signed in to the gateway\. This gateway has no sign-in/u],
    ['mcp', 'MCP', /MCP access is granted to a person signed in to the gateway\. This gateway has no sign-in/u]
  ])('%s says plainly that it needs sign-in, and offers nothing to act on', (section, title, sentence) => {
    mountUngated(section)

    const page = screen.getByRole('region', { name: title })

    expect(page.textContent).toMatch(sentence)
    expect(page.querySelector('button, input, form')).toBeNull()
  })

  it('opens the other sections as usual', async () => {
    mountUngated('appearance')

    expect(await screen.findByRole('heading', { level: 2, name: 'Appearance' })).toBeTruthy()
  })
})
