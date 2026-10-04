/**
 * The choice between the shared Bot Chat and the reader's own: absent where the gateway named nobody, on the one
 * the reader's memory names, the pending choice held while the gateway answers (and put back when it refuses), one
 * switch at a time, the busy bot's own sentence, the polite line after a switch, three languages, and axe.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ConversationBusyError } from '../../core/chat-controller'
import { resetActiveLocale } from '../../i18n/active-locale'
import { layoutStore } from '../../state/layout'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatChoice } from './ChatChoice'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  seedRoster([aBot('researcher'), aBot('writer')])
  layoutStore.getState().reconcile(['researcher', 'writer'])
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

/** A controller whose switch the test holds and releases; a real one moves the layout's memory, so this does. */
function controller(
  over: { available?: boolean; choose?: (bot: { name: string }, choice: string) => Promise<void> } = {}
) {
  const chooseChat = vi.fn<(bot: { name: string }, choice: string) => Promise<void>>(
    over.choose ??
      (async (bot, choice) => {
        layoutStore.getState().setMyChat(bot.name, choice === 'mine')
      })
  )

  return {
    chooseChat,
    ownChatsAvailable: vi.fn(() => over.available ?? true)
  }
}

const radio = (name: string): HTMLInputElement => screen.getByRole('radio', { name }) as HTMLInputElement
const group = (): HTMLElement => screen.getByRole('group', { name: 'Whose chat' })

describe('where it is drawn', () => {
  it('draws nothing where the gateway has not said who the reader is', () => {
    const { container } = render(<ChatChoice bot="researcher" controller={controller({ available: false }) as never} />)

    expect(container.textContent).toBe('')
  })

  it('draws nothing without a controller, or for a bot the roster does not have', () => {
    const first = render(<ChatChoice bot="researcher" controller={undefined} />)

    expect(first.container.textContent).toBe('')
    cleanup()

    const second = render(<ChatChoice bot="ghost" controller={controller() as never} />)

    expect(second.container.textContent).toBe('')
  })

  it('is a labelled group of two radios, on the shared chat until the reader says otherwise', () => {
    render(<ChatChoice bot="researcher" controller={controller() as never} />)

    expect(group()).toBeTruthy()
    expect(radio('Shared Bot Chat').checked).toBe(true)
    expect(radio('My chat').checked).toBe(false)
    expect(screen.getByText('Everyone on this gateway shares this conversation.')).toBeTruthy()
    expect(group().getAttribute('aria-describedby')).toBeTruthy()
  })

  it('is on My chat when the reader’s memory names it, and says who sees it', () => {
    layoutStore.getState().setMyChat('researcher', true)
    render(<ChatChoice bot="researcher" controller={controller() as never} />)

    expect(radio('My chat').checked).toBe(true)
    expect(screen.getByText('Only you see this conversation. The bot keeps its own memory.')).toBeTruthy()
  })

  it('is per bot', () => {
    layoutStore.getState().setMyChat('writer', true)
    render(<ChatChoice bot="researcher" controller={controller() as never} />)

    expect(radio('Shared Bot Chat').checked).toBe(true)
  })
})

