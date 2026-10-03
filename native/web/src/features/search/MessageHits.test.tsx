/**
 * The chats field: names at once, messages after a pause, and a hit that opens
 * the chat at the words.
 *
 * The REST client is a function per profile, so what the gateway was asked and
 * what it answered are both in the test.
 */
import type { SessionSearchHttp } from '@hermie/gateway-client'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { connectionStore } from '../../state/connection'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatList } from '../bots/ChatList'
import { ChatRuntimeContext, type ChatScreenController } from '../chat/chat-runtime'
import { createFindRequests, type FindRequests } from './find-request'
import { MessageHits } from './MessageHits'

/** A gateway that answers each profile from a table, and records every path it was asked. */
function searchGateway(answers: Record<string, unknown>) {
  const asked: string[] = []
  const http: SessionSearchHttp = {
    get: (async (path: string) => {
      asked.push(path)

      const profile = new URL(path, 'http://x').searchParams.get('profile') ?? ''

      return answers[profile] ?? { results: [] }
    }) as SessionSearchHttp['get']
  }

  return { http, asked }
}

const hit = (sessionId: string, snippet: string, at = 1_700_000_000) => ({
  results: [{ session_id: sessionId, snippet, last_active: at }]
})

function mountList(http: SessionSearchHttp | undefined) {
  render(
    <ChatRuntimeContext.Provider
      value={{ controller: {} as ChatScreenController, gatewayBaseUrl: 'http://gateway.test', sessionSearch: http }}
    >
      <ChatList selectedBot={undefined} />
    </ChatRuntimeContext.Provider>
  )
}

const field = (): HTMLInputElement => screen.getByRole('searchbox', { name: 'Search chats' })
const botRows = (): string[] =>
  [...document.querySelectorAll<HTMLAnchorElement>('a[data-bot]')].map(link => link.dataset.bot ?? '')

beforeEach(() => {
  resetShellStores()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Ada' }), aBot('writer'), aBot('ops')])
})

afterEach(() => {
  resetActiveLocale()
  vi.useRealTimers()
})

describe('the chats field', () => {
  it('narrows the list to the names that hold the words, at once', () => {
    mountList(undefined)

    fireEvent.change(field(), { target: { value: 'ad' } })
    expect(botRows()).toEqual(['researcher'])

    fireEvent.change(field(), { target: { value: 'writ' } })
    expect(botRows()).toEqual(['writer'])
  })

  it('says when no name matches, and Escape brings every row back', () => {
    mountList(undefined)

    fireEvent.change(field(), { target: { value: 'zzz' } })
    expect(botRows()).toEqual([])
    expect(screen.getByText('No conversation matches “zzz”.')).toBeTruthy()

    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(field().value).toBe('')
    expect(botRows()).toEqual(['researcher', 'writer', 'ops'])
  })

  it('searches every bot’s messages after a pause, and shows only the hits in their own chat', async () => {
    const gateway = searchGateway({
      researcher: hit('stored-researcher', 'the >>>invoice<<< is due'),
      // A hit in a session that is not the bot's chat (a cron run, a branch): dropped.
      writer: hit('cron-run-7', 'an >>>invoice<<< somewhere else')
    })

    mountList(gateway.http)
    fireEvent.change(field(), { target: { value: 'invoice' } })

    // Nothing is asked while the reader is still typing.
    expect(gateway.asked).toEqual([])

    const section = await screen.findByRole('region', { name: 'IN MESSAGES' })
    const link = await within(section).findByRole('link')

    expect(gateway.asked.map(path => new URL(path, 'http://x').searchParams.get('profile')).sort()).toEqual([
      'ops',
      'researcher',
      'writer'
    ])
    expect(link.getAttribute('href')).toBe('#/chat/researcher')
    expect(link.querySelector('bdi')?.textContent).toBe('Ada')
    expect(link.querySelector('mark')?.textContent).toBe('invoice')
    expect(link.querySelector('.hm-search-hit__snippet')?.textContent).toBe('the invoice is due')
    expect(within(section).getByRole('status').textContent).toBe('Only the best match per chat is shown.')
  })

  it('says when no message matches', async () => {
    const gateway = searchGateway({})

    mountList(gateway.http)
    fireEvent.change(field(), { target: { value: 'nothing-here' } })

    const section = await screen.findByRole('region', { name: 'IN MESSAGES' })

    await vi.waitFor(() => expect(within(section).getByRole('status').textContent).toBe('No messages match.'))
  })

  it('never shows the answer to words that are no longer in the field', async () => {
    vi.useFakeTimers()

    const asked: string[] = []
    // Answers with the words it was asked for, so a stale answer would show the old words.
    const http: SessionSearchHttp = {
      get: (async (path: string) => {
        const params = new URL(path, 'http://x').searchParams

        asked.push(params.get('q') ?? '')

        return params.get('profile') === 'researcher' ? hit('stored-researcher', `>>>${params.get('q')}<<<`) : {}
      }) as SessionSearchHttp['get']
    }

    mountList(http)
    fireEvent.change(field(), { target: { value: 'first' } })
    fireEvent.change(field(), { target: { value: 'second' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })

    // The search went out for the words in the field, and only for them.
    expect(new Set(asked)).toEqual(new Set(['second']))
    expect(document.querySelector('.hm-search-hit mark')?.textContent).toBe('second')
  })

  it('asks the gateway nothing while the connection is not ready', async () => {
    vi.useFakeTimers()
    connectionStore.getState().setStatus('reconnecting', null)

    const gateway = searchGateway({})

    mountList(gateway.http)
    fireEvent.change(field(), { target: { value: 'invoice' } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })

    expect(gateway.asked).toEqual([])
  })

  it('follows the language without a reload', async () => {
    mountList(undefined)
    await act(async () => {
      await setLanguageChoice('de')
    })

    expect(screen.getByRole('searchbox', { name: 'Chats durchsuchen' })).toBeTruthy()
  })
})

describe('a message hit', () => {
  it('leaves the words for the chat it opens, as it is followed', async () => {
    const requests: FindRequests = createFindRequests()
    const gateway = searchGateway({ researcher: hit('stored-researcher', '>>>invoice<<<') })

    render(
      <ChatRuntimeContext.Provider
        value={{
          controller: {} as ChatScreenController,
          gatewayBaseUrl: 'http://gateway.test',
          sessionSearch: gateway.http
        }}
      >
        <MessageHits query=" invoice " requests={requests} />
      </ChatRuntimeContext.Provider>
    )

    const link = await screen.findByRole('link')

    expect(requests.current()).toBeNull()
    fireEvent.click(link)
    expect(requests.current()).toMatchObject({ bot: 'researcher', query: 'invoice' })
  })
})
