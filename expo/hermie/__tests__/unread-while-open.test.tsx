/**
 * The badge beside a chat the reader is looking at.
 *
 * Reported: the chat list shows 1 unread for the chat that is OPEN, with the
 * transcript at the bottom and the message plainly on screen. The cause is not in
 * the arithmetic — `unreadCountSince` counts what is past the watermark, and the
 * watermark was only ever written twice: when the chat was opened and when it was
 * left. On a phone that is invisible, because a chat that is open has covered the
 * list. On the iPad and in a Mac window the two are side by side.
 *
 * Both halves of the rule are here, and the second one matters as much as the
 * first: a message that arrives while the reader is scrolled UP is unread, and
 * stays unread until they come back down to it. That is the same message the
 * jump-to-latest pill is counting, and the badge agreeing with the pill is the
 * whole point.
 *
 * The controller is a stand-in — everything past it is a socket — so the chat is
 * driven by dispatching the gateway's own events into the real store, which is
 * what a delivery actually is.
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native'

import { ChatScreen } from '../src/features/chats/ChatScreen'
import { lastMessageAt, unreadCountSince } from '@hermie/transcript'
import { countsAsRead, readWatermark } from '../src/features/chats/read-watermark'
import { type Bot, useBotsStore } from '../src/store/bots'
import { useChatsStore } from '../src/store/chats'
import { useSettingsStore } from '../src/store/settings'
import { renderScreen } from './support/render'

let mockRuntime: {
  controller: Record<string, jest.Mock>
  bots: Record<string, never>
  push: { setOpenChat: jest.Mock }
}

jest.mock('../src/gateway', () => ({
  useGateway: () => ({ config: { baseUrl: 'https://gateway.example.com' }, http: null, status: 'ready' })
}))

jest.mock('../src/features/chats/ChatRuntime', () => ({
  useChatRuntime: () => mockRuntime
}))

jest.mock('../src/platform/haptics', () => ({ haptic: jest.fn() }))

jest.mock('../src/features/chats/attachments', () => ({
  MAX_ATTACHMENT_EDGE: 1568,
  openAppSettings: jest.fn(),
  pickAttachment: jest.fn(async () => null)
}))

const BOT: Bot = {
  name: 'researcher',
  displayName: 'Researcher',
  description: 'Finds things out.',
  model: 'example-provider/example-model',
  provider: 'example-provider',
  isDefault: false,
  hasAvatar: false,
  uiMetaRevision: 0,
  canonical: {
    id: 'stored-researcher',
    resolvedId: 'stored-researcher',
    preview: 'hello',
    lastActive: 1,
    messageCount: 2
  }
}

/** Everything the screen calls; none of it matters to this file but `openChat`. */
function makeController(): Record<string, jest.Mock> {
  const noop = () => jest.fn(async () => undefined)

  return {
    acknowledgeApproval: noop(),
    closeChat: noop(),
    readKeyFor: (name: string) => name,
    deleteQueued: jest.fn(),
    editQueued: jest.fn(() => ''),
    interruptSubagent: jest.fn(async () => true),
    knowsSlashCommand: jest.fn(() => false),
    lockClarify: noop(),
    modelOptions: jest.fn(async () => []),
    openChat: noop(),
    querySlash: jest.fn(async () => ({ items: [] })),
    refreshOptions: jest.fn(async () => null),
    respondApproval: noop(),
    respondClarify: noop(),
    runSlash: noop(),
    send: noop(),
    setOption: jest.fn(async () => ({})),
    steerQueued: jest.fn(async () => 'queued'),
    steerSubagent: jest.fn(async () => 'ok'),
    stopTurn: noop(),
    tailSubagent: jest.fn(async () => '')
  }
}

/** A reply lands in the chat — the same event a live delivery is. */
function deliver(text: string) {
  act(() => {
    useChatsStore.getState().dispatchEvent('researcher', {
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text, status: 'ok' }
    })
  })
}

