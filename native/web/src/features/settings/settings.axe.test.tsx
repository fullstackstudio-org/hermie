/**
 * Settings through axe, in the light and the dark scheme and in every language: the home and each
 * section the page owns, with the states that put the most on screen (a row's panel open, a sign-out
 * question, the licences loaded, a plugin with its modules): no violation.
 *
 * jsdom has no layout and does not load the stylesheets, so colour contrast is not run here: it is
 * measured from the theme (`ui/theme.contrast.test.ts`) and, with the stylesheets, in the browser suite
 * (`e2e/settings.spec.ts`). What this checks is the structure: names, roles, labels, headings, landmarks.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { webPluginAdvertOf } from '../../core/advert'
import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale, setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { applyTheme } from '../../platform/theme-target'
import { layoutStore } from '../../state/layout'
import { pluginStore } from '../../state/plugin'
import { uiMetaStatusStore } from '../../state/ui-meta-status'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { type SettingsSection } from './sections'
import { SettingsHost } from './SettingsHost'
import { SettingsRuntimeContext } from './settings-runtime'

const LICENCES = {
  packages: [
    { name: 'react', version: '19.1.0', licence: 'MIT', repository: 'https://example.test/react', text: 'aaa' },
    { name: 'no-text', version: '1.0.0', licence: 'ISC' }
  ],
  texts: { aaa: 'MIT License\n\nCopyright (c) Somebody' }
}

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => LICENCES }) as unknown as Response)
  )
  seedRoster([aBot('researcher'), aBot('writer'), aBot('ops', { displayName: 'Ops desk' })])
  layoutStore.getState().reconcile(['researcher', 'writer', 'ops'])
  layoutStore.getState().addFolder('Work')
  layoutStore.getState().setArchived('ops', true)
  layoutStore.getState().setMute('writer', 0)
  pluginStore.getState().apply(
    webPluginAdvertOf({
      v: 1,
      version: '0.1.4',
      capabilities: ['web.client'],
      modules: { web: 'on', push: 'on', presence: 'planned' },
      limits: {},
      updatedAt: 1,
      web: { path: '/dashboard-plugins/hermie/app/index.html', version: '0.3.0', commit: 'abcdef012345' }
    })
  )
  uiMetaStatusStore.getState().set('local')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  applyTheme({ scheme: 'system', tint: 'blue' })
  document.documentElement.removeAttribute('data-tint')
  resetLocale()
  resetActiveLocale()
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, {
    rules: { 'color-contrast': { enabled: false } }
  })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

/** The main pane's `h1` the layout draws around every settings route, which a bare host test lacks. */
function mount(section?: SettingsSection) {
  return render(
    <SettingsRuntimeContext.Provider value={aSettingsRuntime()}>
      <main>
        <h1>Settings</h1>
        <SettingsHost {...(section === undefined ? {} : { section })} router={createHashRouter(null)} />
      </main>
    </SettingsRuntimeContext.Provider>
  )
}

const SECTIONS: (SettingsSection | undefined)[] = [
  undefined,
  'account',
  'gateway',
  'chats',
  'chat-list',
  'appearance',
  'voice',
  'about'
]

describe('Settings, through axe', () => {
  it('is checked by a checker that does find things', async () => {
    render(
      <main>
        <h1>Broken</h1>
        <input type="radio" />
        <select />
      </main>
    )

    const found = await violations()

    expect(found.some(line => line.startsWith('label'))).toBe(true)
  })

  describe.each(['light', 'dark'] as const)('in the %s scheme', scheme => {
    beforeEach(() => {
      applyTheme({ scheme, tint: 'teal' })
    })

    it.each(SECTIONS)('has no violation on %s', async section => {
      mount(section)

      if (section !== undefined) {
        await screen.findByRole('heading', { level: 2 })
      }

      if (section === 'about') {
        await screen.findByRole('list', { name: 'Licences' })
      }

      expect(await violations()).toEqual([])
    })

    it('has no violation on the chat list with a row’s panel and a folder’s panel open', async () => {
      mount('chat-list')
      await screen.findByRole('heading', { level: 2, name: 'Chat list' })

      fireEvent.click(screen.getByRole('button', { name: 'Actions for Researcher' }))
      fireEvent.click(screen.getByRole('button', { name: 'Actions for the Work folder' }))

      expect(await violations()).toEqual([])
    })

    it('has no violation on an archived chat’s panel', async () => {
      mount('chat-list')
      await screen.findByRole('heading', { level: 2, name: 'Chat list' })

      fireEvent.click(screen.getByRole('button', { name: 'Actions for Ops desk' }))

      expect(await violations()).toEqual([])
    })

    it('has no violation on the sign-out question', async () => {
      mount('account')
      await screen.findByRole('heading', { level: 2, name: 'Account' })

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))

      expect(await violations()).toEqual([])
    })

    it('has no violation on a licence opened', async () => {
      mount('about')
      await screen.findByRole('list', { name: 'Licences' })

      act(() => {
        document.querySelector('details')?.setAttribute('open', '')
      })

      expect(await violations()).toEqual([])
    })
  })

  describe.each(['nl', 'de'] as const)('in %s', locale => {
    it.each(SECTIONS)('has no violation on %s', async section => {
      await act(async () => {
        await setLanguageChoice(locale)
      })
      mount(section)

      if (section !== undefined) {
        await screen.findByRole('heading', { level: 2 })
      }

      expect(await violations()).toEqual([])
    })
  })
})
