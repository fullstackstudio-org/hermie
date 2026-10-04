/**
 * The message menu's two flows that reach past the transcript, through the whole
 * chat screen: Edit and resend (the turn comes back in the composer, and Send
 * starts a NEW turn on the controller) and Branch from here (the controller is
 * asked for the right count under the right name, and the branch opens where the
 * Conversations page opens one). And the one rule that hides both: a request
 * waiting for the reader's answer.
 *
 * The controller is a handful of functions that answer like a healthy gateway;
 * the stores are the page's own.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createHashRouter, type HashRouter } from '../../platform/hash-router'
import { resetActiveLocale } from '../../i18n/active-locale'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { requestsStore } from '../../state/requests'
import { assistantItem, chatWith, userItem } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatRuntimeContext, type ChatScreenController } from './chat-runtime'
import { ChatScreen } from './ChatScreen'
import { type Conversation } from '../../core/sessions/session-model'

const BRANCH: Conversation = {
  id: 'stored-branch',
  resolvedId: 'stored-branch',
  title: 'Branch · Second question',
  preview: '',
  messageCount: 3,
  lastActive: 1_700_000_000,
  kind: 'branch'
}

function fakeController(over: Record<string, unknown> = {}) {
  const controller = {
    openChat: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ kind: 'current' as const })),
    openConversation: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    stopTurn: vi.fn(async () => undefined),
    editQueued: vi.fn((): string | undefined => undefined),
    deleteQueued: vi.fn(),
    steerQueued: vi.fn(async () => 'queued'),
    querySlash: vi.fn(async () => ({ items: [] })),
    runSlash: vi.fn(async () => ({})),
    slashRouteFor: vi.fn((): string | null => null),
    uploadFile: vi.fn(),
    uploadFileTo: vi.fn(),
    branchFrom: vi.fn(async () => BRANCH),
    ...over
  }

  return controller as unknown as typeof controller & ChatScreenController
}

const ITEMS = [
  userItem('First question', { rowId: 1 }, 'u1'),
  assistantItem('First answer', { rowId: 2 }, 'a1'),
  userItem('Second question', { rowId: 3, attachments: ['@file:notes.txt'] }, 'u2'),
  assistantItem('Second answer', { rowId: 4 }, 'a2')
]

function mount(options: { controller?: ChatScreenController; session?: string; router?: HashRouter } = {}) {
  const controller = options.controller ?? fakeController()
  const router = options.router ?? createHashRouter(null)

  render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <ChatScreen bot="researcher" router={router} {...(options.session ? { session: options.session } : {})} />
    </ChatRuntimeContext.Provider>
  )

  return { controller, router }
}

const message = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
const settle = (): Promise<void> => act(async () => undefined)

/** Open a message's menu and say which lines it has. */
async function menuOf(id: string): Promise<string[]> {
  fireEvent.contextMenu(message(id).querySelector('.hm-bubble') ?? message(id))

  return (await screen.findAllByRole('menuitem')).map(line => line.textContent ?? '')
}

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  requestsStore.getState().reset()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
  chatsStore.getState().hydrate('researcher', chatWith('researcher', ITEMS, { runtimeSessionId: 'rt-1' }))
})

