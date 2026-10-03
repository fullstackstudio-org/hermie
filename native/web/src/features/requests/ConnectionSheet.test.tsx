/**
 * What the gateway says beside the transcript, as the page draws it: a connector
 * authorisation as a sheet in the request layer (its rows, its links and where they
 * go, its countdown, its answers), the gateway's notices over the page, a chat's
 * resume progress line and the sidebar's identity line. The models are the real
 * ones on the page's stores, driven by session signals.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SessionSignal } from '../../core/chat-controller'
import { ConnectionsModel } from '../../core/connections'
import { NoticesModel } from '../../core/notices'
import { SessionStatusModel } from '../../core/session-status'
import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { connectionsStore } from '../../state/connections'
import { connectionStore } from '../../state/connection'
import { noticesStore } from '../../state/notices'
import { bindRequests, requestsStore } from '../../state/requests'
import { sessionStatusStore } from '../../state/session-status'
import { chatWith } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { IdentityNote } from '../notices/IdentityNote'
import { ResumeProgressLine } from '../notices/ResumeProgressLine'
import { SessionSignalsRuntimeContext } from '../notices/signals-runtime'
import { RequestLayer } from './RequestLayer'

const NOW = 1_800_000_000_000

const listeners = new Set<(signal: SessionSignal) => void>()
const watchSignals = (listener: (signal: SessionSignal) => void): (() => void) => {
  listeners.add(listener)

  return () => listeners.delete(listener)
}
const say = (signal: SessionSignal): void =>
  act(() => {
    for (const listener of listeners) {
      listener(signal)
    }
  })

let respond = vi.fn(async (_method: string, _params?: unknown): Promise<unknown> => ({ status: 'ok' }))
let connections: ConnectionsModel
let notices: NoticesModel
let status: SessionStatusModel
let stopBinding: () => void = () => undefined

const request = (over: Record<string, unknown> = {}): SessionSignal => ({
  kind: 'connection.request',
  chat: 'researcher',
  runtimeSessionId: 'rt-researcher',
  payload: {
    op_id: 'op-1',
    tool_call_id: 'tc-1',
    deadline_at: NOW / 1000 + 95,
    timeout_seconds: 120,
    targets: [
      {
        name: 'github',
        kind: 'connector',
        action: 'authorize',
        state: 'pending',
        connect_url: 'https://auth.example/connect/gh?state=abc'
      },
      {
        name: 'notion‮evil',
        kind: 'mcp',
        action: 'install',
        state: 'pending',
        connect_url: 'javascript:alert(1)',
        instructions: 'Paste your **token** in the settings'
      },
      { name: 'linear', kind: 'connector', action: 'authorize', state: 'connected' }
    ],
    ...over
  }
})

function mount(openLink = vi.fn()) {
  const result = render(
    <SessionSignalsRuntimeContext.Provider value={{ notices, connections, status }}>
      <main>
        <button type="button">Behind</button>
      </main>
      <RequestLayer tapGuardMs={0} openLink={openLink} />
    </SessionSignalsRuntimeContext.Provider>
  )

  return { ...result, openLink }
}

const dialog = (): HTMLElement => screen.getByRole('dialog')

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  resetShellStores()
  resetActiveLocale()
  requestsStore.getState().reset()
  listeners.clear()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-researcher' }))
  chatsStore.getState().bindRuntime('researcher', 'rt-researcher')
  respond = vi.fn(async () => ({ status: 'ok' }))
  connections = new ConnectionsModel({ gateway: { request: respond as never }, watchSignals, chats: chatsStore })
  notices = new NoticesModel({ watchSignals })
  status = new SessionStatusModel({
    gateway: { request: vi.fn() as never, onStatus: () => () => undefined },
    readIdentity: vi.fn(),
    initialAuthor: undefined,
    watchSignals,
    chats: chatsStore
  })
  connections.start()
  notices.start()
  status.start()
  stopBinding = bindRequests(chatsStore, requestsStore, undefined, undefined, connectionsStore)
})

afterEach(() => {
  stopBinding()
  connections.stop()
  notices.stop()
  status.stop()
  vi.useRealTimers()
})

describe('a connector authorisation', () => {
  it('is a modal dialog that names the bot, lists the services in plain text and counts down to the deadline', () => {
    mount()
    say(request())

    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(within(dialog()).getByRole('heading', { name: 'Dr. Researcher wants to connect a service' })).toBeTruthy()

    const rows = within(dialog()).getAllByRole('listitem')

    expect(rows.map(row => row.querySelector('bdi')?.textContent)).toEqual(['github', 'notionevil', 'linear'])
    expect(within(rows[2]!).getByText('Connected')).toBeTruthy()
    // The gateway's instructions are text, never Markdown.
    expect(within(rows[1]!).getByText('Paste your **token** in the settings')).toBeTruthy()
    expect(within(dialog()).getByText('Time left: 1:35')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(2_000))
    expect(within(dialog()).getByText('Time left: 1:33')).toBeTruthy()
  })

  it('shows where a link goes, and opens it only when it is pressed, in a new tab', () => {
    const { openLink } = mount()

    say(request())

    const open = within(dialog()).getByRole('button', {
      name: 'Authorise github at auth.example (opens a new tab)'
    })

    expect(within(dialog()).getByText('Opens auth.example')).toBeTruthy()
    expect(openLink).not.toHaveBeenCalled()

    fireEvent.click(open)

    expect(openLink).toHaveBeenCalledWith('https://auth.example/connect/gh?state=abc')
    expect(within(dialog()).getByText(/^Opened\./u)).toBeTruthy()
  })

  it('offers nothing to press for a link that is not plain https, and says why', () => {
    mount()
    say(request())

    const row = within(dialog()).getAllByRole('listitem')[1]!

    expect(within(row).queryByRole('button', { name: /Authorise/u })).toBeNull()
    expect(within(row).getByText(/only https links to a named host are opened/u)).toBeTruthy()
    expect(document.querySelector('a[href^="javascript"]')).toBeNull()
  })

  it('skips one service and stops waiting for the whole card through connection.respond', async () => {
    mount()
    say(request())

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Not now: github' }))
    await act(async () => undefined)
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Stop waiting' }))
    await act(async () => undefined)

    expect(respond.mock.calls.map(call => (call[1] as { result: unknown }).result)).toEqual([
      { targets: [{ name: 'github', status: 'skipped' }] },
      { settled_by: 'continue' }
    ])
    // A connected service has nothing left to skip.
    expect(within(dialog()).queryByRole('button', { name: 'Not now: linear' })).toBeNull()
  })

  it('says when an answer did not reach the gateway', async () => {
    respond.mockRejectedValueOnce(new Error('gateway not connected'))
    mount()
    say(request())

    fireEvent.click(within(dialog()).getByRole('button', { name: 'Stop waiting' }))
    await act(async () => undefined)

    expect(within(dialog()).getByRole('status').textContent).toBe(
      'That did not reach the gateway: gateway not connected'
    )
  })

  it('follows the gateway’s updates, closes when it settles, and says when the time ran out', async () => {
    mount()
    say(request())
    say({
      kind: 'connection.update',
      chat: 'researcher',
      payload: { op_id: 'op-1', seq: 2, targets: [{ name: 'github', state: 'connected' }] }
    })

    expect(within(within(dialog()).getAllByRole('listitem')[0]!).getByText('Connected')).toBeTruthy()

    act(() => void vi.advanceTimersByTime(95_000))
    await act(async () => undefined)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('The time to connect a service for Dr. Researcher ran out.')).toBeTruthy()
  })
})

describe('the gateway’s notices', () => {
  it('shows each notice as plain text, with its bot, until it is closed', () => {
    mount()
    say({
      kind: 'notice.show',
      chat: 'researcher',
      payload: { text: 'Credits are **low**', level: 'warn', kind: 'sticky', key: 'credits' }
    })
    say({
      kind: 'notice.show',
      chat: undefined,
      payload: { text: 'Starting the agent', level: 'info', kind: 'sticky' }
    })

    const list = screen.getByRole('list', { name: 'Notices from the gateway' })

    expect(within(list).getByRole('alert').textContent).toBe('From Dr. Researcher: Credits are **low**')
    expect(within(list).getByRole('status').textContent).toBe('Starting the agent')

    fireEvent.click(within(list).getByRole('button', { name: 'Close the notice: Credits are **low**' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Starting the agent')
  })

  it('stays reachable over an open dialog', () => {
    const { container } = mount()

    say(request())
    say({
      kind: 'notice.show',
      chat: undefined,
      payload: { text: 'Starting the agent', level: 'info', kind: 'sticky' }
    })

    const list = screen.getByRole('list', { name: 'Notices from the gateway' })

    expect(list.closest('[inert]')).toBeNull()
    expect(container.querySelector('main')?.hasAttribute('inert')).toBe(true)
  })
})

describe('a chat’s resume progress', () => {
  it('says the gateway is still loading, then the reason it could not, until closed', () => {
    render(
      <SessionSignalsRuntimeContext.Provider value={{ notices, connections, status }}>
        <ResumeProgressLine chatKey="researcher" />
      </SessionSignalsRuntimeContext.Provider>
    )

    say({
      kind: 'resumed',
      chat: 'researcher',
      runtimeSessionId: 'rt-researcher',
      pendingConnection: null,
      hydrating: true
    })
    expect(screen.getByRole('status').textContent).toBe('The gateway is still loading this conversation…')

    say({ kind: 'resume.progress', chat: 'researcher', payload: { status: 'failed', message: 'database is locked' } })
    expect(screen.getByRole('alert').textContent).toContain(
      'The gateway could not load this conversation’s history. The gateway says: database is locked'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the identity line', () => {
  it('says so when the gateway does not name the reader, and says nothing when it does', () => {
    const { unmount } = render(<IdentityNote />)

    expect(screen.getByRole('status').textContent).toMatch(/does not say who you are/u)
    unmount()

    act(() => sessionStatusStore.setState({ identity: { kind: 'failed' } }))
    const second = render(<IdentityNote />)

    expect(screen.getByRole('status').textContent).toMatch(/could not ask the gateway who you are/u)
    second.unmount()

    act(() => sessionStatusStore.setState({ identity: { kind: 'known', authorId: 'authentik:1', name: 'Ann' } }))
    render(<IdentityNote />)
    expect(screen.queryByRole('status')).toBeNull()
  })
})

describe('without a notice', () => {
  it('draws no notice list', () => {
    mount()

    expect(noticesStore.getState().notices).toEqual([])
    expect(screen.queryByRole('list', { name: 'Notices from the gateway' })).toBeNull()
  })
})
