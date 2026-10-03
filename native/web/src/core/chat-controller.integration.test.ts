// @vitest-environment node
/**
 * The chat controller against the fake gateway in cookie mode, black-box: the
 * page signs in, boots, connects (`connectGateway`) and runs its chats
 * (`connectChats`) over the runtime's own `WebSocket`, with the page's real
 * frame source (in Node, where there is no `requestAnimationFrame`, its 16 ms
 * stand-in). Every assertion reads the COMMITTED store, the one a screen
 * subscribes to, so each one also proves the frame got there.
 *
 * What it proves (plan W-7b): a chat with 1000 rows of back-history opens on
 * the REST tail and pages back to its first row; a scripted turn streams in;
 * a send goes out and its reply lands once; an interrupt stops a running
 * reply; an approval and a clarify raised through `/__fake/request` are
 * answered on their own reply frames; and a socket dropped mid-turn costs
 * neither a duplicate nor a lost item.
 */
import { type FakeGateway, startFakeGateway } from '@hermie/fake-gateway'
import type { AssistantItem, ChatState, ClarifyItem, TranscriptItem, UserItem } from '@hermie/transcript'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { APP_DOCUMENT_PATH, deriveBasePath, type ResolvedBasePath } from '../boot/base-path'
import { boot } from '../boot/boot'
import { MemoryChatCache } from '../platform/chat-cache'
import { createKeyValueStore } from '../platform/key-value-store'
import { createBotsStore } from '../state/bots'
import { createChatsStore } from '../state/chats'
import { createConnectionStore } from '../state/connection'
import { createPluginStore } from '../state/plugin'
import { browserFetch } from '../test-support/browser-fetch'
import { fakeNetwork, fakeVisibility } from '../test-support/fake-watchers'
import { type ChatRuntime, connectChats } from './chat-controller'
import { createOwnAuthorStore } from './chats/own-author'
import { connectGateway, type GatewayClient } from './gateway-client'

const HISTORY_ROWS = 1000

/** A reply long enough to interrupt, or to drop the socket in the middle of. */
const SLOW_DELTAS = Array.from({ length: 40 }, (_, index) => `Part ${index + 1}. `)

const SCENARIO = {
  replies: [
    {
      match: 'scripted',
      deltas: ['Reading ', 'the file. ', 'It says ', 'hello.'],
      toolAfterDeltas: 2,
      tool: { name: 'read_file', args: { path: 'notes.txt' }, summary: 'read notes.txt', result: 'hello' }
    },
    { match: 'slowly', deltas: SLOW_DELTAS }
  ]
}

interface FakeState {
  openSockets: number
  connections: number
  serverRequestAnswers: { id: string; method: string; result?: Record<string, unknown> }[]
  runningSessions: string[]
  eventsSinceCalls: { session_id: string; last_seen: number }[]
}

const gateways: FakeGateway[] = []
const pages: { client: GatewayClient; chats: ChatRuntime }[] = []

afterEach(async () => {
  while (pages.length) {
    const page = pages.pop()

    page?.chats.stop()
    page?.client.stop()
  }

  while (gateways.length) {
    await gateways.pop()?.close()
  }
})

const fakeState = async (gateway: FakeGateway): Promise<FakeState> =>
  (await (await fetch(`${gateway.url}/__fake/state`)).json()) as FakeState

const control = async (gateway: FakeGateway, path: string, body: unknown = {}): Promise<Response> =>
  fetch(`${gateway.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })

const waitFor = <T>(check: () => T | Promise<T>, timeout = 8_000): Promise<T> =>
  vi.waitFor(check, { timeout, interval: 20 })

/** A signed-in page on a fresh cookie-mode fake, connected and running its chats. */
async function chatPage(options: { streamDelayMs?: number } = {}) {
  const gateway = await startFakeGateway({
    port: 0,
    host: '127.0.0.1',
    auth: 'cookie',
    historyRows: HISTORY_ROWS,
    scenario: SCENARIO,
    streamDelayMs: options.streamDelayMs ?? 2
  })
  gateways.push(gateway)

  const basePath = deriveBasePath({ origin: new URL(gateway.url).origin, pathname: APP_DOCUMENT_PATH })

  if (!basePath.ok) {
    throw new Error('the fake gateway’s address is not a client path')
  }

  const browser = browserFetch(new URL(gateway.url).origin)
  const signIn = await browser.fetch(`${gateway.url}/auth/password-login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'tester', password: 'hunter2', next: APP_DOCUMENT_PATH })
  })

  expect(signIn.status).toBe(200)

  const state = await boot(basePath, { fetchImpl: browser.fetch })

  if (state.kind !== 'signed_in') {
    throw new Error(`expected signed_in, got ${state.kind}`)
  }

  const visibility = fakeVisibility('visible')
  const stores = { connection: createConnectionStore(), bots: createBotsStore(), plugin: createPluginStore() }
  const cache = new MemoryChatCache()
  const client = connectGateway({
    baseUrl: (basePath as ResolvedBasePath).baseUrl,
    credentials: state.session.credentials,
    fetchImpl: browser.fetch,
    storage: createKeyValueStore({ namespace: basePath.namespace, storage: null }),
    cache,
    visibility,
    network: fakeNetwork(true),
    stores,
    tuning: { backoffDelayMs: () => 50 }
  })
  const chats = connectChats({
    client,
    chats: createChatsStore(),
    cache,
    author: state.author,
    ownAuthor: createOwnAuthorStore(),
    visibility
  })

  pages.push({ client, chats })

  await waitFor(() => expect(stores.bots.getState().byName.researcher?.canonical?.id).toBeTruthy())

  const bot = stores.bots.getState().byName.researcher!

  await chats.controller.openChat(bot)

  const chat = (): ChatState => {
    const current = chats.chats.getState().chats.researcher

    if (!current) {
      throw new Error('the researcher’s chat is not open')
    }

    return current
  }

  return { gateway, client, chats, stores, bot, browser, chat }
}

