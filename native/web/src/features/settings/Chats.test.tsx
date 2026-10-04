/**
 * Settings, Chats: the defaults reach the chat view's store (and a conversation with its own keeps it),
 * the transcript cache can be switched off and cleared now, and a failure to clear is said.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { chatViewFor, chatViewStore } from '../../state/chat-view'
import { settingsStore } from '../../state/settings'
import { aSettingsRuntime } from '../../test-support/settings-runtime'
import { resetShellStores } from '../../test-support/shell-stores'
import { Chats } from './Chats'
import { SettingsRuntimeContext } from './settings-runtime'

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

function mount(runtime = aSettingsRuntime()) {
  render(
    <SettingsRuntimeContext.Provider value={runtime}>
      <Chats />
    </SettingsRuntimeContext.Provider>
  )

  return runtime
}

describe('the Chats page: the defaults', () => {
  it('shows the verbosity, bot-to-bot and thinking a new conversation follows', () => {
    mount()

    const verbosity = screen.getByRole('group', { name: 'Default verbosity' })

    expect(
      within(verbosity)
        .getAllByRole('radio')
        .map(input => input.closest('label')?.textContent)
    ).toEqual(['Quiet', 'Normal', 'Verbose'])
    expect((within(verbosity).getByRole('radio', { name: 'Quiet' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Show bot-to-bot' }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Show thinking' }) as HTMLInputElement).checked).toBe(false)
  })

  it('changes the defaults, and a conversation that has its own view keeps it', () => {
    chatViewStore.getState().setChatView('researcher', { level: 'verbose' })
    mount()

    fireEvent.click(
      within(screen.getByRole('group', { name: 'Default verbosity' })).getByRole('radio', { name: 'Normal' })
    )
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show thinking' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Show bot-to-bot' }))

    expect(chatViewStore.getState().defaults).toEqual({ level: 'normal', showBotToBot: false, showThinking: true })
    expect(chatViewFor(chatViewStore.getState(), 'researcher').level).toBe('verbose')
    expect(chatViewFor(chatViewStore.getState(), 'writer').level).toBe('normal')
  })

  it('reads the chosen defaults when the page opens', () => {
    chatViewStore.getState().setDefaults({ level: 'verbose', showThinking: true })
    mount()

    expect(
      (
        within(screen.getByRole('group', { name: 'Default verbosity' })).getByRole('radio', {
          name: 'Verbose'
        }) as HTMLInputElement
      ).checked
    ).toBe(true)
    expect((screen.getByRole('checkbox', { name: 'Show thinking' }) as HTMLInputElement).checked).toBe(true)
  })
})

describe('the Chats page: how a bot is named', () => {
  afterEach(() => settingsStore.getState().reset())

  const order = (): HTMLElement => screen.getByRole('group', { name: 'Bot names' })
  const hide = (): HTMLInputElement => screen.getByRole('checkbox', { name: 'Hide profile name' }) as HTMLInputElement

  it('hides a named bot’s profile name by default, and the order has nothing to say while it does', () => {
    mount()

    expect(hide().checked).toBe(true)
    expect(order().hasAttribute('disabled')).toBe(true)
    expect((within(order()).getByRole('radio', { name: 'Display name' }) as HTMLInputElement).checked).toBe(true)
    expect(
      within(order())
        .getAllByRole('radio')
        .map(input => input.closest('label')?.textContent)
    ).toEqual(['Profile name', 'Display name'])
    expect(document.getElementById(hide().getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /^When a bot has a display name, show only that/u
    )
  })

  it('shows both names once the profile name is not hidden, and then takes the order', () => {
    mount()

    fireEvent.click(hide())
    expect(settingsStore.getState().hideHandleWhenNamed).toBe(false)
    expect(order().hasAttribute('disabled')).toBe(false)

    fireEvent.click(within(order()).getByRole('radio', { name: 'Profile name' }))
    expect(settingsStore.getState().botNameOrder).toBe('profile')
    expect((within(order()).getByRole('radio', { name: 'Profile name' }) as HTMLInputElement).checked).toBe(true)

    fireEvent.click(within(order()).getByRole('radio', { name: 'Display name' }))
    expect(settingsStore.getState().botNameOrder).toBe('display')
  })

  it('reads what the browser stored, and describes the order', () => {
    settingsStore.getState().setHideHandleWhenNamed(false)
    settingsStore.getState().setBotNameOrder('profile')
    mount()

    expect(hide().checked).toBe(false)
    expect((within(order()).getByRole('radio', { name: 'Profile name' }) as HTMLInputElement).checked).toBe(true)
    expect(document.getElementById(order().getAttribute('aria-describedby') ?? '')?.textContent).toMatch(
      /^Which name is the large one/u
    )
  })
})

describe('the Chats page: the transcript cache', () => {
  it('is on by default, and describes what it does', () => {
    mount()

    const keep = screen.getByRole('checkbox', { name: 'Keep transcripts in this browser' }) as HTMLInputElement

    expect(keep.checked).toBe(true)
    expect(keep.getAttribute('aria-describedby')).not.toBeNull()
    expect(document.getElementById(keep.getAttribute('aria-describedby') ?? '')?.textContent).toContain(
      'switching off clears'
    )
  })

  it('switches off, and clears what is stored in the same breath', async () => {
    const runtime = mount()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep transcripts in this browser' }))

    expect(settingsStore.getState().transcriptCache).toBe(false)
    expect(runtime.clearTranscriptCache).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/no longer kept in this browser/u)).toBeTruthy()
    expect(
      (screen.getByRole('checkbox', { name: 'Keep transcripts in this browser' }) as HTMLInputElement).checked
    ).toBe(false)
  })

  it('switches on again without clearing anything', async () => {
    settingsStore.getState().setTranscriptCache(false)

    const runtime = mount()

    fireEvent.click(screen.getByRole('checkbox', { name: 'Keep transcripts in this browser' }))

    expect(settingsStore.getState().transcriptCache).toBe(true)
    expect(runtime.clearTranscriptCache).not.toHaveBeenCalled()
    expect(await screen.findByText('Transcripts are kept in this browser again.')).toBeTruthy()
  })

  it('clears now, and says so', async () => {
    const runtime = mount()

    fireEvent.click(screen.getByRole('button', { name: 'Clear now' }))

    expect(runtime.clearTranscriptCache).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('The stored transcripts were cleared.')).toBeTruthy()
    // Clearing is not switching off.
    expect(settingsStore.getState().transcriptCache).toBe(true)
  })

  it('says when it could not clear, as an error, and can be tried again', async () => {
    const runtime = aSettingsRuntime()

    runtime.clearTranscriptCache.mockRejectedValueOnce(new Error('blocked'))
    mount(runtime)

    fireEvent.click(screen.getByRole('button', { name: 'Clear now' }))

    const status = await screen.findByText('The stored transcripts could not be cleared.')

    expect(status.getAttribute('data-tone')).toBe('danger')

    fireEvent.click(screen.getByRole('button', { name: 'Clear now' }))
    await waitFor(() => expect(screen.getByText('The stored transcripts were cleared.')).toBeTruthy())
  })

  it('keeps the button in the tab order while it works, so the reader’s focus is not thrown away', async () => {
    let finish: () => void = () => undefined
    const runtime = aSettingsRuntime()

    runtime.clearTranscriptCache.mockImplementationOnce(() => new Promise<void>(resolve => (finish = resolve)))
    mount(runtime)

    const button = screen.getByRole('button', { name: 'Clear now' }) as HTMLButtonElement

    button.focus()
    fireEvent.click(button)

    expect(button.disabled).toBe(false)
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(document.activeElement).toBe(button)

    // A second press while it works does nothing.
    fireEvent.click(button)
    expect(runtime.clearTranscriptCache).toHaveBeenCalledTimes(1)

    await act(async () => finish())
    expect(button.getAttribute('aria-busy')).toBe('false')
  })

  it('cannot clear on a page that has no cache to clear', () => {
    render(<Chats />)

    expect((screen.getByRole('button', { name: 'Clear now' }) as HTMLButtonElement).disabled).toBe(true)
  })
})
