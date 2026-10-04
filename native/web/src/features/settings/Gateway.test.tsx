/**
 * Settings, This gateway: what the page knows of its gateway, read only, from the page's own address,
 * the status route's Hermes version, the plugin's advert and this build; every state of the plugin; and
 * the update line's three answers.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildLabel, sourceCommit } from '../../build-info'
import { webPluginAdvertOf } from '../../core/advert'
import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { pluginStore } from '../../state/plugin'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { resetShellStores } from '../../test-support/shell-stores'
import { Gateway } from './Gateway'
import { SettingsRuntimeContext } from './settings-runtime'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

const advertWith = (over: Record<string, unknown> = {}) =>
  webPluginAdvertOf({
    v: 1,
    version: '0.1.4',
    capabilities: ['web.client'],
    modules: { web: 'on', push: 'on', presence: 'planned', context: 'off' },
    limits: {},
    updatedAt: 1,
    web: { path: '/dashboard-plugins/hermie/app/index.html', version: '0.2.0', commit: sourceCommit.slice(0, 12) },
    ...over
  })

function mount(runtime = aSettingsRuntime()) {
  return render(
    <SettingsRuntimeContext.Provider value={runtime}>
      <Gateway />
    </SettingsRuntimeContext.Provider>
  )
}

const fact = (label: string): string | null | undefined =>
  screen.getByText(label, { selector: 'dt' }).closest('div')?.querySelector('dd')?.textContent

describe('the This gateway page', () => {
  it('shows the host, the address and the Hermes version of the gateway the page came from', () => {
    pluginStore.getState().apply(advertWith())
    mount()

    expect(screen.getByRole('heading', { level: 2, name: 'This gateway' })).toBeTruthy()
    expect(fact('Host')).toBe('gw.example.test')
    expect(fact('Address')).toBe('https://gw.example.test')
    expect(fact('Hermes version')).toBe('0.21.3')
  })

  it('says it cannot be changed here, and where the operator’s settings are', () => {
    mount()

    expect(screen.getByText(/Nothing here can be changed/u)).toBeTruthy()
    expect(screen.queryAllByRole('button')).toHaveLength(0)
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryAllByRole('textbox')).toHaveLength(0)
  })

  it('says "Unknown" when the status route named no version', () => {
    mount(aSettingsRuntime({ hermesVersion: '' }))

    expect(fact('Hermes version')).toBe('Unknown')
  })

  it('shows the plugin, its version and each module with its state, sorted', () => {
    pluginStore.getState().apply(advertWith())
    mount()

    expect(fact('Plugin')).toBe('Hermie plugin 0.1.4')

    const modules = within(screen.getByText('Plugin modules', { selector: 'dt' }).closest('div') as HTMLElement)
      .getAllByRole('listitem')
      .map(item => item.textContent)

    expect(modules).toEqual(['context: off', 'presence: planned', 'push: on', 'web: on'])
  })

  it('draws a module state it has no word for as the plugin wrote it, as text', () => {
    pluginStore.getState().apply(advertWith({ modules: { web: 'on', odd: '<b>x</b>' } }))
    mount()

    expect(screen.getByText('odd', { selector: 'span' }).closest('li')?.textContent).toBe('odd: <b>x</b>')
    expect(document.querySelector('b')).toBeNull()
  })

  it('says the plugin is not read yet, rather than that it is missing', () => {
    mount()

    expect(fact('Plugin')).toBe('Checking…')
    expect(screen.queryByText('Plugin modules', { selector: 'dt' })).toBeNull()
  })

  it('says the plugin is not installed, and that notifications need it', () => {
    pluginStore.getState().apply(null)
    mount()

    expect(fact('Plugin')).toBe('Not installed')
    expect(screen.getByText(/no Hermie plugin/u)).toBeTruthy()
    expect(screen.queryByText('Update', { selector: 'dt' })).toBeNull()
  })

  it('says a plugin that lists no modules lists none', () => {
    pluginStore.getState().apply(advertWith({ modules: {} }))
    mount()

    expect(fact('Plugin modules')).toBe('The plugin lists none.')
  })

  it('names this page’s build and the build the plugin carries', () => {
    pluginStore.getState().apply(advertWith())
    mount()

    expect(fact('This page')).toBe(buildLabel)
    expect(fact('Web client in the plugin')).toBe(`0.2.0 (${sourceCommit.slice(0, 7)})`)
  })

  describe('the update line', () => {
    it('knows no update when the plugin carries this very build', () => {
      pluginStore.getState().apply(advertWith())
      mount()

      expect(fact('Update')).toBe('No update is known: this page is the web client the plugin carries.')
    })

    it('says to reload when the plugin carries another build', () => {
      pluginStore.getState().apply(advertWith({ web: { path: '/x', version: '0.3.0', commit: 'abc123456789' } }))
      mount()

      expect(fact('Update')).toBe(
        'The plugin now carries another web client, 0.3.0 (abc1234). Reload this page to use it.'
      )
    })

    it('knows no update when the plugin does not say which client it carries', () => {
      pluginStore.getState().apply(advertWith({ web: undefined }))
      mount()

      expect(fact('Web client in the plugin')).toBe('The plugin does not say which web client it carries.')
      expect(fact('Update')).toBe('No update is known: the plugin does not say which web client it carries.')
    })
  })

  it('reads in the language in use', () => {
    pluginStore.getState().apply(advertWith())
    const view = mount()

    act(() => setActiveLocale('nl'))
    view.rerender(
      <SettingsRuntimeContext.Provider value={aSettingsRuntime()}>
        <Gateway />
      </SettingsRuntimeContext.Provider>
    )

    expect(screen.getByRole('heading', { level: 2, name: 'Deze gateway' })).toBeTruthy()
    expect(fact('Hermes-versie')).toBe('0.21.3')
  })
})