describe('switching', () => {
  it('asks the controller for the bot’s own chat, and says so once it is there', async () => {
    const calls = controller()
    const chosen = vi.fn()

    render(<ChatChoice bot="researcher" controller={calls as never} onChosen={chosen} />)
    await act(async () => void fireEvent.click(radio('My chat')))

    expect(calls.chooseChat).toHaveBeenCalledWith(expect.objectContaining({ name: 'researcher' }), 'mine')
    expect(radio('My chat').checked).toBe(true)
    expect(screen.getByText('Now in your own chat.')).toBeTruthy()
    expect(chosen).toHaveBeenCalledTimes(1)

    await act(async () => void fireEvent.click(radio('Shared Bot Chat')))
    expect(calls.chooseChat).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'researcher' }), 'shared')
    expect(screen.getByText('Now in the shared Bot Chat.')).toBeTruthy()
  })

  it('moves at the press, while the gateway is still answering, and is busy meanwhile', async () => {
    let release: () => void = () => undefined
    const calls = controller({
      choose: () =>
        new Promise<void>(resolve => {
          release = () => {
            layoutStore.getState().setMyChat('researcher', true)
            resolve()
          }
        })
    })

    render(<ChatChoice bot="researcher" controller={calls as never} />)
    fireEvent.click(radio('My chat'))

    expect(radio('My chat').checked).toBe(true)
    expect(group().getAttribute('aria-busy')).toBe('true')
    expect(screen.getByText('Only you see this conversation. The bot keeps its own memory.')).toBeTruthy()

    await act(async () => release())
    expect(group().getAttribute('aria-busy')).toBeNull()
  })

  it('does one switch at a time, and none for the one that is already on', async () => {
    let release: () => void = () => undefined
    const calls = controller({ choose: () => new Promise<void>(resolve => (release = resolve)) })

    render(<ChatChoice bot="researcher" controller={calls as never} />)
    fireEvent.click(radio('Shared Bot Chat'))
    expect(calls.chooseChat).not.toHaveBeenCalled()

    fireEvent.click(radio('My chat'))
    fireEvent.click(radio('Shared Bot Chat'))
    expect(calls.chooseChat).toHaveBeenCalledTimes(1)

    await act(async () => release())
  })

  it('puts the radio back and says why when the gateway refuses, as text', async () => {
    const calls = controller({ choose: async () => Promise.reject(new Error('Could not list <b>x</b>')) })

    render(<ChatChoice bot="researcher" controller={calls as never} />)
    await act(async () => void fireEvent.click(radio('My chat')))

    expect(radio('Shared Bot Chat').checked).toBe(true)

    const alert = screen.getByRole('alert')

    expect(alert.textContent).toBe('That did not work: Could not list <b>x</b>')
    expect(alert.querySelector('b')).toBeNull()
  })

  it('gives a busy bot the sentence the Conversations page gives it', async () => {
    const calls = controller({ choose: async () => Promise.reject(new ConversationBusyError('researcher')) })

    render(<ChatChoice bot="researcher" controller={calls as never} />)
    await act(async () => void fireEvent.click(radio('My chat')))

    expect(screen.getByRole('alert').textContent).toBe('Wait until the reply is finished or clear the queue first.')
    expect(radio('Shared Bot Chat').checked).toBe(true)
  })

  it('forgets a refusal when the reader tries again', async () => {
    const calls = controller({ choose: async () => Promise.reject(new Error('nope')) })

    render(<ChatChoice bot="researcher" controller={calls as never} />)
    await act(async () => void fireEvent.click(radio('My chat')))
    expect(screen.getByRole('alert')).toBeTruthy()

    calls.chooseChat.mockImplementationOnce(async (bot: { name: string }) =>
      layoutStore.getState().setMyChat(bot.name, true)
    )
    await act(async () => void fireEvent.click(radio('My chat')))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('languages and accessibility', () => {
  it('speaks Dutch and German', async () => {
    const { setLanguageChoice } = await import('../../i18n/locale')

    render(<ChatChoice bot="researcher" controller={controller() as never} />)

    await act(() => setLanguageChoice('nl'))
    expect(screen.getByRole('group', { name: 'Van wie de chat is' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'Mijn chat' })).toBeTruthy()

    await act(async () => void fireEvent.click(screen.getByRole('radio', { name: 'Mijn chat' })))
    expect(screen.getByText('Nu in je eigen chat.')).toBeTruthy()

    await act(() => setLanguageChoice('de'))
    expect(screen.getByRole('radio', { name: 'Geteilter Bot Chat' })).toBeTruthy()
    expect(screen.getByText('Jetzt in deinem eigenen Chat.')).toBeTruthy()
  })

  it('has no axe violation, with a refusal showing', async () => {
    const calls = controller({ choose: async () => Promise.reject(new Error('nope')) })

    render(<ChatChoice bot="researcher" controller={calls as never} />)
    await act(async () => void fireEvent.click(radio('My chat')))

    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false }, 'document-title': { enabled: false }, region: { enabled: false } }
    })

    expect(result.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([])
  })
})
