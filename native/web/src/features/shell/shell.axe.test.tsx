/**
 * The shell through axe, in both colour schemes and every language, in every
 * state it can be in: no violation.
 *
 * jsdom has no layout and does not load the stylesheets, so two kinds of rule
 * cannot run here: colour contrast, which `ui/theme.contrast.test.ts` measures
 * from the theme itself, and what a media query hides (the one-pane layout), which
 * the Browser-pane check covers. What this does check is the structure: landmarks,
 * names, roles, headings, ARIA, labels, language, with the scheme attribute on
 * the document as the app puts it.
 */
import type { ConnectionStatus } from '@hermie/gateway-client'
import { act, render } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { applyTheme } from '../../platform/theme-target'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { pluginStore } from '../../state/plugin'
import { botsStore } from '../../state/bots'
import { layoutStore } from '../../state/layout'
import { aBot, LONG_AGO, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { App } from './App'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
})

afterEach(async () => {
  applyTheme({ scheme: 'system', tint: 'blue' })
  document.documentElement.removeAttribute('data-tint')
  resetActiveLocale()
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, {
    // No layout and no stylesheet in jsdom: contrast is measured from the theme (`theme.contrast.test.ts`).
    rules: { 'color-contrast': { enabled: false } }
  })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

/**
 * A roster with one of everything a row can be: unread, working, needing input, offline, a picture, an
 * unnamed bot; arranged with a folder, a colour, a pin, a mute and an archived chat.
 */
function populate(): void {
  seedRoster(
    [
      aBot('researcher', { canonical: { ...aBot('x').canonical!, preview: 'Found **three** sources.' } }),
      aBot('writer', { hasAvatar: true }),
      aBot('ops', { displayName: 'Ops 🛠', canonical: { ...aBot('x').canonical!, lastActive: 0 } }),
      aBot('quiet', { description: 'Says little' })
    ],
    { read: false }
  )
  botsStore.getState().markSeen('writer', LONG_AGO)
  botsStore.getState().setAvatar('writer', 0, 'data:image/gif;base64,R0lGODlhAQABAAAAACw=')
  botsStore.getState().setRunning(['quiet'])
  chatsStore.getState().ensure('ops', { storedSessionId: 'stored-ops', resolvedSessionId: 'stored-ops' })
  chatsStore.getState().dispatchServerRequest('ops', {
    id: 'srq-1',
    method: 'approval',
    params: { request_id: 'a1', command: 'ls', choices: ['once', 'deny'] }
  })

  const layout = layoutStore.getState()

  layout.reconcile(['researcher', 'writer', 'ops', 'quiet'])
  layout.moveToFolder('writer', layout.addFolder('Reading'))
  layout.setAccent('researcher', 'teal')
  layout.setPinned('ops', true)
  layout.setMute('ops', 0)
  layout.setArchived('quiet', true)
}

const mount = (hash = '#/') => {
  const router = createHashRouter(null)

  router.navigate(hash)

  return render(<App user="Tester" onSignIn={() => {}} onSignOut={() => {}} router={router} />)
}

describe('the shell, through axe', () => {
  it('is checked by a checker that does find things', async () => {
    render(
      <main>
        <h1>Broken</h1>
        <img src="/x.png" />
        <button type="button" />
      </main>
    )

    const found = await violations()

    expect(found.some(line => line.startsWith('image-alt'))).toBe(true)
    expect(found.some(line => line.startsWith('button-name'))).toBe(true)
  })

  describe.each(['light', 'dark', 'system'] as const)('in the %s scheme', scheme => {
    beforeEach(() => {
      applyTheme({ scheme, tint: 'blue' })
      connectionStore.getState().setStatus('ready', null)
      pluginStore.getState().apply(null)
      populate()
    })

    it('has no violation on the home route', async () => {
      mount('#/')

      expect(await violations()).toEqual([])
    })

    it('has no violation on a chat route', async () => {
      mount('#/chat/researcher')

      expect(await violations()).toEqual([])
    })

    it('has no violation on a settings route', async () => {
      mount('#/settings/notifications')

      expect(await violations()).toEqual([])
    })

    it.each<ConnectionStatus>(['connecting', 'reconnecting', 'offline', 'needs_signin', 'incompatible', 'paused'])(
      'has no violation while the connection is %s',
      async status => {
        mount('#/')
        act(() => connectionStore.getState().setStatus(status, null))

        expect(await violations()).toEqual([])
      }
    )
  })

  it('has no violation before the roster has been read, with no bots, or when it could not be read', async () => {
    connectionStore.getState().setStatus('connecting', null)
    const { unmount } = mount()

    expect(await violations()).toEqual([])
    unmount()

    seedRoster([])
    const second = mount()

    expect(await violations()).toEqual([])
    second.unmount()

    resetShellStores()
    botsStore.getState().setError('gateway not connected')
    mount()

    expect(await violations()).toEqual([])
  })

  it('has no violation when the web client is switched off', async () => {
    pluginStore.getState().apply({
      v: 1,
      version: '0.6.0',
      capabilities: [],
      modules: { web: 'off' },
      limits: {},
      relayOrigins: [],
      web: null,
      webPush: null
    } as never)
    mount()

    expect(await violations()).toEqual([])
  })

  it.each(['nl', 'de'] as const)('has no violation in %s, with the page’s language set to match', async locale => {
    connectionStore.getState().setStatus('reconnecting', null)
    pluginStore.getState().apply(null)
    populate()
    await setLanguageChoice(locale)
    mount('#/chat/writer')

    expect(document.documentElement.lang).toBe(locale)
    expect(await violations()).toEqual([])
  })
})
