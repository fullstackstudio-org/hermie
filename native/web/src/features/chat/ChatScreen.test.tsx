/**
 * The chat screen, from the outside: what it opens, what it draws of a
 * transcript, what it announces and when it says a chat is read.
 *
 * The transcript half is driven by the recorded stream scenarios
 * (`contract/transcript/streams`): each is replayed through the engine, the state
 * after every step is put in the chat store as a commit would, and the rows on
 * the page are compared with what the selectors say is visible. jsdom has no
 * layout, so where the reader is (the "jump to latest" button, read marking) is
 * driven by giving the scroller a size and scrolling it, which is all the list's
 * anchor reads.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { plainTextPreview } from '@hermie/markdown/plain-text'
import { type ChatState, isBusy, visibleItems } from '@hermie/transcript'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { replay, type StreamScenario } from '../../dev/stream-replay'
import { ownAuthorStore } from '../../core/chats/own-author'
import { sessionStatusStore } from '../../state/session-status'
import { resetActiveLocale } from '../../i18n/active-locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import {
  assistantItem,
  chatWith,
  daysAfter,
  noticeItem,
  statusItem,
  toolItem,
  userItem
} from '../../test-support/chat-fixtures'
import { aBot, LONG_AGO, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { findRequests } from '../search/find-request'
import { ChatScreen, type ChatScreenProps, DEFAULT_CHAT_VIEW } from './ChatScreen'
import { ChatRuntimeContext, type ChatScreenController } from './chat-runtime'

const STREAMS = join(__dirname, '../../../../../contract/transcript/streams')
const scenarios: StreamScenario[] = readdirSync(STREAMS)
  .filter(name => name.endsWith('.json'))
  .sort()
  .map(name => JSON.parse(readFileSync(join(STREAMS, name), 'utf8')) as StreamScenario)

/** What the controller is asked, recorded; every method answers like a healthy gateway. */
function fakeController(over: Partial<Record<keyof ChatScreenController, unknown>> = {}) {
  const controller = {
    openChat: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ kind: 'current' as const })),
    openConversation: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    ...over
  }

  return controller as typeof controller & ChatScreenController
}

function mount(props: Partial<ChatScreenProps> = {}, controller: ChatScreenController | null = fakeController()) {
  const screenProps: ChatScreenProps = { bot: 'researcher', ...props }
  const view = (p: ChatScreenProps) => (
    <ChatRuntimeContext.Provider value={controller ? { controller, gatewayBaseUrl: 'http://gateway.test' } : null}>
      <ChatScreen {...p} />
    </ChatRuntimeContext.Provider>
  )
  const result = render(view(screenProps))

  return {
    ...result,
    rerenderWith: (next: Partial<ChatScreenProps>) => result.rerender(view({ ...screenProps, ...next }))
  }
}

/** Put a chat in the store the way a frame's commit does. */
const commit = (state: ChatState, key = state.botName): void => {
  act(() => chatsStore.getState().hydrate(key, state))
}

const rowKeys = (container: HTMLElement): string[] =>
  [...container.querySelectorAll<HTMLElement>('[data-row-key]')].map(row => row.dataset.rowKey ?? '')

const log = (): HTMLElement => screen.getByRole('log')

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
})

