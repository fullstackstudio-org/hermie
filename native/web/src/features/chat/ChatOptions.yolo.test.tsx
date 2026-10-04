/**
 * YOLO mode in the chat screen: the row in the chat's options (turning it on asks, turning
 * it off does not), the mark in the header while it is on, and a refusal drawn in the
 * error style with the real state left showing.
 *
 * The state is the session's own report (`ChatState.info.yolo`, written by `session.info`),
 * so each test plays the gateway by dispatching that event the way the controller does.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { chatWith } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatScreen } from './ChatScreen'
import { ChatRuntimeContext, type ChatScreenController } from './chat-runtime'

/** What the gateway says about the session after a switch: the whole info record, as `session.info` carries it. */
const tell = (yolo: boolean): void => {
  act(() =>
    chatsStore.getState().dispatchEvent('researcher', {
      type: 'session.info',
      session_id: 'rt-1',
      payload: { model: 'example-provider/example-model', yolo }
    })
  )
}

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
    // The gateway answers, then tells every page what it now holds.
    setOption: vi.fn(async (_bot: string, _key: string, value: string) => {
      tell(value === 'on')

      return {}
    }),
    refreshOptions: vi.fn(async () => null),
    ...over
  }

  return controller as typeof controller & ChatScreenController
}

function mount(controller = fakeController(), bot = 'researcher') {
  render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <ChatScreen bot={bot} />
    </ChatRuntimeContext.Provider>
  )

  return controller
}

/** An attached chat of the reader's own, its session reporting `yolo`. */
const attach = (yolo: boolean, over: Parameters<typeof chatWith>[2] = {}): void => {
  act(() =>
    chatsStore.getState().hydrate(
      'researcher',
      chatWith('researcher', [], {
        runtimeSessionId: 'rt-1',
        info: { model: 'example-provider/example-model', yolo },
        ...over
      })
    )
  )
}

const openOptions = async (): Promise<HTMLElement> => {
  fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))

  return screen.findByRole('group', { name: 'This conversation' })
}

const badge = (): HTMLElement | null => screen.queryByRole('button', { name: /^YOLO mode is on/u })

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' })])
})

describe('YOLO mode in the chat’s options', () => {
  it('asks before turning it on, and only the answer yes reaches the gateway', async () => {
    attach(false)

    const controller = mount()
    const row = await openOptions()
    const box = within(row).getByRole('checkbox', { name: 'YOLO mode' }) as HTMLInputElement

    expect(box.checked).toBe(false)
    expect(document.getElementById(box.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Skip approval requests'
    )

    fireEvent.click(box)

    // The question stands in the way: nothing was sent, the switch has not moved, and focus is on the safe answer.
    const question = within(row).getByRole('group', {
      name: 'Approval requests are skipped in this chat until you turn it off.'
    })

    expect(controller.setOption).not.toHaveBeenCalled()
    expect(box.checked).toBe(false)
    expect(badge()).toBeNull()
    expect(document.activeElement).toBe(within(question).getByRole('button', { name: 'Cancel' }))

    fireEvent.click(within(question).getByRole('button', { name: 'Turn on YOLO mode' }))

    expect(controller.setOption).toHaveBeenCalledWith('researcher', 'yolo', 'on')
    await waitFor(() => expect(box.checked).toBe(true))
    expect(within(row).queryByRole('group', { name: /^Approval requests are skipped/u })).toBeNull()
    expect(badge()).not.toBeNull()
    expect(document.activeElement).toBe(box)
  })

  it('takes the question back with Cancel or Escape and sends nothing, the panel staying open', async () => {
    attach(false)

    const controller = mount()
    const row = await openOptions()
    const box = within(row).getByRole('checkbox', { name: 'YOLO mode' })

    fireEvent.click(box)
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }))
    expect(within(row).queryByRole('button', { name: 'Turn on YOLO mode' })).toBeNull()
    expect(document.activeElement).toBe(box)

    fireEvent.click(box)
    fireEvent.keyDown(within(row).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
    expect(within(row).queryByRole('button', { name: 'Turn on YOLO mode' })).toBeNull()
    // Escape withdrew the question and no more: the options are still open, focus on the switch.
    expect(screen.getByRole('button', { name: 'Chat options' }).getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(box)
    expect(controller.setOption).not.toHaveBeenCalled()
  })

  it('turns it off at once, with no question', async () => {
    attach(true)

    const controller = mount()
    const row = await openOptions()
    const box = within(row).getByRole('checkbox', { name: 'YOLO mode' }) as HTMLInputElement

    expect(box.checked).toBe(true)
    fireEvent.click(box)

    expect(within(row).queryByRole('button', { name: 'Turn on YOLO mode' })).toBeNull()
    expect(controller.setOption).toHaveBeenCalledWith('researcher', 'yolo', 'off')
    await waitFor(() => expect(box.checked).toBe(false))
    expect(badge()).toBeNull()
  })

  it('has no such row for a chat that is not attached, or on a connection that is down', async () => {
    attach(false, { runtimeSessionId: undefined })

    mount()
    fireEvent.click(screen.getByRole('button', { name: 'Chat options' }))
    await screen.findByRole('group', { name: 'What this conversation shows' })
    expect(screen.queryByRole('checkbox', { name: 'YOLO mode' })).toBeNull()

    attach(false)
    expect(await screen.findByRole('checkbox', { name: 'YOLO mode' })).toBeTruthy()

    act(() => connectionStore.getState().setStatus('reconnecting', null))
    expect(screen.queryByRole('checkbox', { name: 'YOLO mode' })).toBeNull()
  })

  it('is written in Dutch and German when the reader reads them', async () => {
    attach(false)
    await act(async () => setLanguageChoice('nl'))

    mount()

    fireEvent.click(screen.getByRole('button', { name: /opties/iu }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'YOLO-modus' }))
    expect(
      screen.getByRole('group', {
        name: 'Toestemmingsverzoeken worden in dit gesprek overgeslagen tot je het weer uitzet.'
      })
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'YOLO-modus aanzetten' })).toBeTruthy()
  })
})

