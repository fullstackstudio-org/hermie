import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { pluginStore } from '../../state/plugin'
import { settingsStore } from '../../state/settings'
import { aBot, LONG_AGO, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatList } from './ChatList'

beforeEach(() => {
  resetShellStores()
  connectionStore.getState().setStatus('ready', null)
})

afterEach(() => {
  resetActiveLocale()
})

/** The stamp of `LONG_AGO`, in this machine's zone. */
const LONG_AGO_STAMP = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'short' }).format(LONG_AGO * 1000)

const rows = (): HTMLAnchorElement[] => screen.getAllByRole('link') as HTMLAnchorElement[]
const row = (name: string): HTMLElement => document.querySelector<HTMLElement>(`a[data-bot="${name}"]`)!

describe('the chat list', () => {
  it('shows each bot as a link to its chat, in the roster’s order', () => {
    seedRoster([aBot('researcher'), aBot('writer'), aBot('ops-bot')])
    render(<ChatList selectedBot={undefined} />)

    expect(rows().map(link => link.getAttribute('href'))).toEqual([
      '#/chat/researcher',
      '#/chat/writer',
      '#/chat/ops-bot'
    ])
    expect(within(row('researcher')).getByText('Researcher')).toBeTruthy()
  })

  it('encodes a bot name in its link', () => {
    seedRoster([aBot('a/b c', { displayName: 'Slash bot' })])
    render(<ChatList selectedBot={undefined} />)

    expect(rows()[0]?.getAttribute('href')).toBe('#/chat/a%2Fb%20c')
  })

  it('marks the open chat’s row as the current page', () => {
    seedRoster([aBot('researcher'), aBot('writer')])
    render(<ChatList selectedBot="writer" />)

    expect(row('writer').getAttribute('aria-current')).toBe('page')
    expect(row('researcher').hasAttribute('aria-current')).toBe(false)
  })

  describe('the two names of a bot', () => {
    afterEach(() => settingsStore.getState().reset())

    const names = (bot: string): { name: string | undefined; alt: string | undefined } => ({
      name: row(bot).querySelector('.hm-row__name')?.textContent ?? undefined,
      alt: row(bot).querySelector('.hm-row__alt')?.textContent ?? undefined
    })

    it('shows a named bot by its name alone by default, as before there was a setting', () => {
      seedRoster([aBot('lance-vance', { displayName: 'Netwerkbeheerder' }), aBot('scout')])
      render(<ChatList selectedBot={undefined} />)

      expect(names('lance-vance')).toEqual({ name: 'Netwerkbeheerder', alt: undefined })
      expect(names('scout')).toEqual({ name: 'Scout', alt: undefined })
    })

    it('draws the other name under it when the profile name is not hidden, and swaps them with the order', () => {
      seedRoster([aBot('lance-vance', { displayName: 'Netwerkbeheerder' }), aBot('scout')])
      settingsStore.getState().setHideHandleWhenNamed(false)
      render(<ChatList selectedBot={undefined} />)

      expect(names('lance-vance')).toEqual({ name: 'Netwerkbeheerder', alt: 'lance-vance' })
      // A bot with one name has one line, whatever is set.
      expect(names('scout')).toEqual({ name: 'Scout', alt: undefined })

      act(() => settingsStore.getState().setBotNameOrder('profile'))
      expect(names('lance-vance')).toEqual({ name: 'lance-vance', alt: 'Netwerkbeheerder' })
    })

    it('says both names to a screen reader, as the row’s own words', () => {
      seedRoster([aBot('lance-vance', { displayName: 'Netwerkbeheerder' })])
      settingsStore.getState().setHideHandleWhenNamed(false)
      render(<ChatList selectedBot={undefined} />)

      expect(row('lance-vance').textContent).toContain('Netwerkbeheerder')
      expect(row('lance-vance').textContent).toContain('lance-vance')
    })
  })

  describe('what a row says', () => {
    it('is the display name, the gateway’s last preview and the time of the last activity', () => {
      seedRoster([aBot('researcher', { canonical: { ...aBot('x').canonical!, preview: 'Found three sources.' } })])
      render(<ChatList selectedBot={undefined} />)

      expect(within(row('researcher')).getByText('Found three sources.')).toBeTruthy()
      // Long ago: a date.
      expect(row('researcher').querySelector('.hm-row__time')?.textContent).toBe(LONG_AGO_STAMP)
    })

    it('cleans and isolates the bot’s own name: no invisible or direction-override characters, bounded, in a bdi', () => {
      seedRoster([
        aBot('evil', { displayName: '\u202EEvil\u2060\u2066 name\u2069' }),
        aBot('long', { displayName: 'x'.repeat(500) }),
        aBot('ghost', { displayName: '\u2060\u202E' })
      ])
      render(<ChatList selectedBot={undefined} />)

      const nameOf = (bot: string): Element | null => row(bot).querySelector('.hm-row__name > bdi')

      expect(nameOf('evil')?.textContent).toBe('Evil name')
      expect(nameOf('long')?.textContent?.length).toBeLessThan(500)
      expect(nameOf('long')?.textContent?.endsWith('…')).toBe(true)
      // Nothing left to show: the route name.
      expect(nameOf('ghost')?.textContent).toBe('ghost')
    })

    it('prefers the last real message of the open transcript to the gateway’s string', () => {
      seedRoster([aBot('researcher', { canonical: { ...aBot('x').canonical!, preview: 'old gateway text' } })])
      chatsStore.getState().ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'x' })
      chatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'message.complete', seq: 1, payload: { text: 'Fresh **reply**.' } })
      render(<ChatList selectedBot={undefined} />)

      // Markdown is taken off: a list row is one plain line.
      expect(within(row('researcher')).getByText('Fresh reply.')).toBeTruthy()
      expect(screen.queryByText('old gateway text')).toBeNull()
    })

    it('never shows a [System: ...] wrapper as if somebody said it', () => {
      seedRoster([
        aBot('researcher', {
          canonical: { ...aBot('x').canonical!, preview: '[System: The active model is now fast. Carry on.]' }
        })
      ])
      render(<ChatList selectedBot={undefined} />)

      const line = row('researcher').querySelector('.hm-row__preview')

      expect(line?.textContent).not.toContain('[System')
      expect(line?.getAttribute('data-system')).toBe('true')
    })

    it('falls back to the description, then to "No messages yet"', () => {
      seedRoster([
        aBot('researcher', { description: 'Reads papers' }),
        aBot('writer', { canonical: { ...aBot('x').canonical!, lastActive: 0 } })
      ])
      render(<ChatList selectedBot={undefined} />)

      expect(within(row('researcher')).getByText('Reads papers')).toBeTruthy()
      expect(within(row('writer')).getByText('No messages yet')).toBeTruthy()
      expect(row('writer').querySelector('.hm-row__time')).toBeNull()
    })

    it('shows the initial of a bot with no picture, and the picture of one that has it', () => {
      seedRoster([aBot('researcher'), aBot('writer', { hasAvatar: true })])
      botsStore.getState().setAvatar('writer', 0, 'data:image/png;base64,AAAA')
      render(<ChatList selectedBot={undefined} />)

      expect(row('researcher').querySelector('.hm-avatar')?.textContent).toBe('R')
      expect(row('researcher').querySelector('img')).toBeNull()
      expect(row('writer').querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
      // The picture is decoration: the row names the bot in text.
      expect(row('writer').querySelector('img')?.getAttribute('alt')).toBe('')
    })

    it('falls back to the initial when a picture does not load', () => {
      seedRoster([aBot('writer', { hasAvatar: true })])
      botsStore.getState().setAvatar('writer', 0, 'data:image/png;base64,broken')
      render(<ChatList selectedBot={undefined} />)

      fireEvent.error(row('writer').querySelector('img')!)

      expect(row('writer').querySelector('img')).toBeNull()
      expect(row('writer').querySelector('.hm-avatar')?.textContent).toBe('W')
    })
  })

  describe('unread', () => {
    it('marks a chat that moved since it was last seen, and says so in words', () => {
      seedRoster([aBot('researcher'), aBot('writer')], { read: false })
      botsStore.getState().markSeen('writer', LONG_AGO)
      render(<ChatList selectedBot={undefined} />)

      expect(row('researcher').getAttribute('data-unread')).toBe('true')
      expect(row('writer').getAttribute('data-unread')).toBe('false')
      expect(row('researcher').querySelector('.hm-badge')).not.toBeNull()
      expect(row('writer').querySelector('.hm-badge')).toBeNull()
      expect(within(row('researcher')).getByText(/New/)).toBeTruthy()
    })

    it('counts the messages in the open transcript past the watermark', () => {
      seedRoster([aBot('researcher')])
      chatsStore.getState().ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'x' })
      // `ts` is what the engine stamps; a message after the watermark counts.
      const arrived = Math.floor(Date.now() / 1000)

      chatsStore.getState().dispatchEvent('researcher', { type: 'message.complete', seq: 1, payload: { text: 'One.' } })
      botsStore.setState({ lastSeen: { researcher: LONG_AGO } })
      render(<ChatList selectedBot={undefined} />)

      expect(arrived).toBeGreaterThan(LONG_AGO)
      expect(row('researcher').getAttribute('data-unread')).toBe('true')
      expect(row('researcher').querySelector('.hm-badge')?.textContent).toBe('1')
      expect(within(row('researcher')).getByText(/1 unread message/)).toBeTruthy()
    })
  })

  describe('presence', () => {
    const presenceOf = (name: string): string | null | undefined =>
      row(name).querySelector('.hm-bead')?.getAttribute('data-state')

    it('is online when the gateway is up and the bot is idle', () => {
      seedRoster([aBot('researcher')])
      render(<ChatList selectedBot={undefined} />)

      expect(presenceOf('researcher')).toBe('online')
      expect(within(row('researcher')).getByText(/Online/)).toBeTruthy()
    })

    it('is working while the roster says a session of the bot is busy', () => {
      seedRoster([aBot('researcher'), aBot('writer')])
      botsStore.getState().setRunning(['researcher'])
      render(<ChatList selectedBot={undefined} />)

      expect(presenceOf('researcher')).toBe('working')
      expect(presenceOf('writer')).toBe('online')
    })

    it('is working while a turn streams in the open chat', () => {
      seedRoster([aBot('researcher')])
      chatsStore.getState().ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'x' })
      chatsStore.getState().dispatchEvent('researcher', { type: 'message.start', seq: 1, payload: {} })
      render(<ChatList selectedBot={undefined} />)

      expect(presenceOf('researcher')).toBe('working')
    })

    it('needs input while an approval is open, which outranks working', () => {
      seedRoster([aBot('researcher')])
      botsStore.getState().setRunning(['researcher'])
      chatsStore.getState().ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'x' })
      chatsStore.getState().dispatchServerRequest('researcher', {
        id: 'srq-1',
        method: 'approval',
        params: { request_id: 'a1', command: 'ls', choices: ['once', 'deny'] }
      })
      render(<ChatList selectedBot={undefined} />)

      expect(presenceOf('researcher')).toBe('needsInput')
      expect(within(row('researcher')).getByText(/Needs input/)).toBeTruthy()
    })

    it('is offline when the gateway is not ready, and says when the bot was last heard from instead of a stale preview', () => {
      seedRoster([aBot('researcher', { canonical: { ...aBot('x').canonical!, preview: 'Stale words.' } })])
      connectionStore.getState().setStatus('reconnecting', null)
      render(<ChatList selectedBot={undefined} />)

      expect(presenceOf('researcher')).toBe('offline')
      expect(screen.queryByText('Stale words.')).toBeNull()
      expect(row('researcher').querySelector('.hm-row__preview')?.textContent).toBe(
        `Offline · last seen ${LONG_AGO_STAMP}`
      )
    })

    it('is offline for a bot with no session to talk to', () => {
      seedRoster([aBot('researcher', { canonical: undefined as never })])
      render(<ChatList selectedBot={undefined} />)

      expect(presenceOf('researcher')).toBe('offline')
    })

    it('follows the connection as it changes', () => {
      seedRoster([aBot('researcher')])
      render(<ChatList selectedBot={undefined} />)

      expect(presenceOf('researcher')).toBe('online')

      act(() => connectionStore.getState().setStatus('offline', null))

      expect(presenceOf('researcher')).toBe('offline')
    })
  })

  describe('keyboard', () => {
    beforeEach(() => {
      seedRoster([aBot('researcher'), aBot('writer'), aBot('ops')])
    })

    it('is one tab stop: the first row, or the open chat’s', () => {
      const { unmount } = render(<ChatList selectedBot={undefined} />)

      expect(rows().map(link => link.tabIndex)).toEqual([0, -1, -1])
      unmount()
      render(<ChatList selectedBot="writer" />)

      expect(rows().map(link => link.tabIndex)).toEqual([-1, 0, -1])
    })

    it('moves between rows with the arrow keys, Home and End, and the tab stop follows', () => {
      render(<ChatList selectedBot={undefined} />)
      row('researcher').focus()

      fireEvent.keyDown(row('researcher'), { key: 'ArrowDown' })
      expect(document.activeElement).toBe(row('writer'))
      expect(rows().map(link => link.tabIndex)).toEqual([-1, 0, -1])

      fireEvent.keyDown(row('writer'), { key: 'ArrowDown' })
      expect(document.activeElement).toBe(row('ops'))

      // Past the end stays on the end; it does not wrap and it does not leave the list.
      fireEvent.keyDown(row('ops'), { key: 'ArrowDown' })
      expect(document.activeElement).toBe(row('ops'))

      fireEvent.keyDown(row('ops'), { key: 'ArrowUp' })
      expect(document.activeElement).toBe(row('writer'))

      fireEvent.keyDown(row('writer'), { key: 'Home' })
      expect(document.activeElement).toBe(row('researcher'))

      fireEvent.keyDown(row('researcher'), { key: 'End' })
      expect(document.activeElement).toBe(row('ops'))
    })

    it('does not take a key it has no use for, or one with a modifier', () => {
      render(<ChatList selectedBot={undefined} />)
      row('researcher').focus()

      expect(fireEvent.keyDown(row('researcher'), { key: 'a' })).toBe(true)
      expect(fireEvent.keyDown(row('researcher'), { key: 'ArrowDown', metaKey: true })).toBe(true)
      expect(document.activeElement).toBe(row('researcher'))
      expect(fireEvent.keyDown(row('researcher'), { key: 'ArrowDown' })).toBe(false)
    })

    it('opens a chat the way any link does: the address changes to its route', async () => {
      window.history.replaceState(null, '', '/')
      render(<ChatList selectedBot={undefined} />)

      // Enter on a focused link is a click; jsdom follows a fragment link on click.
      const changed = new Promise(resolve => window.addEventListener('hashchange', resolve, { once: true }))

      fireEvent.click(row('writer'))
      await changed

      expect(window.location.hash).toBe('#/chat/writer')
      window.history.replaceState(null, '', '/')
    })

    it('keeps the tab stop where it was if its row goes away', () => {
      render(<ChatList selectedBot={undefined} />)
      row('writer').focus()
      act(() => seedRoster([aBot('researcher'), aBot('ops')]))

      expect(rows().map(link => link.tabIndex)).toEqual([0, -1])
    })
  })

  describe('before there is a list', () => {
    it('says the roster is being read until it has been', () => {
      render(<ChatList selectedBot={undefined} />)

      expect(screen.getByRole('status').textContent).toBe('Reading the roster…')
    })

    it('says there are no bots when the gateway lists none', () => {
      botsStore.getState().setBots([])
      render(<ChatList selectedBot={undefined} />)

      expect(screen.getByText(/no bot profiles yet/)).toBeTruthy()
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('says the roster could not be read, with the reason', () => {
      botsStore.getState().setError('gateway not connected')
      render(<ChatList selectedBot={undefined} />)

      expect(screen.getByRole('alert').textContent).toContain('gateway not connected')
    })

    it('keeps the list it has when a later read fails', () => {
      seedRoster([aBot('researcher')])
      botsStore.getState().setError('boom')
      render(<ChatList selectedBot={undefined} />)

      expect(screen.queryByRole('alert')).toBeNull()
      expect(rows()).toHaveLength(1)
    })
  })

  describe('the plugin hint', () => {
    it('is shown when the gateway has no Hermie plugin, and the list still works', () => {
      seedRoster([aBot('researcher')])
      pluginStore.getState().apply(null)
      render(<ChatList selectedBot={undefined} />)

      expect(screen.getByText(/no Hermie plugin/)).toBeTruthy()
      expect(rows()).toHaveLength(1)
    })

    it('says nothing before a roster has been read, which is not the same as "not installed"', () => {
      seedRoster([aBot('researcher')])
      render(<ChatList selectedBot={undefined} />)

      expect(screen.queryByText(/no Hermie plugin/)).toBeNull()
    })

    it('says nothing when the plugin is there', () => {
      seedRoster([aBot('researcher')])
      pluginStore.getState().apply({
        v: 1,
        version: '0.5.0',
        capabilities: [],
        modules: {},
        limits: {},
        relayOrigins: [],
        web: null,
        webPush: null
      } as never)
      render(<ChatList selectedBot={undefined} />)

      expect(screen.queryByText(/no Hermie plugin/)).toBeNull()
    })
  })

  it('speaks the reader’s language, and follows a switch without remounting', async () => {
    seedRoster([aBot('researcher', { canonical: { ...aBot('x').canonical!, lastActive: 0 } })])
    render(<ChatList selectedBot={undefined} />)

    expect(screen.getByText('No messages yet')).toBeTruthy()

    const before = row('researcher')

    await act(async () => {
      await setLanguageChoice('nl')
    })

    expect(screen.queryByText('No messages yet')).toBeNull()
    expect(row('researcher').querySelector('.hm-row__preview')?.textContent).toBe('Nog geen berichten')
    // The same element: nothing was remounted.
    expect(row('researcher')).toBe(before)
  })
})