describe('opening the chat', () => {
  it('opens the route’s chat once the connection is ready, as the reader opening the screen', async () => {
    const controller = fakeController()

    mount({}, controller)

    await vi.waitFor(() => expect(controller.openChat).toHaveBeenCalledTimes(1))
    expect(controller.openChat).toHaveBeenCalledWith(botsStore.getState().byName.researcher, { follow: true })
  })

  it('waits for the connection, and opens on the transition to ready', async () => {
    const controller = fakeController()

    act(() => connectionStore.getState().setStatus('connecting', null))
    mount({}, controller)
    await Promise.resolve()

    expect(controller.openChat).not.toHaveBeenCalled()

    act(() => connectionStore.getState().setStatus('ready', null))
    await vi.waitFor(() => expect(controller.openChat).toHaveBeenCalledTimes(1))
  })

  it('does not open a second time for the roster refreshing, or a reconnect that left it open', async () => {
    const controller = fakeController()

    mount({}, controller)
    await vi.waitFor(() => expect(controller.openChat).toHaveBeenCalledTimes(1))

    act(() => botsStore.getState().setBots([aBot('researcher', { displayName: 'Dr. R' }), aBot('writer')]))
    act(() => connectionStore.getState().setStatus('reconnecting', null))
    act(() => connectionStore.getState().setStatus('ready', null))
    await Promise.resolve()

    expect(controller.openChat).toHaveBeenCalledTimes(1)
  })

  it('opens a conversation of the bot’s own through its session, held under the bot’s name', async () => {
    const controller = fakeController()

    mount({ session: 'own-1' }, controller)

    await vi.waitFor(() => expect(controller.openSession).toHaveBeenCalledTimes(1))
    expect(controller.openSession).toHaveBeenCalledWith(botsStore.getState().byName.researcher, 'own-1')
    expect(controller.openConversation).not.toHaveBeenCalled()
  })

  it('opens a past conversation read-only, under its own key, and says so', async () => {
    const controller = fakeController({ openSession: vi.fn(async () => ({ kind: 'viewer' as const })) })
    const key = 'researcher#old-1'

    mount({ session: 'old-1' }, controller)
    await vi.waitFor(() => expect(controller.openConversation).toHaveBeenCalledTimes(1))
    commit(
      chatWith('researcher', [userItem('what did we decide?', {}, 'u1'), assistantItem('To wait.', {}, 'a1')]),
      key
    )

    expect(screen.getByText('You are reading an earlier conversation. It cannot be answered.')).toBeTruthy()
    expect(within(log()).getByText('To wait.')).toBeTruthy()
    // Nothing of the bot's own chat is on the page.
    expect(chatsStore.getState().chats.researcher).toBeUndefined()
  })

  it('offers the ways back from a past conversation: the chat, and the bot’s conversations', async () => {
    const controller = fakeController({ openSession: vi.fn(async () => ({ kind: 'viewer' as const })) })

    mount({ session: 'old-1' }, controller)
    await vi.waitFor(() => expect(controller.openConversation).toHaveBeenCalledTimes(1))

    expect(screen.getByRole('link', { name: 'Back to the chat' }).getAttribute('href')).toBe('#/chat/researcher')
    // One in the banner, one at the end of the header line.
    expect(screen.getAllByRole('link', { name: 'Conversations' }).map(link => link.getAttribute('href'))).toEqual([
      '#/chat/researcher/conversations',
      '#/chat/researcher/conversations'
    ])
    // Read-only: nothing to send with.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('links the bot’s chat to its conversations', () => {
    mount()

    expect(screen.getByRole('link', { name: 'Conversations' }).getAttribute('href')).toBe(
      '#/chat/researcher/conversations'
    )
  })

  it('opens at a search hit’s words: the row is shown and marked, and it is said once', async () => {
    findRequests.request('researcher', 'decide')
    mount()
    commit(
      chatWith('researcher', [
        userItem('what did we decide?', {}, 'u1'),
        assistantItem('To wait.', {}, 'a1'),
        userItem('ok', {}, 'u2')
      ])
    )

    await vi.waitFor(() => expect(log().querySelector('[data-row-key="u1"]')?.getAttribute('data-found')).toBe('true'))
    expect(screen.getByText('Found “decide” in this chat.')).toBeTruthy()
    expect(findRequests.current()).toBeNull()
  })

  it('leaves a search hit for another bot’s chat alone', async () => {
    findRequests.request('writer', 'decide')
    mount()
    commit(chatWith('researcher', [userItem('what did we decide?', {}, 'u1')]))

    expect(log().querySelector('[data-found]')).toBeNull()
    expect(findRequests.current()?.bot).toBe('writer')
    findRequests.settle(findRequests.current()!.id)
  })

  it('says where a search hit’s words are not in the visible text', async () => {
    findRequests.request('researcher', 'nowhere')
    mount()
    commit(chatWith('researcher', [userItem('hello', {}, 'u1')]))

    expect(
      await screen.findAllByText(
        '“nowhere” was matched by the gateway, but it is not in the visible text of this chat.'
      )
    ).toHaveLength(2)
  })

  it('shows what failed, and opens again when the reader asks', async () => {
    const controller = fakeController({
      openChat: vi.fn().mockRejectedValueOnce(new Error('gateway not connected')).mockResolvedValue(undefined)
    })

    mount({}, controller)

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('This conversation could not be opened: gateway not connected')

    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
    await vi.waitFor(() => expect(controller.openChat).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })

  it('says so when the gateway has no such bot, once the roster has been read', () => {
    mount({ bot: 'ghost' }, fakeController())

    expect(screen.getByText('This chat is not on this gateway.')).toBeTruthy()
  })

  it('says it is loading while there is nothing to draw yet, and that there is nothing said when there is not', () => {
    mount({}, fakeController())

    expect(screen.getByText('Loading the conversation…')).toBeTruthy()

    commit(chatWith('researcher', []))

    expect(screen.getByText('Nothing has been said in this chat yet.')).toBeTruthy()
    expect(screen.queryByRole('log')).toBeNull()
  })

  it('writes the cache and marks the chat read when it is left, but not when it never opened', async () => {
    const controller = fakeController()
    const first = mount({}, controller)

    first.unmount()
    expect(controller.closeChat).not.toHaveBeenCalled()

    const second = mount({}, controller)

    await vi.waitFor(() => expect(controller.openChat).toHaveBeenCalledTimes(2))
    await act(async () => undefined)
    second.unmount()
    expect(controller.closeChat).toHaveBeenCalledWith('researcher')
  })

  it('draws what the stores hold and opens nothing where the page gave it no runtime', () => {
    commit(chatWith('researcher', [userItem('hello', {}, 'u')]))
    mount({}, null)

    expect(within(log()).getByText('hello')).toBeTruthy()
  })
})

describe('the transcript', () => {
  /** The ids the selectors show, less what the screen leaves out (a status line while nothing runs). */
  const expectedIds = (state: ChatState, level: 'quiet' | 'normal'): string[] =>
    visibleItems(state, { ...DEFAULT_CHAT_VIEW, level })
      .filter(row => !(row.item.kind === 'status' && row.presentation === 'chip' && !isBusy(state)))
      .map(row => row.item.id)

  describe.each(scenarios.map(scenario => [scenario.scenario, scenario] as const))('%s', (_name, scenario) => {
    it('draws, at every recorded checkpoint, the rows the engine says are visible', () => {
      const states = [...replay(scenario)]
      const { container } = mount({}, fakeController())

      for (const checkpoint of scenario.checkpoints) {
        const state = states[checkpoint.after - 1] as ChatState

        commit({ ...state, hydration: 'live' })

        const shown = rowKeys(container).filter(key => !key.startsWith('date:') && key !== 'web:typing')

        expect(shown, checkpoint.label).toEqual(expectedIds(state, 'normal'))
        // What the checkpoint recorded is what the selectors say at the level the screen uses.
        expect(
          visibleItems(state, DEFAULT_CHAT_VIEW).map(row => row.item.id),
          checkpoint.label
        ).toEqual((checkpoint.visible.normal ?? []).map(row => row.item.id))
      }
    })

    it('says in each row what its item says', () => {
      const states = [...replay(scenario)]
      const final = states[states.length - 1] as ChatState
      const { container } = mount({}, fakeController())

      commit({ ...final, hydration: 'live' })

      for (const row of visibleItems(final, DEFAULT_CHAT_VIEW)) {
        const element = [...container.querySelectorAll<HTMLElement>('[data-row-key]')].find(
          candidate => candidate.dataset.rowKey === row.item.id
        )
        const text = element?.textContent ?? ''

        if (!element) {
          // The status line while nothing runs.
          expect(row.item.kind).toBe('status')
          continue
        }

        if (row.item.kind === 'user' || row.item.kind === 'assistant') {
          // The words, with the Markdown taken off, are in the row.
          expect(text, row.item.id).toContain(plainTextPreview(row.item.text).slice(0, 15))
        }

        if (row.item.kind === 'tool' && row.presentation !== 'hidden-placeholder') {
          expect(text, row.item.id).toContain(row.item.name)
        }
      }
    })
  })

  it('stays one bubble from the dots to the last word, in the same element', () => {
    const scenario = scenarios.find(entry => entry.scenario === 'plain-turn') as StreamScenario
    const states = [...replay(scenario)]
    const { container } = mount({}, fakeController())
    let bubble: Element | null = null
    const seen: string[] = []

    for (const state of states) {
      commit({ ...state, hydration: 'live' })

      const assistant = container.querySelector('[data-kind="assistant"][data-waiting="false"]')
      const dots = container.querySelectorAll('[role="img"]')

      seen.push(`${dots.length}:${assistant ? 'text' : 'none'}`)

      if (assistant && !bubble) {
        bubble = assistant.closest('[data-row-key]')
      }

      if (assistant && bubble) {
        expect(assistant.closest('[data-row-key]')).toBe(bubble)
      }
    }

    // The dots were there before the words (a typing row or the bubble's own), and are gone after.
    expect(seen.some(entry => entry.startsWith('1:'))).toBe(true)
    expect(seen[seen.length - 1]).toBe('0:text')
  })

  it('draws what the gateway injected as a notice, never as the reader’s own bubble', () => {
    commit(
      chatWith('researcher', [
        userItem('hi', {}, 'u'),
        noticeItem('Switched to a faster model', { noticeKind: 'model_switch' }, 'n'),
        noticeItem('Background job finished', { noticeKind: 'process_complete', body: 'exit 0' }, 'p')
      ])
    )
    mount({}, fakeController())

    expect(document.querySelectorAll('.hm-msg[data-side="own"]')).toHaveLength(1)
    expect(screen.getByText('Switched to a faster model').closest('.hm-msg')).toBeNull()
    expect(screen.getByRole('button', { name: 'Background job finished' })).toBeTruthy()
  })

  it('shows tools as one collapsed line each, and the latest status only while something runs', () => {
    commit(
      chatWith(
        'researcher',
        [
          userItem('look it up', {}, 'u'),
          toolItem('web_search', { summary: 'three results' }, 't1'),
          toolItem('read_file', { summary: 'notes.md' }, 't2'),
          statusItem('compacting context', {}, 's')
        ],
        { turn: { active: true, local: true, nextSeq: 9000 } }
      )
    )
    const { rerender } = mount({}, fakeController())

    // The tools' disclosures, in the log; the chat's options button is above it.
    expect(
      within(screen.getByRole('log'))
        .getAllByRole('button', { expanded: false })
        .map(button => button.textContent)
    ).toEqual(['\u2315web_searchthree results', '\u25a4read_filenotes.md'])
    expect(screen.getByText('compacting context')).toBeTruthy()

    commit(
      chatWith('researcher', [
        userItem('look it up', {}, 'u'),
        toolItem('web_search', { summary: 'three results' }, 't1'),
        statusItem('compacting context', {}, 's')
      ])
    )
    rerender(<ChatScreen bot="researcher" />)

    expect(screen.queryByText('compacting context')).toBeNull()
  })

  it('opens a tool on a click and shows its detail as plain text, never as markup', () => {
    commit(
      chatWith('researcher', [
        toolItem(
          'run_command',
          {
            args: { command: '<img src=x onerror=alert(1)> && ls' },
            resultText: '**not bold** <b>x</b>',
            durationS: 2.5
          },
          't'
        )
      ])
    )
    mount({}, fakeController())

    const line = screen.getByRole('button', { name: /run_command/ })

    expect(line.getAttribute('aria-expanded')).toBe('false')
    expect(line.textContent).toContain('2.5s')

    fireEvent.click(line)

    expect(line.getAttribute('aria-expanded')).toBe('true')

    const body = document.getElementById(line.getAttribute('aria-controls') ?? '') as HTMLElement

    expect(within(body).getByText('<img src=x onerror=alert(1)> && ls')).toBeTruthy()
    expect(within(body).getByText('**not bold** <b>x</b>')).toBeTruthy()
    expect(document.querySelector('img, b')).toBeNull()
  })

  it('draws a date separator at the start of each day, as a level-2 heading', () => {
    commit(
      chatWith('researcher', [
        userItem('first day', { ts: daysAfter(0, 3600) }, 'a'),
        assistantItem('reply', { ts: daysAfter(0, 3700) }, 'b'),
        userItem('second day', { ts: daysAfter(3, 3600) }, 'c')
      ])
    )
    mount({}, fakeController())

    const days = within(log()).getAllByRole('heading', { level: 2 })

    expect(days).toHaveLength(2)
    expect(rowKeys(document.body).filter(key => key.startsWith('date:'))).toHaveLength(2)
    expect(
      rowKeys(document.body)
        .map(key => (key.startsWith('date:') ? 'date' : key))
        .join(',')
    ).toBe('date,a,b,date,c')
  })

  it('pushes a heading in a reply down, so it is never a second title of the page, nor a skipped level', () => {
    commit(chatWith('researcher', [assistantItem('# Findings\n\n## Detail', {}, 'a')]))
    mount({}, fakeController())

    const bubble = document.querySelector('.hm-bubble') as HTMLElement

    expect(
      within(bubble)
        .getAllByRole('heading')
        .map(heading => heading.tagName)
    ).toEqual(['H3', 'H3'])
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull()
  })

  it('draws somebody else’s message in the group chat on the left with their name, and nobody’s elsewhere', () => {
    ownAuthorStore.getState().set({ id: 'self-hosted:me' })
    sessionStatusStore.setState({ capabilities: { perMessageAuthor: true, perSessionExclusiveSubmit: true } })

    const items = [
      userItem('mine', { author: { id: 'self-hosted:me', name: 'Me' } }, 'mine'),
      userItem('theirs', { author: { id: 'self-hosted:dana', name: 'Dana' } }, 'theirs')
    ]

    commit(chatWith('researcher', items))
    const { unmount } = mount({}, fakeController())

    const side = (id: string) => document.querySelector(`[data-row-key="${id}"] .hm-msg`)?.getAttribute('data-side')

    expect(side('mine')).toBe('own')
    expect(side('theirs')).toBe('other')
    expect(within(document.querySelector('[data-row-key="theirs"]') as HTMLElement).getByText('Dana')).toBeTruthy()
    unmount()

    // The reader's identity unknown: every row is the reader's own, as before an author was stamped at all.
    ownAuthorStore.getState().reset()
    const second = mount({}, fakeController())
    expect(side('theirs')).toBe('own')
    second.unmount()

    // A gateway that does not vouch for the authors on its rows (no `per_message_author`): the same.
    ownAuthorStore.getState().set({ id: 'self-hosted:me' })
    sessionStatusStore.setState({ capabilities: { perMessageAuthor: false, perSessionExclusiveSubmit: true } })
    mount({}, fakeController())
    expect(side('theirs')).toBe('own')
  })

  it('shows the failure of a turn under the words that arrived', () => {
    commit(
      chatWith('researcher', [
        assistantItem('Half an answer', { error: { message: 'rate limited', partial: true } }, 'a')
      ])
    )
    mount({}, fakeController())

    expect(screen.getByText('Half an answer')).toBeTruthy()
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByText('rate limited')).toBeTruthy()
  })
})

