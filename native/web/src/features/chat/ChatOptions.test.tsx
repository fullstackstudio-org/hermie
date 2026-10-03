/**
 * The chat's options and what the chat screen does with them, and the screen's
 * side of a message's menu and of the image viewer: the transcript follows a
 * switch at once, Regenerate reaches the controller only where it is honest,
 * and a picture opens over the page and gives focus back.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ownAuthorStore } from '../../core/chats/own-author'
import { clearSentPreviews, rememberSentPreviews } from '../../core/chats/sent-previews'
import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { chatViewFor, chatViewStore } from '../../state/chat-view'
import { connectionStore } from '../../state/connection'
import { sessionStatusStore } from '../../state/session-status'
import { assistantItem, chatWith, toolItem, userItem } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatOptions } from './ChatOptions'
import { ChatScreen } from './ChatScreen'
import { ChatRuntimeContext, type ChatScreenController } from './chat-runtime'

function fakeController(over: Partial<Record<keyof ChatScreenController, unknown>> = {}) {
  const controller = {
    openChat: vi.fn(async () => undefined),
    openSession: vi.fn(async () => ({ kind: 'current' as const })),
    openConversation: vi.fn(async () => undefined),
    loadOlder: vi.fn(async () => 'start' as const),
    readKeyFor: vi.fn((bot: string) => bot),
    closeChat: vi.fn(async () => undefined),
    send: vi.fn(async () => undefined),
    runSlash: vi.fn(async () => ({})),
    slashRouteFor: vi.fn(() => null),
    querySlash: vi.fn(async () => ({ items: [] })),
    stopTurn: vi.fn(async () => undefined),
    ...over
  }

  return controller as typeof controller & ChatScreenController
}

function mountScreen(controller = fakeController()) {
  render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <ChatScreen bot="researcher" />
    </ChatRuntimeContext.Provider>
  )

  return controller
}

const commit = (items: Parameters<typeof chatWith>[1], over: Parameters<typeof chatWith>[2] = {}): void => {
  act(() => chatsStore.getState().hydrate('researcher', chatWith('researcher', items, over)))
}

const toolRows = (): number => document.querySelectorAll('.hm-tool').length

/** Open the shared menu on a message, as a right-click on its bubble does. */
const openMenuOn = (id: string): void => {
  const message = document.querySelector<HTMLElement>(`[data-message-id="${id}"]`)

  fireEvent.contextMenu(message?.querySelector('.hm-bubble') ?? (message as HTMLElement))
}

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
})