const itemsOf = (chat: ChatState): TranscriptItem[] =>
  chat.order.map(id => chat.items[id]).filter((item): item is TranscriptItem => Boolean(item))

const usersSaying = (chat: ChatState, text: string): UserItem[] =>
  itemsOf(chat).filter((item): item is UserItem => item.kind === 'user' && item.text === text)

const assistants = (chat: ChatState): AssistantItem[] =>
  itemsOf(chat).filter((item): item is AssistantItem => item.kind === 'assistant')

/** The newest item of a kind, by request id, whatever the store holds for it. */
const requestItem = (chat: ChatState, kind: 'approval' | 'clarify'): TranscriptItem | undefined =>
  itemsOf(chat)
    .reverse()
    .find(item => item.kind === kind)

describe('the chat controller against the fake gateway (cookie mode)', () => {
  it('opens a chat with 1000 rows of history on the REST tail and pages back to the first row', async () => {
    const { chats, chat, bot } = await chatPage()
    const total = bot.canonical?.messageCount ?? 0

    expect(total).toBeGreaterThan(HISTORY_ROWS)

    // The tail is on screen at once: not the thousand rows, the newest page.
    await waitFor(() => expect(chat().hydration).toBe('live'))

    /*
      The back-history is a cycle of four rows (`historyRows` in the fake): a
      numbered question, a numbered answer, a code block and a tool call. The
      numbered ones are what make "every row once" checkable: the questions
      are 1, 5, 9, ... 997, and each must be in the transcript exactly once.
    */
    const questions = () =>
      itemsOf(chat())
        .filter((item): item is UserItem => item.kind === 'user' && /^Question \d+:/u.test(item.text))
        .map(item => Number(/^Question (\d+):/u.exec(item.text)?.[1]))
    const expected = Array.from({ length: HISTORY_ROWS / 4 }, (_, index) => index * 4 + 1)
    const opened = questions().length
    const newest = chat().order.at(-1)

    // Only the newest page is read on open, not the thousand rows.
    expect(opened).toBeGreaterThan(0)
    expect(opened).toBeLessThan(expected.length)

    let outcome: string = 'grew'

    for (let pages = 0; outcome === 'grew' && pages < 20; pages += 1) {
      outcome = await chats.controller.loadOlder('researcher')
    }

    expect(outcome).toBe('start')
    await waitFor(() => {
      // From the first to the newest, oldest first, nothing twice, nothing missing.
      expect(questions()).toEqual(expected)
      expect(new Set(chat().order).size).toBe(chat().order.length)
    })
    // Paging went in at the front: the newest item is still the last one.
    expect(chat().order.at(-1)).toBe(newest)
  })

  it('streams a scripted turn, sends, and lands the reply once', async () => {
    const { chats, chat } = await chatPage()

    await chats.controller.send('researcher', 'Run the scripted turn.')

    await waitFor(() => {
      expect(chat().turn.active).toBe(false)
      expect(assistants(chat()).some(item => item.text.endsWith('hello.'))).toBe(true)
    })

    // The tool sits inside the turn, after the prompt.
    const items = itemsOf(chat())
    const prompt = items.findIndex(item => item.kind === 'user' && item.text === 'Run the scripted turn.')
    const tool = items.findIndex((item, index) => index > prompt && item.kind === 'tool' && item.name === 'read_file')

    expect(prompt).toBeGreaterThanOrEqual(0)
    expect(tool).toBeGreaterThan(prompt)
    expect(usersSaying(chat(), 'Run the scripted turn.')).toHaveLength(1)

    // A second send is an ordinary turn on the default scenario.
    await chats.controller.send('researcher', 'And another.')
    await waitFor(() => {
      expect(chat().turn.active).toBe(false)
      expect(usersSaying(chat(), 'And another.')).toHaveLength(1)
    })
    expect(usersSaying(chat(), 'Run the scripted turn.')).toHaveLength(1)
  })

  it('interrupts a running reply with session.interrupt', async () => {
    const { gateway, chats, chat } = await chatPage({ streamDelayMs: 25 })

    await chats.controller.send('researcher', 'Answer slowly, please.')
    await waitFor(() => expect(assistants(chat()).some(item => item.streaming && item.text.length > 0)).toBe(true))

    await chats.controller.stopTurn('researcher')

    await waitFor(async () => {
      expect(chat().turn.active).toBe(false)
      expect((await fakeState(gateway)).runningSessions).toEqual([])
    })

    const reply = assistants(chat()).find(item => item.text.startsWith('Part 1.'))

    expect(reply).toMatchObject({ status: 'interrupted', streaming: false })
    // Stopped part-way: the rest of the reply never came.
    expect(reply?.text).not.toContain(SLOW_DELTAS.at(-1)?.trim())
  })

  it('answers an approval raised through /__fake/request on its own reply frame', async () => {
    const { gateway, chats, chat } = await chatPage()

    const raised = await control(gateway, '/__fake/request', {
      profile: 'researcher',
      method: 'approval',
      params: { request_id: 'appr-raised', command: 'make clean', choices: ['once', 'deny'] }
    })

    expect(raised.status).toBe(200)
    await waitFor(() => expect(requestItem(chat(), 'approval')).toMatchObject({ state: 'open' }))

    const card = requestItem(chat(), 'approval')
    const requestId = Object.entries(chat().byRequestId).find(([, id]) => id === card?.id)?.[0] ?? ''

    await chats.controller.respondApproval('researcher', requestId, 'once')

    await waitFor(async () =>
      expect((await fakeState(gateway)).serverRequestAnswers).toContainEqual({
        id: requestId,
        method: 'approval',
        result: { choice: 'once' }
      })
    )
    await waitFor(() => expect(requestItem(chat(), 'approval')).toMatchObject({ state: 'answered', answer: 'once' }))
  })

  it('answers a clarify raised through /__fake/request on its own reply frame', async () => {
    const { gateway, chats, chat } = await chatPage()

    await control(gateway, '/__fake/request', {
      profile: 'researcher',
      method: 'clarify',
      params: { question: 'Which branch?', choices: ['main', 'next'] }
    })
    await waitFor(() => expect(requestItem(chat(), 'clarify')).toMatchObject({ state: 'open' }))

    const card = requestItem(chat(), 'clarify') as ClarifyItem
    const qid = card.questions[0]?.qid ?? ''

    await chats.controller.respondClarify('researcher', card.requestId, { [qid]: 'next' })

    await waitFor(async () =>
      expect((await fakeState(gateway)).serverRequestAnswers).toContainEqual({
        id: card.requestId,
        method: 'clarify',
        result: { answer: 'next' }
      })
    )
    await waitFor(() => expect(requestItem(chat(), 'clarify')).toMatchObject({ state: 'answered' }))
  })

  it('survives a socket dropped mid-turn with no duplicate and no lost item', async () => {
    const { gateway, client, chats, chat, browser } = await chatPage({ streamDelayMs: 25 })
    const prompt = 'Tell it slowly, please.'

    await chats.controller.send('researcher', prompt)
    await waitFor(() => expect(assistants(chat()).some(item => item.text.includes('Part 3.'))).toBe(true))

    const before = await fakeState(gateway)

    expect(((await (await control(gateway, '/__fake/drop-sockets')).json()) as { dropped: number }).dropped).toBe(1)

    // Back on a new socket, and the turn has finished on the gateway.
    await waitFor(async () => {
      const now = await fakeState(gateway)

      expect(now.connections).toBeGreaterThan(before.connections)
      expect(now.openSockets).toBe(1)
      expect(now.runningSessions).toEqual([])
      // The frames sent while the socket was down came back through the replay.
      expect(now.eventsSinceCalls.length).toBeGreaterThan(before.eventsSinceCalls.length)
      expect(now.eventsSinceCalls.at(-1)?.last_seen).toBeGreaterThan(0)
    })
    await waitFor(() => expect(client.stores.connection.getState().status).toBe('ready'))

    const full = SLOW_DELTAS.join('')

    await waitFor(() => {
      expect(chat().turn.active).toBe(false)
      expect(chat().hydration).toBe('live')
      expect(assistants(chat()).filter(item => item.text === full)).toHaveLength(1)
    })

    // The gateway's own record of the turn: the prompt and the whole reply.
    const response = await browser.fetch(
      `${gateway.url}/api/sessions/${encodeURIComponent(chat().resolvedSessionId)}/messages?limit=2&order=latest`
    )
    const body = (await response.json()) as { messages?: { role: string; content: string }[] }

    expect(body.messages?.map(row => [row.role, row.content])).toEqual([
      ['user', prompt],
      ['assistant', full]
    ])

    // And the transcript from the prompt on is exactly that: the prompt once,
    // the reply once and whole, no half-reply left beside it, nothing after.
    const items = itemsOf(chat())
    const from = items.findIndex(item => item.kind === 'user' && item.text === prompt)
    const turn = items.slice(from).map(item => [item.kind, 'text' in item ? item.text : ''])

    expect(turn).toEqual([
      ['user', prompt],
      ['assistant', full]
    ])
    expect(usersSaying(chat(), prompt)).toHaveLength(1)
    expect(new Set(chat().order).size).toBe(chat().order.length)
  })
})