describe('what the bot is doing now (PG-3)', () => {
  const running = () =>
    chatWith('researcher', [userItem('fix it', {}, 'u')], {
      runtimeSessionId: 'rt-1',
      turn: { active: true, local: true, nextSeq: 9000 }
    })

  it('names the tool being written at the tail, in the dots’ place, until the call starts', () => {
    commit(running())
    mount({}, fakeController())

    expect(within(log()).getByRole('img', { name: /replying|typing/iu })).toBeTruthy()

    // A turn field, not an item: no row's version moves, and the screen still follows it.
    act(() =>
      chatsStore.getState().dispatchEvent('researcher', { type: 'tool.generating', payload: { name: 'terminal' } })
    )

    expect(log().querySelector('[data-generating]')?.textContent).toBe('Preparing terminal…')
    expect(within(log()).queryByRole('img')).toBeNull()

    act(() =>
      chatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'tool.start', payload: { tool_id: 'call-1', name: 'terminal' } })
    )

    expect(log().querySelector('[data-generating]')).toBeNull()
    expect(within(log()).getByRole('button', { name: /terminal/u })).toBeTruthy()
  })

  it('shows the task list over the composer when a snapshot arrives, and replaces it with the next', () => {
    commit(running())
    mount({}, fakeController())

    expect(screen.queryByRole('region', { name: 'Tasks' })).toBeNull()

    act(() =>
      chatsStore.getState().dispatchEvent('researcher', {
        type: 'todo.updated',
        payload: {
          revision: 1,
          todos: [
            { id: '1', content: 'Find the bug', status: 'in_progress' },
            { id: '2', content: 'Fix it', status: 'pending' }
          ]
        }
      })
    )

    const strip = screen.getByRole('region', { name: 'Tasks' })

    expect(strip.textContent).toContain('0 of 2 done')
    expect(strip.textContent).toContain('Find the bug')
    // Not a row of the transcript: the list is about now.
    expect(log().contains(strip)).toBe(false)

    act(() =>
      chatsStore.getState().dispatchEvent('researcher', {
        type: 'todo.updated',
        payload: {
          revision: 2,
          todos: [
            { id: '1', content: 'Find the bug', status: 'completed' },
            { id: '2', content: 'Fix it', status: 'in_progress' }
          ]
        }
      })
    )

    expect(screen.getByRole('region', { name: 'Tasks' }).textContent).toContain('1 of 2 done')
    expect(screen.getByRole('region', { name: 'Tasks' }).textContent).toContain('Fix it')
  })
})