describe('the YOLO mark in the header', () => {
  it('is there while the session reports it on, names what it does, and is gone when it is off', () => {
    attach(false)
    mount()
    expect(badge()).toBeNull()

    tell(true)

    const mark = badge() as HTMLElement

    expect(mark.textContent).toBe('YOLO')
    expect(mark.getAttribute('aria-label')).toBe(
      'YOLO mode is on: approval requests are skipped in this chat. Turn it off'
    )
    // In the header line, outside the options panel: it needs no opening.
    expect(mark.closest('.hm-chat__head')).not.toBeNull()
    expect(screen.queryByRole('group', { name: 'This conversation' })).toBeNull()

    // Somebody else turned it off (another device, `/yolo`): the mark follows the session, not the last click here.
    tell(false)
    expect(badge()).toBeNull()
  })

  it('turns it off with one press and no question', async () => {
    attach(true)

    const controller = mount()

    fireEvent.click(badge() as HTMLElement)

    expect(controller.setOption).toHaveBeenCalledTimes(1)
    expect(controller.setOption).toHaveBeenCalledWith('researcher', 'yolo', 'off')
    expect(screen.queryByRole('button', { name: 'Turn on YOLO mode' })).toBeNull()
    await waitFor(() => expect(badge()).toBeNull())
  })

  it('stays shown while the connection is down, and presses nothing then', () => {
    attach(true)
    act(() => connectionStore.getState().setStatus('reconnecting', null))

    const controller = mount()
    const mark = badge() as HTMLElement

    expect(mark.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(mark)
    expect(controller.setOption).not.toHaveBeenCalled()
  })
})

describe('a refusal from the gateway', () => {
  it('is drawn as an alert in the error style, and the switch still shows what the session holds', async () => {
    attach(false)

    const controller = mount(
      fakeController({
        setOption: vi.fn(async () => {
          throw new Error('approvals are managed by the gateway')
        })
      })
    )
    const row = await openOptions()
    const box = within(row).getByRole('checkbox', { name: 'YOLO mode' }) as HTMLInputElement

    fireEvent.click(box)
    fireEvent.click(within(row).getByRole('button', { name: 'Turn on YOLO mode' }))

    const alert = await screen.findByRole('alert')

    expect(alert.textContent).toContain('YOLO mode could not be changed: approvals are managed by the gateway')
    expect(alert.getAttribute('data-tone')).toBe('danger')
    expect(alert.className).toBe('hm-chat__banner')
    // The session never said it was on, so nothing says so; and what the gateway holds was asked for again.
    expect(box.checked).toBe(false)
    expect(badge()).toBeNull()
    expect(controller.refreshOptions).toHaveBeenCalledWith('researcher')

    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('leaves the mark on when turning it off was refused, and a later attempt clears the line', async () => {
    attach(true)

    const refuse = vi.fn(async () => {
      throw new Error('gateway not connected')
    })
    const controller = mount(fakeController({ setOption: refuse }))

    fireEvent.click(badge() as HTMLElement)
    expect((await screen.findByRole('alert')).textContent).toContain('gateway not connected')
    expect(badge()).not.toBeNull()

    vi.mocked(controller.setOption).mockImplementation(async (_bot, _key, value) => {
      tell(value === 'on')

      return {}
    })
    fireEvent.click(badge() as HTMLElement)
    await waitFor(() => expect(badge()).toBeNull())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('repairs the switch from the gateway when the refusal came after the gateway had acted', async () => {
    attach(false)

    const controller = mount(
      fakeController({
        setOption: vi.fn(async () => {
          throw new Error('timed out')
        }),
        // The re-read finds YOLO on after all.
        refreshOptions: vi.fn(async () => {
          tell(true)

          return null
        })
      })
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Chat options' }))
    fireEvent.click(await screen.findByRole('checkbox', { name: 'YOLO mode' }))
    fireEvent.click(screen.getByRole('button', { name: 'Turn on YOLO mode' }))

    await screen.findByRole('alert')
    expect(controller.refreshOptions).toHaveBeenCalled()
    await waitFor(() => expect(badge()).not.toBeNull())
    expect((screen.getByRole('checkbox', { name: 'YOLO mode' }) as HTMLInputElement).checked).toBe(true)
  })
})
