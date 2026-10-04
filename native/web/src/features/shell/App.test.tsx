import type { ConnectionStatus } from '@hermie/gateway-client'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildLabel } from '../../build-info'
import { BOT_NAME_LIMIT } from '../../core/requests/secure-input'
import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter, type HashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { layoutStore } from '../../state/layout'
import { pluginStore } from '../../state/plugin'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { App, type AppProps } from './App'

let router: HashRouter

beforeEach(() => {
  resetShellStores()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
  router = createHashRouter(null)
  document.title = 'Hermie'
})

afterEach(() => {
  resetActiveLocale()
})

function renderApp(over: Partial<AppProps> = {}) {
  const props: AppProps = { user: 'Tester', onSignIn: vi.fn(), onSignOut: vi.fn(), router, ...over }

  return { ...render(<App {...props} />), props }
}

const status = (state: ConnectionStatus, error = null) => act(() => connectionStore.getState().setStatus(state, error))
const pane = (): string | null | undefined => document.querySelector('.hm-app')?.getAttribute('data-pane')

describe('the frame', () => {
  it('has a nav for the chats, a main pane, and a footer for who is signed in', () => {
    renderApp()

    const nav = screen.getByRole('navigation', { name: 'Chats' })

    expect(within(nav).getAllByRole('link')).toHaveLength(2)
    expect(screen.getByRole('main')).toBeTruthy()
    expect(screen.getAllByRole('navigation')).toHaveLength(1)
    expect(screen.getAllByRole('main')).toHaveLength(1)
    expect(screen.getByRole('contentinfo')).toBeTruthy()
  })

  it('puts a skip link first, which moves focus to the main heading without touching the route', () => {
    router.navigate('#/chat/writer')
    renderApp()

    const skip = screen.getByRole('link', { name: 'Skip to content' })

    expect(document.body.querySelector('a, button')).toBe(skip)

    fireEvent.click(skip)

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
    expect(router.current()).toBe('#/chat/writer')
  })

  it('shows the list on the home route and the main pane on every other, which is what one pane shows', () => {
    renderApp()

    expect(pane()).toBe('list')

    act(() => router.navigate('#/chat/writer'))
    expect(pane()).toBe('detail')

    act(() => router.navigate('#/settings'))
    expect(pane()).toBe('detail')

    act(() => router.navigate('#/'))
    expect(pane()).toBe('list')
  })

  it('offers a way back to the list from a chat', () => {
    router.navigate('#/chat/writer')
    renderApp()

    expect(screen.getByRole('link', { name: 'Back to chats' }).getAttribute('href')).toBe('#/')
  })

  it('names who is signed in, the way out and the client’s version', () => {
    renderApp()

    const footer = screen.getByRole('contentinfo')

    expect(within(footer).getByText('Signed in as Tester')).toBeTruthy()
    expect(within(footer).getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(within(footer).getByText(`Version ${buildLabel}`)).toBeTruthy()
  })

  it('says only "Signed in" when the gateway named nobody', () => {
    renderApp({ user: '' })

    expect(screen.getByText('Signed in')).toBeTruthy()
  })
})

describe('the routes', () => {
  it('heads the home route with the app’s name, and invites a pick', () => {
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hermie')
    expect(screen.getByText('Pick a conversation to start reading.')).toBeTruthy()
    expect(document.title).toBe('Hermie')
  })

  it('heads a chat with the bot’s display name, and names the tab after it', () => {
    router.navigate('#/chat/researcher')
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dr. Researcher')
    expect(document.title).toBe('Dr. Researcher · Hermie')
    expect(screen.getByRole('link', { name: /Dr\. Researcher/ }).getAttribute('aria-current')).toBe('page')
  })

  it('heads a chat with the name the reader gave the bot, over the bot’s own', () => {
    layoutStore.getState().setLabel('researcher', 'The Scribe')
    router.navigate('#/chat/researcher')
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('The Scribe')
    expect(document.title).toBe('The Scribe · Hermie')
  })

  it('opens the bot’s profile from a click on the chat’s heading', () => {
    router.navigate('#/chat/writer')
    renderApp()

    const heading = screen.getByRole('heading', { level: 1 })

    expect(heading.getAttribute('title')).toBe("Edit Writer's profile")
    fireEvent.click(heading)
    expect(router.current()).toBe('#/chat/writer/profile')
  })

  it('heads the profile route with what it is', () => {
    router.navigate('#/chat/writer/profile')
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe("Edit Writer's profile")
    expect(document.title).toBe("Edit Writer's profile · Hermie")
    expect(pane()).toBe('detail')
  })

  it('cleans, bounds and isolates the bot’s name in the heading and the tab: it is the bot’s own words', () => {
    seedRoster([aBot('researcher', { displayName: `Evil\u202Etxt.exe\u2060 ${'x'.repeat(200)}` })])
    router.navigate('#/chat/researcher')
    renderApp()

    const heading = screen.getByRole('heading', { level: 1 })
    const name = heading.querySelector('bdi')

    expect(name).not.toBeNull()
    expect(heading.textContent).not.toMatch(/[\u202E\u2060]/u)
    expect(heading.textContent?.startsWith('Eviltxt.exe x')).toBe(true)
    expect([...(heading.textContent ?? '')].length).toBeLessThanOrEqual(BOT_NAME_LIMIT + 1)
    expect(heading.textContent?.endsWith('…')).toBe(true)
    expect(document.title).not.toMatch(/[\u202E\u2060]/u)
    expect(document.title).toBe(`${heading.textContent ?? ''} · Hermie`)
  })

  it('heads a chat of a bot not on the roster with the name in the route', () => {
    router.navigate('#/chat/ghost')
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('ghost')
  })

  it('knows a conversation and a settings route, and heads them', () => {
    router.navigate('#/chat/writer/s/abc')
    const { unmount } = renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Writer')
    unmount()
    router.navigate('#/settings/operator')
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings')
  })

  it('lists every settings section on the settings home, Passkeys and MCP among them', async () => {
    router.navigate('#/settings')
    renderApp()

    const links = await screen.findAllByRole('link', {
      name: /^(Account|This gateway|Passkeys|MCP|Chats|Chat list|Appearance|About)/u
    })

    expect(links.map(link => link.getAttribute('href'))).toEqual([
      '#/settings/account',
      '#/settings/gateway',
      '#/settings/passkeys',
      '#/settings/mcp',
      '#/settings/mcp-servers',
      '#/settings/chats',
      '#/settings/chat-list',
      '#/settings/appearance',
      '#/settings/about'
    ])
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings')
  })

  it('rewrites a settings section it does not have to the settings home', async () => {
    router.navigate('#/settings/operator')
    renderApp()

    await screen.findByRole('link', { name: 'Appearance' })
    expect(router.current()).toBe('#/settings')
  })

  it('offers a way to Settings in the sidebar’s foot', () => {
    renderApp()

    const footer = screen.getByRole('contentinfo')

    expect(within(footer).getByRole('link', { name: 'Settings' }).getAttribute('href')).toBe('#/settings')
  })

  it('opens a section in a chunk of its own, under a way back to the home', async () => {
    router.navigate('#/settings/about')
    renderApp()

    expect(await screen.findByRole('heading', { level: 2, name: 'About' })).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Back to settings' }).getAttribute('href')).toBe('#/settings')
  })

  it('opens the MCP page in a chunk of its own, and hands it the model’s actions', async () => {
    const watch = vi.fn(() => () => undefined)

    router.navigate('#/settings/mcp')
    renderApp({
      mcp: {
        host: 'gw.example.test',
        watch,
        refresh: vi.fn(async () => undefined),
        revoke: vi.fn(async () => 'revoked' as const)
      }
    })

    expect(await screen.findByRole('heading', { level: 2, name: 'MCP' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Settings')
    expect(watch).toHaveBeenCalled()
  })

  it('heads a bot’s conversations page, and keeps the bot selected in the list', () => {
    router.navigate('#/chat/writer/conversations')
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Conversations')
    expect(document.querySelector('a[data-bot="writer"]')?.getAttribute('aria-current')).toBe('page')
    expect(pane()).toBe('detail')
  })

  it('sends an unknown route to the home route', () => {
    router.navigate('#/nowhere/at/all')
    renderApp()

    expect(router.current()).toBe('#/')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Hermie')
    expect(pane()).toBe('list')
  })

  it('follows the address as it changes', () => {
    renderApp()

    act(() => router.navigate('#/chat/writer'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Writer')

    act(() => router.navigate('#/chat/researcher'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Dr. Researcher')
  })

  it('takes the display name from the roster as it arrives', () => {
    router.navigate('#/chat/writer')
    renderApp()

    act(() => seedRoster([aBot('writer', { displayName: 'Ghostwriter' })]))

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Ghostwriter')
  })
})

describe('focus follows the route', () => {
  it('does not move on the first load', () => {
    router.navigate('#/chat/writer')
    renderApp()

    expect(document.activeElement).toBe(document.body)
  })

  it('moves to the main heading when the route changes', () => {
    renderApp()

    act(() => router.navigate('#/chat/writer'))

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))

    act(() => router.navigate('#/chat/researcher'))

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1 }))
    expect(document.activeElement?.textContent).toBe('Dr. Researcher')
  })

  it('does not move when the same route is drawn again', () => {
    renderApp()
    act(() => router.navigate('#/chat/writer'))
    screen.getByRole('link', { name: /Researcher/ }).focus()

    act(() => seedRoster([aBot('researcher'), aBot('writer')]))

    expect(document.activeElement).toBe(screen.getByRole('link', { name: /Researcher/ }))
  })

  it('falls back to the sidebar’s heading when the main pane is not shown (one pane, list route)', () => {
    router.navigate('#/chat/writer')
    renderApp()

    // A hidden pane cannot take focus: stand in for it with a heading that refuses.
    screen.getByRole('heading', { level: 1 }).focus = vi.fn()
    act(() => router.navigate('#/'))

    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Chats' }))
  })

  it('is a heading that can be focused by script and is not a tab stop', () => {
    renderApp()

    expect(screen.getByRole('heading', { level: 1 }).tabIndex).toBe(-1)
    expect(screen.getByRole('heading', { level: 2 }).tabIndex).toBe(-1)
  })
})

describe('the connection', () => {
  const line = (): HTMLElement | null => document.querySelector<HTMLElement>('.hm-status')

  it('is silent while connected', () => {
    renderApp()

    expect(line()).toBeNull()
  })

  it('is silent while the page is paused: nobody is looking', () => {
    renderApp()
    status('paused')

    expect(line()).toBeNull()
  })

  it.each<[ConnectionStatus, string]>([
    ['disconnected', 'Connecting…'],
    ['probing', 'Connecting…'],
    ['authenticating', 'Connecting…'],
    ['connecting', 'Connecting…'],
    ['reconnecting', 'Reconnecting…'],
    ['offline', 'Offline']
  ])('says %s politely, as "%s"', (state, words) => {
    renderApp()
    status(state)

    expect(screen.getByRole('status').textContent).toBe(words)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('draws the transient states on top of both panes, and the list stays usable under them', () => {
    renderApp()
    status('reconnecting')

    expect(screen.getAllByRole('link', { name: /Writer/ })).toHaveLength(1)
    expect(line()?.nextElementSibling?.className).toBe('hm-panes')
  })

  it('goes away again when the connection is back', () => {
    renderApp()
    status('reconnecting')
    status('ready')

    expect(line()).toBeNull()
  })

  it('offers to sign in again when the session has lapsed, and does so on the button', () => {
    const { props } = renderApp()

    status('needs_signin')

    expect(screen.getByRole('alert').textContent).toContain('Signed out')

    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(props.onSignIn).toHaveBeenCalledTimes(1)
    expect(props.onSignOut).not.toHaveBeenCalled()
  })

  it('says a gateway too old for the client is too old, and offers no button for it', () => {
    renderApp()
    status('incompatible')

    expect(screen.getByRole('alert').textContent).toBe(
      'This gateway is too old for Hermie. Update Hermes on the gateway.'
    )
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('shows the cached roster, offline, with the rows marked offline', () => {
    renderApp()
    status('offline')

    expect(document.querySelectorAll('.hm-bead[data-state="offline"]')).toHaveLength(2)
    expect(within(screen.getByRole('navigation')).getAllByRole('link')).toHaveLength(2)
  })

  it('speaks the reader’s language', async () => {
    renderApp()
    status('reconnecting')

    await act(async () => {
      await setLanguageChoice('nl')
    })

    expect(screen.getByRole('status').textContent).toBe('Opnieuw verbinden…')
    expect(screen.getByRole('link', { name: 'Naar de inhoud' })).toBeTruthy()
  })
})

describe('without the plugin', () => {
  it('works, and says notifications need it', () => {
    pluginStore.getState().apply(null)
    renderApp()

    expect(screen.getAllByRole('link', { name: /Writer|Researcher/ })).toHaveLength(2)
    expect(screen.getByText('This gateway has no Hermie plugin. Chats work, but notifications need it.')).toBeTruthy()
  })

  it('is not told before the roster has said whether the plugin is there', () => {
    renderApp()

    expect(screen.queryByText(/no Hermie plugin/)).toBeNull()
  })
})

describe('a gateway whose operator switched the web client off', () => {
  it('gets one sentence instead of the app', () => {
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
    renderApp()

    expect(screen.getByRole('alert').textContent).toMatch(/switched off on this gateway/)
    expect(screen.queryByRole('navigation')).toBeNull()
  })
})

describe('signing out', () => {
  it('asks once, and disables the button so a second click cannot ask again', () => {
    const { props } = renderApp()
    const button = screen.getByRole('button', { name: 'Sign out' })

    fireEvent.click(button)
    fireEvent.click(button)

    expect(props.onSignOut).toHaveBeenCalledTimes(1)
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('the keyboard shortcuts', () => {
  it('open their list on the question mark, from a button in the foot too, and close it with Escape, giving the focus back', async () => {
    renderApp()

    // From the keyboard: a chunk of its own, drawn once it has arrived.
    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(screen.queryByRole('dialog', { name: 'Keyboard shortcuts' })).toBeNull()

    // From the button in the foot, which has the focus again when the list goes.
    const button = screen.getByRole('button', { name: 'Keyboard shortcuts' })

    button.focus()
    fireEvent.click(button)
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()
    expect(document.querySelector('.hm-app')?.closest('[inert]')).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(button)
  })

  it('walk the chats of the list, and not while the list of shortcuts is open', async () => {
    renderApp()
    act(() => router.navigate('#/chat/researcher'))

    fireEvent.keyDown(document.body, { key: 'ArrowDown', altKey: true })
    expect(router.current()).toBe('#/chat/writer')

    fireEvent.keyDown(document.body, { key: '?', shiftKey: true })
    await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })
    fireEvent.keyDown(document.body, { key: 'ArrowUp', altKey: true })
    expect(router.current()).toBe('#/chat/writer')
  })
})

describe('what the screen reads', () => {
  it('is the stores: a bot that appears is in the list', () => {
    renderApp()

    act(() => seedRoster([aBot('researcher'), aBot('writer'), aBot('ops')]))

    expect(screen.getAllByRole('link', { name: /Ops/ })).toHaveLength(1)
    expect(botsStore.getState().bots).toHaveLength(3)
  })
})