describe('older history', () => {
  it('asks for a page when the reader reaches the top, and not before the chat is live', async () => {
    const controller = fakeController()

    commit(chatWith('researcher', [userItem('old', {}, 'u')], { hydration: 'hydrating' }))
    mount({}, controller)
    await Promise.resolve()

    expect(controller.loadOlder).not.toHaveBeenCalled()

    commit(chatWith('researcher', [userItem('old', {}, 'u')], { hydration: 'live' }))

    await vi.waitFor(() => expect(controller.loadOlder).toHaveBeenCalledWith('researcher'))
    expect(controller.loadOlder).toHaveBeenCalledTimes(1)
  })

  it('says it is loading earlier history while the page is in the air', async () => {
    let finish: (outcome: 'grew') => void = () => undefined
    const controller = fakeController({
      loadOlder: vi.fn(() => new Promise(resolve => (finish = resolve as typeof finish)))
    })

    commit(chatWith('researcher', [userItem('old', {}, 'u')]))
    mount({}, controller)

    expect(await screen.findByText('Loading earlier…')).toBeTruthy()

    await act(async () => finish('grew'))
    expect(screen.queryByText('Loading earlier…')).toBeNull()
  })
})

describe('where the reader is', () => {
  /** Give the scroller a size and put the reader `from` pixels above the bottom. */
  function scrollUp(from: number): void {
    const element = log()

    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 3000 })
    Object.defineProperty(element, 'clientHeight', { configurable: true, value: 600 })
    element.scrollTop = 3000 - 600 - from
    fireEvent.scroll(element)
  }

  const twoMessages = () => chatWith('researcher', [userItem('q', {}, 'q'), assistantItem('a', { ts: LONG_AGO }, 'a')])

  it('offers "jump to latest" only when the reader is above the bottom, with how many arrived meanwhile', () => {
    commit(twoMessages())
    mount({}, fakeController())

    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull()

    scrollUp(800)
    expect(screen.getByRole('button', { name: 'Jump to latest' })).toBeTruthy()

    commit(
      chatWith('researcher', [
        userItem('q', {}, 'q'),
        assistantItem('a', {}, 'a'),
        assistantItem('b', {}, 'b'),
        assistantItem('c', {}, 'c')
      ])
    )
    expect(screen.getByRole('button', { name: /Jump to latest.*2 new/ })).toBeTruthy()
  })

  it('goes to the newest row when asked, drops the button and leaves focus on the transcript', () => {
    commit(twoMessages())
    mount({}, fakeController())
    scrollUp(800)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))

    expect(screen.queryByRole('button', { name: /Jump to latest/ })).toBeNull()
    expect(document.activeElement).toBe(log())
    expect(log().scrollTop).toBe(3000 - 600)
  })

  it('marks the chat read as a message arrives in front of the reader, under the key of the conversation it is on', () => {
    const markSeen = vi.fn()
    const controller = fakeController({ readKeyFor: vi.fn(() => 'researcher#own-1') })

    botsStore.setState({ markSeen })
    commit(twoMessages())
    mount({}, controller)

    expect(markSeen).toHaveBeenCalled()
    expect(markSeen.mock.calls[0]?.[0]).toBe('researcher#own-1')
    expect(markSeen.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) - 5)
  })

  it('does not mark it read while the reader is scrolled up, and does when they come back down', () => {
    const markSeen = vi.fn()

    botsStore.setState({ markSeen })
    commit(twoMessages())
    mount({}, fakeController())
    markSeen.mockClear()

    scrollUp(800)
    commit(
      chatWith('researcher', [
        userItem('q', {}, 'q'),
        assistantItem('a', {}, 'a'),
        assistantItem('b', { ts: LONG_AGO + 5 }, 'b')
      ])
    )
    expect(markSeen).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /Jump to latest/ }))
    expect(markSeen).toHaveBeenCalled()
  })

  it('marks nothing read while the chat is not live', () => {
    const markSeen = vi.fn()

    botsStore.setState({ markSeen })
    commit(chatWith('researcher', [assistantItem('a', {}, 'a')], { hydration: 'hydrating' }))
    mount({}, fakeController())

    expect(markSeen).not.toHaveBeenCalled()
  })

  it('marks nothing read on a page in the background, and marks it when the page comes back', () => {
    const markSeen = vi.fn()
    const state = Object.getOwnPropertyDescriptor(document, 'visibilityState')

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    botsStore.setState({ markSeen })
    commit(twoMessages())
    mount({}, fakeController())

    expect(markSeen).not.toHaveBeenCalled()

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    act(() => void document.dispatchEvent(new Event('visibilitychange')))

    expect(markSeen).toHaveBeenCalled()

    if (state) {
      Object.defineProperty(document, 'visibilityState', state)
    } else {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  })

  it('marks nothing read for a past conversation, which is not what arrived in the bot’s chat', async () => {
    const markSeen = vi.fn()
    const controller = fakeController({ openSession: vi.fn(async () => ({ kind: 'viewer' as const })) })

    botsStore.setState({ markSeen })
    mount({ session: 'old-1' }, controller)
    await vi.waitFor(() => expect(controller.openConversation).toHaveBeenCalled())
    commit(chatWith('researcher', [assistantItem('a', {}, 'a')]), 'researcher#old-1')

    expect(markSeen).not.toHaveBeenCalled()
  })
})