/** Scroll the inverted transcript; offset 0 is the bottom. */
function scrollTo(offset: number) {
  act(() => {
    fireEvent.scroll(screen.getByTestId('transcript-list-scroll'), {
      nativeEvent: {
        contentInset: { bottom: 0, left: 0, right: 0, top: 0 },
        contentOffset: { x: 0, y: offset },
        contentSize: { height: 4000, width: 402 },
        layoutMeasurement: { height: 800, width: 402 }
      }
    })
  })
}

/** What the chat list would draw beside this row. */
function badge(): number {
  const chat = useChatsStore.getState().chats.researcher

  return chat ? unreadCountSince(chat, useBotsStore.getState().lastSeen.researcher ?? 0) : 0
}

beforeEach(() => {
  mockRuntime = { bots: {}, controller: makeController(), push: { setOpenChat: jest.fn() } }
  useBotsStore.getState().reset()
  useChatsStore.getState().reset()
  useSettingsStore.getState().reset()
  useBotsStore.getState().setBots([BOT])

  const chats = useChatsStore.getState()

  chats.ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'stored-researcher' })
  chats.bindRuntime('researcher', 'runtime-1')
})

describe('a chat that is open, with the reader at the bottom', () => {
  it('counts a message that arrives in front of the reader as read', async () => {
    renderScreen(<ChatScreen bot="researcher" />)
    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    deliver('Here is what I found.')

    await waitFor(() => expect(screen.getByText('Here is what I found.')).toBeTruthy())
    expect(badge()).toBe(0)
  })

  it('keeps counting zero across several deliveries, not only the first', async () => {
    renderScreen(<ChatScreen bot="researcher" />)
    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    deliver('One.')
    await waitFor(() => expect(badge()).toBe(0))
    deliver('Two.')
    await waitFor(() => expect(badge()).toBe(0))
    deliver('Three.')
    await waitFor(() => expect(badge()).toBe(0))
  })
})

describe('a chat that is open, with the reader scrolled up', () => {
  it('counts a message that arrives behind the reader', async () => {
    renderScreen(<ChatScreen bot="researcher" />)
    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    scrollTo(900)
    deliver('You missed this one.')

    await waitFor(() => expect(screen.getByText('You missed this one.')).toBeTruthy())
    expect(badge()).toBe(1)
  })

  it('clears it when the reader comes back down to the bottom', async () => {
    renderScreen(<ChatScreen bot="researcher" />)
    await waitFor(() => expect(screen.getByTestId('chat-header')).toBeTruthy())

    scrollTo(900)
    deliver('You missed this one.')
    await waitFor(() => expect(badge()).toBe(1))

    scrollTo(0)

    await waitFor(() => expect(badge()).toBe(0))
  })
})

describe('the two halves of the rule, on their own', () => {
  it('reads a chat only when it is open AND at the bottom', () => {
    expect(countsAsRead({ away: false, open: true })).toBe(true)
    expect(countsAsRead({ away: true, open: true })).toBe(false)
    expect(countsAsRead({ away: false, open: false })).toBe(false)
    expect(countsAsRead({ away: true, open: false })).toBe(false)
  })

  it('writes the later of the two clocks, so a gateway running ahead cannot relight it', () => {
    expect(readWatermark(1_700_000_000, 1_700_000_050)).toBe(1_700_000_050)
    expect(readWatermark(1_700_000_000, 0)).toBe(1_700_000_000)
  })

  it('finds the newest message and ignores the turn that is still in progress', () => {
    const chats = useChatsStore.getState()

    chats.dispatchEvent('researcher', {
      type: 'message.complete',
      session_id: 'runtime-1',
      payload: { text: 'Settled.', status: 'ok' }
    })

    const settled = useChatsStore.getState().chats.researcher!
    const at = lastMessageAt(settled)

    expect(at).toBeGreaterThan(0)
    // Nothing past the watermark it names, which is the property the badge needs.
    expect(unreadCountSince(settled, at)).toBe(0)
  })
})