describe('the chat options', () => {
  it('is a disclosure of labelled native controls, closed until asked, its panel loaded when opened', async () => {
    render(<ChatOptions bot="researcher" />)

    const button = screen.getByRole('button', { name: 'Chat options' })

    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('group', { name: 'What this conversation shows' })).toBeNull()

    fireEvent.click(button)

    const panel = await screen.findByRole('group', { name: 'What this conversation shows' })

    expect(button.getAttribute('aria-expanded')).toBe('true')
    expect(button.getAttribute('aria-controls')).toBe(panel.parentElement?.id)
    expect(within(panel).getByRole('group', { name: 'Verbosity' })).toBeTruthy()
    expect(
      within(panel)
        .getAllByRole('radio')
        .map(radio => (radio as HTMLInputElement).labels?.[0]?.textContent)
    ).toEqual(['Quiet', 'Normal', 'Verbose'])
    expect((within(panel).getByRole('radio', { name: 'Normal' }) as HTMLInputElement).checked).toBe(true)
    expect((within(panel).getByRole('checkbox', { name: 'Show bot-to-bot' }) as HTMLInputElement).checked).toBe(true)
    expect((within(panel).getByRole('checkbox', { name: 'Show thinking' }) as HTMLInputElement).checked).toBe(false)
    expect(within(panel).getByText('Following the default set in Settings.')).toBeTruthy()
  })

  it('pins this chat’s own view on a change, and offers to follow the default again', async () => {
    render(<ChatOptions bot="researcher" />)
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))

    fireEvent.click(await screen.findByRole('radio', { name: 'Verbose' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show thinking' }))

    expect(chatViewFor(chatViewStore.getState(), 'researcher')).toEqual({
      level: 'verbose',
      showBotToBot: true,
      showThinking: true
    })
    expect(chatViewFor(chatViewStore.getState(), 'writer').level).toBe('normal')
    expect(screen.getByText('This conversation has its own view.')).toBeTruthy()

    const reset = screen.getByRole('button', { name: "Reset this conversation's view" })

    expect(document.getElementById(reset.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/^Clears/u)
    fireEvent.click(reset)

    expect(chatViewStore.getState().perChat).toEqual({})
    // The button went with the override; focus is on the verbosity in force, not lost.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Normal' }))
  })

  it('closes on Escape back to its button, and on a press outside', async () => {
    render(
      <>
        <ChatOptions bot="researcher" />
        <p>outside</p>
      </>
    )

    const button = screen.getByRole('button', { name: 'Chat options' })

    fireEvent.click(button)
    fireEvent.keyDown(await screen.findByRole('radio', { name: 'Quiet' }), { key: 'Escape' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(button)

    fireEvent.click(button)
    fireEvent.pointerDown(screen.getByText('outside'))
    expect(button.getAttribute('aria-expanded')).toBe('false')
  })
})

describe('the chat screen with the options', async () => {
  it('shows what the reader chose for this chat, at once', async () => {
    commit([userItem('look it up', {}, 'u'), toolItem('web_search', { summary: 'three results' }, 't1')])
    mountScreen()

    expect(toolRows()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'Quiet' }))
    expect(toolRows()).toBe(0)

    fireEvent.click(screen.getByRole('radio', { name: 'Verbose' }))
    expect(toolRows()).toBe(1)
  })
})

describe('the screen’s side of a message’s menu', async () => {
  it('offers Regenerate on the last reply only, and sends the reader’s last prompt again where the gateway has no /retry', async () => {
    commit([
      userItem('first question', {}, 'u1'),
      assistantItem('first answer', {}, 'a1'),
      userItem('second question', {}, 'u2'),
      assistantItem('second answer', {}, 'a2')
    ])

    const controller = mountScreen()

    openMenuOn('a1')
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Regenerate' })).toBeNull()
    fireEvent.keyDown((await screen.findAllByRole('menuitem'))[0] as HTMLElement, { key: 'Escape' })

    openMenuOn('a2')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Regenerate' }))

    await vi.waitFor(() => expect(controller.send).toHaveBeenCalledWith('researcher', 'second question'))
    expect(controller.runSlash).not.toHaveBeenCalled()
  })

  it('runs /retry where the gateway has it', async () => {
    commit([userItem('question', {}, 'u1'), assistantItem('answer', {}, 'a1')])

    const controller = mountScreen(fakeController({ slashRouteFor: vi.fn(() => 'dispatch') }))
    openMenuOn('a1')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Regenerate' }))

    await vi.waitFor(() => expect(controller.runSlash).toHaveBeenCalledWith('researcher', '/retry'))
    expect(controller.send).not.toHaveBeenCalled()
  })

  it('does not offer it after a colleague’s turn in the group chat', async () => {
    act(() => {
      ownAuthorStore.getState().set({ id: 'self-hosted:me' })
      sessionStatusStore.setState({ capabilities: { perMessageAuthor: true, perSessionExclusiveSubmit: true } })
    })
    commit([
      userItem('my question', { author: { id: 'self-hosted:me', name: 'Me' } }, 'u1'),
      userItem('their question', { author: { id: 'self-hosted:dana', name: 'Dana' } }, 'u2'),
      assistantItem('answer', {}, 'a1')
    ])
    mountScreen()

    // The screen sees the group chat: Dana's turn is drawn as hers.
    expect(document.querySelector('[data-row-key="u2"] .hm-msg')?.getAttribute('data-side')).toBe('other')

    openMenuOn('a1')
    await screen.findByRole('menu')
    expect(screen.queryByRole('menuitem', { name: 'Regenerate' })).toBeNull()
    expect(await screen.findByRole('menuitem', { name: 'Copy text' })).toBeTruthy()
    act(() => ownAuthorStore.getState().reset())
  })

  it('says why nothing happened while a turn runs', async () => {
    commit([userItem('q', {}, 'u1'), assistantItem('a', {}, 'a1')], {
      turn: { active: true, local: true, nextSeq: 9000 }
    })
    mountScreen()

    openMenuOn('a1')

    const regenerate = await screen.findByRole('menuitem', { name: 'Regenerate' })

    expect(regenerate.getAttribute('aria-disabled')).toBe('true')
  })
})

describe('the screen’s side of the transcript', async () => {
  it('tells the keyboard how to reach a message, and opens the menu from roving focus', async () => {
    commit([userItem('question', {}, 'u1'), assistantItem('answer', {}, 'a1')])
    mountScreen()

    const log = screen.getByRole('log')

    expect(document.getElementById(log.getAttribute('aria-describedby') ?? '')?.textContent).toMatch(/arrows/u)

    log.focus()
    fireEvent.keyDown(log, { key: 'ArrowUp' })
    expect(document.activeElement?.getAttribute('data-message-id')).toBe('a1')

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' })
    expect(await screen.findByRole('menu', { name: 'Message actions' })).toBeTruthy()
  })

  it('shows a picture the reader sent from this page, and only that one, as a picture', async () => {
    rememberSentPreviews('researcher', [{ name: 'shot.png', previewUrl: 'data:image/png;base64,iVBORw0KGgo=' }])
    commit([userItem('look', { attachments: ['@image:shot.png', '@image:/srv/other.png'] }, 'u1')])
    mountScreen()

    const list = screen.getByRole('list', { name: 'Attachments' })

    expect((within(list).getByRole('img', { name: 'shot.png' }) as HTMLImageElement).src).toBe(
      'data:image/png;base64,iVBORw0KGgo='
    )
    expect(within(list).queryByRole('img', { name: 'other.png' })).toBeNull()
    expect(within(list).getByText('other.png')).toBeTruthy()
    clearSentPreviews()
  })
})