describe('what is said aloud', () => {
  const running = (text: string, streaming: boolean, active: boolean) =>
    chatWith(
      'researcher',
      [userItem('q', {}, 'q'), assistantItem(text, { streaming, version: text.length + 1 }, 'a')],
      {
        turn: { active, local: true, nextSeq: 9000 }
      }
    )

  it('marks the transcript busy while a turn streams, and not otherwise', () => {
    commit(running('Hel', true, true))
    mount({}, fakeController())

    expect(log().getAttribute('aria-busy')).toBe('true')

    commit(running('Hello there.', false, false))

    expect(log().getAttribute('aria-busy')).toBeNull()
  })

  it('announces a finished reply once, in a polite region of its own, and not a single delta', () => {
    commit(running('Hel', true, true))
    mount({}, fakeController())

    const live = document.querySelector('.hm-chat__announce') as HTMLElement

    expect(live.getAttribute('aria-atomic')).toBe('true')
    expect(live.getAttribute('role')).toBe('status')

    for (const text of ['Hello', 'Hello th', 'Hello there']) {
      commit(running(text, true, true))
      expect(live.textContent).toBe('')
    }

    commit(running('Hello there. **Done.**', false, false))

    expect(live.textContent).toBe('Dr. Researcher replied: Hello there. Done.')
  })

  it('says nothing for a chat that is opened, or one that was already finished', () => {
    commit(running('All done.', false, false))
    mount({}, fakeController())

    expect((document.querySelector('.hm-chat__announce') as HTMLElement).textContent).toBe('')
  })
})