describe('Edit and resend', () => {
  it('is on the newest turn only, and puts its words and attachment reference in the composer', async () => {
    mount()
    await screen.findByRole('textbox')

    expect(await menuOf('u1')).not.toContain('Edit and resend')
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await settle()

    expect(await menuOf('u2')).toEqual(['Copy text', 'Edit and resend', 'Branch from here'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit and resend' }))
    await settle()

    const field = screen.getByRole('textbox') as HTMLTextAreaElement

    expect(field.value).toBe('Second question\n@file:notes.txt')
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(field.value.length)
    // The turn in the conversation is left where it is: nothing was sent, nothing rewritten.
    expect(message('u2')).toBeTruthy()
  })

  it('sends what the field holds as a new turn, and keeps whatever was typed after the turn that came back', async () => {
    const { controller } = mount()
    const field = (await screen.findByRole('textbox')) as HTMLTextAreaElement

    fireEvent.change(field, { target: { value: 'and also this' } })
    await menuOf('u2')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Edit and resend' }))
    await settle()
    expect(field.value).toBe('Second question\n@file:notes.txt\nand also this')

    fireEvent.change(field, { target: { value: 'Second question, reworded' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    await settle()

    expect(controller.send).toHaveBeenCalledTimes(1)
    expect(controller.send).toHaveBeenCalledWith('researcher', 'Second question, reworded')
    expect(field.value).toBe('')
  })

  it('is held disabled while a turn runs', async () => {
    mount()
    await screen.findByRole('textbox')
    act(() =>
      chatsStore.getState().hydrate(
        'researcher',
        chatWith('researcher', ITEMS, {
          runtimeSessionId: 'rt-1',
          turn: { ...chatsStore.getState().chats.researcher!.turn, active: true }
        })
      )
    )

    await menuOf('u2')
    expect(screen.getByRole('menuitem', { name: 'Edit and resend' }).getAttribute('aria-disabled')).toBe('true')
  })
})

describe('Branch from here', () => {
  it('asks the controller for the messages up to the row, named after it, and opens the branch like the Conversations page does', async () => {
    const router = createHashRouter(null)
    const { controller } = mount({ router })

    await screen.findByRole('textbox')
    expect(await menuOf('a1')).toEqual(['Copy text', 'Branch from here'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from here' }))

    await vi.waitFor(() => expect(controller.branchFrom).toHaveBeenCalledTimes(1))
    expect(controller.branchFrom).toHaveBeenCalledWith('researcher', {
      messageCount: 2,
      title: 'Branch · First answer'
    })
    await vi.waitFor(() => expect(router.current()).toBe('#/chat/researcher/s/stored-branch'))
  })

  it('branches from a turn as well, counting only the rows up to it', async () => {
    const { controller } = mount()

    await screen.findByRole('textbox')
    await menuOf('u2')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from here' }))

    await vi.waitFor(() => expect(controller.branchFrom).toHaveBeenCalledTimes(1))
    expect(controller.branchFrom).toHaveBeenCalledWith('researcher', {
      messageCount: 3,
      title: 'Branch · Second question'
    })
  })

  it('says why on the page when the gateway refuses, and stays where it is', async () => {
    const router = createHashRouter(null)
    const controller = fakeController({
      branchFrom: vi.fn(async () => {
        throw new Error('no session to fork')
      })
    })

    mount({ controller, router })
    await screen.findByRole('textbox')
    await menuOf('a2')
    fireEvent.click(screen.getByRole('menuitem', { name: 'Branch from here' }))

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('This conversation could not be branched: no session to fork')
    expect(router.current()).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('is not offered in a chat that is not attached to a session yet', async () => {
    act(() => chatsStore.getState().hydrate('researcher', chatWith('researcher', ITEMS)))
    mount()
    await screen.findByRole('textbox')

    expect(await menuOf('a2')).toEqual(['Copy text', 'Regenerate'])
  })
})

describe('in a past conversation or a branch', () => {
  it('offers neither, and no composer to put a turn in', async () => {
    const controller = fakeController({ openSession: vi.fn(async () => ({ kind: 'viewer' as const })) })

    chatsStore
      .getState()
      .hydrate('researcher#stored-branch', chatWith('researcher', ITEMS, { runtimeSessionId: 'rt-v' }))
    mount({ controller, session: 'stored-branch' })

    await vi.waitFor(() => expect(controller.openConversation).toHaveBeenCalled())
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(await menuOf('u2')).toEqual(['Copy text'])
  })
})

describe('while a request waits for the reader’s answer', () => {
  it('hides Edit and resend, Regenerate and Branch from here, and gives them back once it is answered', async () => {
    mount()
    await screen.findByRole('textbox')
    expect(await menuOf('a2')).toEqual(['Copy text', 'Regenerate', 'Branch from here'])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await settle()

    act(() =>
      requestsStore
        .getState()
        .setQueue([{ kind: 'secure', key: 'secure:1', bot: 'researcher', id: 'srq-1', method: 'secret.request' }])
    )
    expect(await menuOf('u2')).toEqual(['Copy text'])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await settle()
    expect(await menuOf('a2')).toEqual(['Copy text'])
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await settle()

    act(() => requestsStore.getState().setQueue([]))
    expect(await menuOf('u2')).toEqual(['Copy text', 'Edit and resend', 'Branch from here'])
  })

  it('does not hide them for a request on another chat', async () => {
    seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer')])
    act(() =>
      requestsStore
        .getState()
        .setQueue([{ kind: 'secure', key: 'secure:2', bot: 'writer', id: 'srq-2', method: 'sudo.request' }])
    )
    mount()
    await screen.findByRole('textbox')

    expect(await menuOf('u2')).toEqual(['Copy text', 'Edit and resend', 'Branch from here'])
    expect(botsStore.getState().byName.writer).toBeTruthy()
  })
})
