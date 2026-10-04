/**
 * A bot's Conversations page, against a controller that answers like a gateway.
 *
 * What is proved: the groups `classifyConversations` makes, in order; the
 * canonical row carries no action at all (ADR-0007's guard, structural); a
 * branch or a past conversation opens in the read-only viewer and can be
 * renamed, deleted (after a question) and made the Bot Chat; a new conversation
 * asks first, opens the chat when it is not live and lands the reader in it;
 * every action re-reads the list; a refusal is said, with "busy" in words of its
 * own; and the language follows a switch without a reload.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationBusyError } from '../../core/chat-controller'
import type { Conversation, ConversationGroups } from '../../core/sessions/session-model'
import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatRuntimeContext, type ChatScreenController } from '../chat/chat-runtime'
import { ConversationsPage } from './ConversationsPage'
import { askAboutNewConversation, takeNewConversationRequest } from './new-conversation-request'

const conversation = (id: string, over: Partial<Conversation> = {}): Conversation => ({
  id,
  resolvedId: id,
  title: id,
  preview: '',
  messageCount: 4,
  lastActive: 1_700_000_000,
  kind: 'past',
  ...over
})

const GROUPS: ConversationGroups = {
  canonical: conversation('stored-researcher', { title: 'Bot Chat', kind: 'canonical', preview: 'Latest words' }),
  mine: null,
  branches: [conversation('branch-1', { title: 'Branch · the cheaper flight', kind: 'branch' })],
  past: [conversation('old-1', { title: 'Bot Chat · 2026-09-01 10:00', preview: 'We settled on Lisbon.' })]
}

function fakeController(over: Partial<Record<keyof ChatScreenController, unknown>> = {}) {
  const listeners = new Set<() => void>()
  const controller = {
    openChat: vi.fn(async () => undefined),
    listConversations: vi.fn(async () => GROUPS),
    onConversationsChanged: vi.fn((_bot: string, listener: () => void) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }),
    renameConversation: vi.fn(async (_bot: string, _id: string, title: string) => title),
    deleteConversation: vi.fn(async () => undefined),
    adoptAsCanonical: vi.fn(async () => undefined),
    startNewConversation: vi.fn(async () => undefined),
    ...over
  }

  return Object.assign(controller as typeof controller & ChatScreenController, {
    changed: () => listeners.forEach(listener => listener())
  })
}

function mount(controller: ChatScreenController | null = fakeController(), router = createHashRouter(null)) {
  render(
    <ChatRuntimeContext.Provider value={controller ? { controller, gatewayBaseUrl: 'http://gateway.test' } : null}>
      <ConversationsPage bot="researcher" router={router} />
    </ChatRuntimeContext.Provider>
  )

  return { router }
}

const rowOf = (id: string): HTMLElement => document.querySelector<HTMLElement>(`[data-conversation="${id}"]`)!
const group = (name: string): HTMLElement => screen.getByRole('region', { name })

beforeEach(() => {
  resetShellStores()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher')])
})

afterEach(() => {
  resetActiveLocale()
})

describe('the Conversations page', () => {
  it('lists the current conversation, the branches and the past ones, in that order', async () => {
    mount()

    await screen.findByRole('region', { name: 'Current conversation' })
    const headings = screen.getAllByRole('heading', { level: 2 }).map(heading => heading.textContent)

    expect(headings).toEqual(['Current conversation', 'Branches', 'Past conversations'])
    expect(within(group('Current conversation')).getByText('Bot Chat')).toBeTruthy()
    expect(within(group('Branches')).getByText('Branch · the cheaper flight')).toBeTruthy()
    expect(within(group('Past conversations')).getByText('We settled on Lisbon.')).toBeTruthy()
    expect(within(rowOf('old-1')).getByText(/^4 messages/u)).toBeTruthy()
  })

  it('offers nothing at all on the current conversation', async () => {
    mount()

    await screen.findByRole('region', { name: 'Current conversation' })
    const current = rowOf('stored-researcher')

    expect(within(current).queryAllByRole('button')).toEqual([])
    expect(within(current).queryAllByRole('link')).toEqual([])
    expect(within(current).queryByRole('group')).toBeNull()
  })

  it('opens a branch or a past conversation in the read-only viewer', async () => {
    mount()

    await screen.findByRole('region', { name: 'Branches' })

    expect(within(rowOf('branch-1')).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      '#/chat/researcher/s/branch-1'
    )
    expect(within(rowOf('old-1')).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
      '#/chat/researcher/s/old-1'
    )
    // Each row's actions are named after the row, so five "Open" links are told apart.
    expect(screen.getByRole('group', { name: 'Actions for Branch · the cheaper flight' })).toBeTruthy()
  })

  it('says when there is nothing but the current conversation', async () => {
    mount(fakeController({ listConversations: vi.fn(async () => ({ ...GROUPS, branches: [], past: [] })) }))

    expect(await screen.findByText('Nothing but the current conversation.')).toBeTruthy()
    expect(screen.queryByRole('region', { name: 'Branches' })).toBeNull()
  })

  it('renames on Return, says so and reads the list again', async () => {
    const controller = fakeController()

    mount(controller)
    await screen.findByRole('region', { name: 'Branches' })

    fireEvent.click(within(rowOf('branch-1')).getByRole('button', { name: 'Rename' }))
    const field = screen.getByRole('textbox', { name: 'Rename conversation' })

    expect(document.activeElement).toBe(field)
    fireEvent.change(field, { target: { value: 'Flights' } })
    fireEvent.submit(field)

    await vi.waitFor(() =>
      expect(controller.renameConversation).toHaveBeenCalledWith('researcher', 'branch-1', 'Flights')
    )
    expect(await screen.findByText('The conversation has a new name.')).toBeTruthy()
    await vi.waitFor(() => expect(controller.listConversations).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('leaves a rename on Escape without asking the gateway anything', async () => {
    const controller = fakeController()

    mount(controller)
    await screen.findByRole('region', { name: 'Branches' })

    fireEvent.click(within(rowOf('branch-1')).getByRole('button', { name: 'Rename' }))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })

    expect(screen.queryByRole('textbox')).toBeNull()
    expect(controller.renameConversation).not.toHaveBeenCalled()
  })

  it('keeps the field and says why when the gateway refuses a name', async () => {
    const controller = fakeController({
      renameConversation: vi.fn(async () => {
        throw new Error("Title 'Flights' is already in use")
      })
    })

    mount(controller)
    await screen.findByRole('region', { name: 'Branches' })
    fireEvent.click(within(rowOf('branch-1')).getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Flights' } })
    fireEvent.submit(screen.getByRole('textbox'))

    expect((await screen.findByRole('alert')).textContent).toBe("That did not work: Title 'Flights' is already in use")
    expect(screen.getByRole('textbox')).toBeTruthy()
  })

  it('asks before deleting, and deletes the stored id only when the reader confirms', async () => {
    const controller = fakeController()

    mount(controller)
    await screen.findByRole('region', { name: 'Past conversations' })

    fireEvent.click(within(rowOf('old-1')).getByRole('button', { name: 'Delete' }))
    const question = within(rowOf('old-1'))

    expect(question.getByText(/will be removed from the gateway/u).querySelector('bdi')?.textContent).toBe(
      'Bot Chat · 2026-09-01 10:00'
    )
    expect(controller.deleteConversation).not.toHaveBeenCalled()

    fireEvent.click(question.getByRole('button', { name: 'Cancel' }))
    expect(controller.deleteConversation).not.toHaveBeenCalled()

    fireEvent.click(within(rowOf('old-1')).getByRole('button', { name: 'Delete' }))
    fireEvent.click(within(rowOf('old-1')).getByRole('button', { name: 'Delete' }))

    await vi.waitFor(() => expect(controller.deleteConversation).toHaveBeenCalledWith('researcher', 'old-1'))
    expect(await screen.findByText('The conversation was deleted.')).toBeTruthy()
  })

  it('makes a past conversation the Bot Chat, opening the chat first when it is not live', async () => {
    const controller = fakeController()

    mount(controller)
    await screen.findByRole('region', { name: 'Past conversations' })

    fireEvent.click(within(rowOf('old-1')).getByRole('button', { name: 'Make this the Bot Chat' }))

    await vi.waitFor(() => expect(controller.adoptAsCanonical).toHaveBeenCalledWith('researcher', 'old-1'))
    expect(controller.openChat).toHaveBeenCalledWith(botsStore.getState().byName.researcher)
    expect(vi.mocked(controller.openChat).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(controller.adoptAsCanonical).mock.invocationCallOrder[0]!
    )
    expect(await screen.findByText('That conversation is the Bot Chat now.')).toBeTruthy()
  })

  it('says a busy bot in its own words', async () => {
    mount(
      fakeController({
        adoptAsCanonical: vi.fn(async () => {
          throw new ConversationBusyError('researcher')
        })
      })
    )
    await screen.findByRole('region', { name: 'Past conversations' })

    fireEvent.click(within(rowOf('old-1')).getByRole('button', { name: 'Make this the Bot Chat' }))

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Wait until the reply is finished or clear the queue first.'
    )
  })

  it('asks before a new conversation, then starts it on the live chat and opens the chat', async () => {
    const controller = fakeController()

    chatsStore.getState().ensure('researcher', { storedSessionId: 'stored-researcher', resolvedSessionId: 'x' })
    chatsStore.getState().bindRuntime('researcher', 'runtime-1')
    const { router } = mount(controller)

    await screen.findByRole('region', { name: 'Current conversation' })
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))

    expect(screen.getByText(/moves to Past conversations/u)).toBeTruthy()
    expect(controller.startNewConversation).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }))

    await vi.waitFor(() => expect(controller.startNewConversation).toHaveBeenCalledWith('researcher'))
    // The chat was live: nothing to open first.
    expect(controller.openChat).not.toHaveBeenCalled()
    expect(router.current()).toBe('#/chat/researcher')
  })

  describe('asked for by the keyboard shortcut', () => {
    afterEach(() => void takeNewConversationRequest('researcher'))

    it('opens with the question already open, and the focus on Cancel, not on the button that does it', async () => {
      const controller = fakeController()

      askAboutNewConversation('researcher')
      mount(controller)

      expect(await screen.findByText(/moves to Past conversations/u)).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
      // Asking is not doing: nothing was started, and the request is used up.
      expect(controller.startNewConversation).not.toHaveBeenCalled()
      expect(takeNewConversationRequest('researcher')).toBe(false)
    })

    it('opens the question on a page that is already open, when the request comes later', async () => {
      mount(fakeController())
      await screen.findByRole('region', { name: 'Current conversation' })
      expect(screen.queryByText(/moves to Past conversations/u)).toBeNull()

      act(() => askAboutNewConversation('researcher'))

      expect(await screen.findByText(/moves to Past conversations/u)).toBeTruthy()
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }))
    })

    it('is for the bot it names: another bot’s request leaves this page alone', async () => {
      askAboutNewConversation('writer')
      mount(fakeController())
      await screen.findByRole('region', { name: 'Current conversation' })

      expect(screen.queryByText(/moves to Past conversations/u)).toBeNull()
      expect(takeNewConversationRequest('writer')).toBe(true)
    })

    it('starts the conversation only when the reader says so', async () => {
      const controller = fakeController()

      askAboutNewConversation('researcher')
      mount(controller)
      await screen.findByText(/moves to Past conversations/u)

      fireEvent.click(screen.getByRole('button', { name: 'Start a new conversation' }))
      await vi.waitFor(() => expect(controller.startNewConversation).toHaveBeenCalledWith('researcher'))
    })
  })

  it('cancels a new conversation without asking the gateway anything', async () => {
    const controller = fakeController()

    mount(controller)
    await screen.findByRole('region', { name: 'Current conversation' })
    fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'New conversation' })).toBeTruthy()
    expect(controller.startNewConversation).not.toHaveBeenCalled()
  })

  it('reads the list again when the controller says it changed', async () => {
    const controller = fakeController()

    mount(controller)
    await screen.findByRole('region', { name: 'Current conversation' })
    expect(controller.listConversations).toHaveBeenCalledTimes(1)

    await act(async () => controller.changed())

    expect(controller.listConversations).toHaveBeenCalledTimes(2)
  })

  it('waits for the connection before it asks, and asks again on every return to ready', async () => {
    const controller = fakeController()

    connectionStore.getState().setStatus('reconnecting', null)
    mount(controller)

    expect(screen.queryByText('Reading this bot’s conversations…')).toBeTruthy()
    expect(controller.listConversations).not.toHaveBeenCalled()

    act(() => connectionStore.getState().setStatus('ready', null))
    await screen.findByRole('region', { name: 'Current conversation' })
    expect(controller.listConversations).toHaveBeenCalledTimes(1)
  })

  it('says why the list could not be read', async () => {
    mount(
      fakeController({
        listConversations: vi.fn(async () => {
          throw new Error('session.list timed out')
        })
      })
    )

    expect((await screen.findByRole('alert')).textContent).toBe('session.list timed out')
  })

  it('draws a title as characters, without what could reorder or hide it', async () => {
    const title = 'Plan ‮evil‬ <b>x</b>'

    mount(
      fakeController({
        listConversations: vi.fn(async () => ({ ...GROUPS, past: [conversation('odd', { title })] }))
      })
    )
    await screen.findByRole('region', { name: 'Past conversations' })

    const shown = rowOf('odd').querySelector('.hm-conversation__title bdi')

    expect(shown?.textContent).toBe('Plan evil <b>x</b>')
    expect(rowOf('odd').querySelector('b')).toBeNull()
  })

  it('follows a language switch without a reload', async () => {
    mount()
    await screen.findByRole('region', { name: 'Current conversation' })

    await act(async () => {
      await setLanguageChoice('nl')
    })

    expect(screen.getByRole('region', { name: 'Huidige gesprek' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Eerdere gesprekken' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Nieuw gesprek' })).toBeTruthy()
  })

  it('says it cannot read anything where the page gave it no controller', () => {
    mount(null)

    expect(screen.getByRole('alert').textContent).toBe('This bot’s conversations could not be read.')
    expect(screen.queryByRole('button', { name: 'New conversation' })).toBeNull()
  })
})
