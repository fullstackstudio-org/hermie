/**
 * The Activity timeline through the app's own router: rows grouped by day and read as sentences, each a link to the
 * chat where it happened that leaves a request to scroll to the message; the counters; and each state said in words
 * (loading, failed with a way to try again, out of reach, nothing yet).
 */
import { type BotDmOutItem, type ChatState, createChatState, type TranscriptItem } from '@hermie/transcript'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { resetLocale, setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import type { ChatScreenController } from '../chat/chat-runtime'
import { findRequests } from '../search/find-request'
import { App } from '../shell/App'

const NOW = Math.floor(Date.now() / 1000)

function chatOf(bot: string, items: TranscriptItem[]): ChatState {
  const chat = createChatState(bot, `stored-${bot}`, `stored-${bot}`)

  for (const item of items) {
    chat.items[item.id] = item
    chat.order.push(item.id)
  }

  return chat
}

const dm = (id: string, at: number, patch: Partial<BotDmOutItem> = {}): BotDmOutItem => ({
  id,
  kind: 'bot_dm_out',
  seq: 1000,
  version: 1,
  origin: 'history',
  ts: at,
  toolId: id,
  target: '@writer',
  targetHandle: 'writer',
  message: 'Can you draft the announcement?',
  dispatch: { status: 'queued' },
  ...patch
})

function controller(over: Partial<Record<keyof ChatScreenController, unknown>> = {}) {
  return {
    openChat: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    loadActivity: vi.fn(async () => undefined),
    activeSubagentCount: vi.fn(async () => 2),
    inFlightDeliveries: vi.fn(async () => 1),
    ...over
  } as unknown as ChatScreenController
}

function mount(chat: ChatScreenController | undefined = controller()) {
  const router = createHashRouter(null)

  router.navigate('#/activity')
  render(
    <App
      user="Tester"
      onSignIn={() => {}}
      onSignOut={() => {}}
      router={router}
      {...(chat ? { chat: { controller: chat, gatewayBaseUrl: 'http://gateway.test' } } : {})}
    />
  )

  return { router }
}

const main = (): HTMLElement => screen.getByRole('main')

beforeEach(() => {
  resetShellStores()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Ada' }), aBot('writer', { displayName: 'Wren' })])
  document.documentElement.lang = 'en'
})

afterEach(() => {
  resetLocale()
  resetActiveLocale()
  findRequests.request('x', '')
})

describe('the timeline', () => {
  it('groups rows by day, newest first, and reads each as a sentence with its status', async () => {
    chatsStore.setState({
      chats: {
        researcher: chatOf('researcher', [
          dm('dm-1', NOW - 120, { dispatch: { status: 'queued' } }),
          dm('dm-2', NOW - 3 * 86_400, {
            message: 'Which sources back the retry claim?',
            reply: { text: 'Two: the changelog and the long post.', ts: NOW - 3 * 86_400 + 60 }
          })
        ])
      }
    })
    mount()

    expect(await screen.findByRole('heading', { name: 'Today' })).toBeTruthy()

    const links = within(main()).getAllByRole('link', { name: /Ada|Wren/u })
    const texts = links.map(link => link.textContent)

    expect(texts[0]).toContain('Ada → Wren')
    expect(texts[0]).toContain('Can you draft the announcement?')
    expect(texts[0]).toContain('Queued')
    // The older exchange: the dispatch and the reply it got, the newest of the two first.
    expect(texts[1]).toContain('Wren ↩︎ Ada')
    expect(texts[1]).toContain('Two: the changelog and the long post.')
    expect(texts[2]).toContain('Which sources back the retry claim?')
    expect(texts[2]).toContain('Replied')
    expect(within(main()).getAllByRole('heading', { level: 2 }).length).toBe(2)
  })

  it('links a row to the chat where it happened and leaves a request for the message', async () => {
    chatsStore.setState({ chats: { researcher: chatOf('researcher', [dm('dm-1', NOW - 60)]) } })
    mount()

    const link = await screen.findByRole('link', { name: /Can you draft the announcement/u })

    expect(link.getAttribute('href')).toBe('#/chat/researcher')
    fireEvent.click(link)
    expect(findRequests.current()).toMatchObject({ bot: 'researcher', query: '"Can you draft the announcement?"' })
  })

  it('shows the counters: bots working from the roster, the other two from the gateway', async () => {
    botsStore.setState({ running: { researcher: true } })
    mount()

    await waitFor(() => expect(within(main()).getByText('2', { selector: '.hm-activity__counter-value' })).toBeTruthy())

    const counters = document.querySelectorAll('.hm-activity__counter')

    expect([...counters].map(counter => counter.textContent?.replace(/\s+/gu, ' '))).toEqual([
      '1 Bots working',
      '2 Sub-agents',
      '1 Deliveries out'
    ])
  })

  it('loads every bot’s recent tail once the connection is ready, and says it is loading until then', async () => {
    let finish = (): void => undefined
    const loading = controller({
      loadActivity: vi.fn(
        () =>
          new Promise<void>(resolve => {
            finish = resolve
          })
      )
    })

    mount(loading)

    expect(await within(main()).findByText('Reading every conversation…')).toBeTruthy()
    expect(loading.loadActivity).toHaveBeenCalledTimes(1)
    await act(async () => finish())
    await waitFor(() => expect(within(main()).getByText(/have not talked to each other yet/u)).toBeTruthy())
  })

  it('says it could not load, and tries again', async () => {
    const failing = controller({
      loadActivity: vi.fn().mockRejectedValueOnce(new Error('gateway said no')).mockResolvedValue(undefined)
    })

    mount(failing)

    const alert = await within(main()).findByRole('alert')

    expect(alert.textContent).toContain('The timeline could not be loaded: gateway said no')
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(within(main()).queryByRole('alert')).toBeNull())
    expect(failing.loadActivity).toHaveBeenCalledTimes(2)
  })

  it('says the gateway is out of reach, not that nothing happened', async () => {
    connectionStore.getState().setStatus('offline', null)
    mount()

    expect(await within(main()).findByText('Nothing to show while the gateway is out of reach.')).toBeTruthy()
    expect(within(main()).queryByText(/have not talked/u)).toBeNull()
  })

  it('speaks the language that is active', async () => {
    await act(async () => {
      await setLanguageChoice('nl')
    })
    chatsStore.setState({ chats: { researcher: chatOf('researcher', [dm('dm-1', NOW - 60)]) } })
    mount()

    expect(await screen.findByRole('heading', { name: 'Vandaag' })).toBeTruthy()
    expect(within(main()).getByText('In de wachtrij')).toBeTruthy()
  })

  it('reaches the page from the sidebar', () => {
    mount()
    expect(screen.getAllByRole('link', { name: 'Activity' })[0]?.getAttribute('href')).toBe('#/activity')
  })
})
