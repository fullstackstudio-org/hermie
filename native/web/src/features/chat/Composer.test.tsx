/**
 * The composer, from the outside: what a key does, what is sent where, what is
 * kept, and what the queue and Stop do. The controller is a handful of functions
 * that answer like a healthy gateway; the chat store and the connection are the
 * page's own, set to the state a test is about.
 */
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { chatWith } from '../../test-support/chat-fixtures'
import { resetShellStores } from '../../test-support/shell-stores'
import { type ChatScreenController, ChatRuntimeContext } from './chat-runtime'
import { Composer } from './Composer'
import { createDraftStore, type DraftStore } from './drafts'

type Mocks = Record<
  | 'send'
  | 'stopTurn'
  | 'editQueued'
  | 'deleteQueued'
  | 'steerQueued'
  | 'querySlash'
  | 'runSlash'
  | 'slashRouteFor'
  | 'startNewConversation',
  ReturnType<typeof vi.fn>
>

function fakeController(over: Partial<Mocks> = {}) {
  const controller = {
    send: vi.fn(async () => undefined),
    stopTurn: vi.fn(async () => undefined),
    editQueued: vi.fn((): string | undefined => undefined),
    deleteQueued: vi.fn(),
    steerQueued: vi.fn(async () => 'queued'),
    querySlash: vi.fn(async () => ({ items: [] })),
    runSlash: vi.fn(async () => ({})),
    slashRouteFor: vi.fn((): string | null => null),
    startNewConversation: vi.fn(async () => undefined),
    ...over
  }

  return controller as unknown as typeof controller & ChatScreenController
}

function memoryDrafts(initial: Record<string, string> = {}): DraftStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(initial))

  return {
    map,
    read: key => map.get(key) ?? '',
    write(key, text) {
      if (text === '') {
        map.delete(key)
      } else {
        map.set(key, text)
      }
    }
  }
}

function mount(controller = fakeController(), options: { drafts?: DraftStore; onSent?: () => void } = {}) {
  const view = (
    <ChatRuntimeContext.Provider
      value={{
        controller,
        gatewayBaseUrl: 'http://gateway.test',
        ...(options.drafts ? { drafts: options.drafts } : {})
      }}
    >
      <Composer chatKey="researcher" botName="Dr. Researcher" {...(options.onSent ? { onSent: options.onSent } : {})} />
    </ChatRuntimeContext.Provider>
  )
  const result = render(view)

  return { ...result, controller, field: screen.getByRole('textbox') as HTMLTextAreaElement }
}

const type = (field: HTMLElement, value: string): void => void fireEvent.change(field, { target: { value } })
const press = (field: HTMLElement, init: KeyboardEventInit): boolean =>
  fireEvent.keyDown(field, { key: 'Enter', ...init })

/** Let a settled promise's continuation run. */
const settle = (): Promise<void> => act(async () => undefined)

beforeEach(() => {
  resetShellStores()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  chatsStore.getState().hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1' }))
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(window, 'matchMedia')
})

describe('sending', () => {
  it('sends the trimmed words on Return, empties the field and says it sent', async () => {
    const onSent = vi.fn()
    const { controller, field } = mount(undefined, { onSent })

    type(field, '  hello there  ')
    press(field, {})
    await settle()

    expect(controller.send).toHaveBeenCalledExactlyOnceWith('researcher', 'hello there')
    expect(field.value).toBe('')
    expect(onSent).toHaveBeenCalledTimes(1)
  })

  it('breaks the line on Shift+Return and sends nothing', async () => {
    const { controller, field } = mount()

    type(field, 'one')
    const notPrevented = press(field, { shiftKey: true })
    await settle()

    // Not prevented: the browser inserts the line break itself.
    expect(notPrevented).toBe(true)
    expect(controller.send).not.toHaveBeenCalled()
    expect(field.value).toBe('one')
  })

  it('sends on Command+Return and Control+Return', async () => {
    const { controller, field } = mount()

    type(field, 'one')
    press(field, { metaKey: true })
    type(field, 'two')
    press(field, { ctrlKey: true })
    await settle()

    expect(controller.send.mock.calls.map(call => call[1])).toEqual(['one', 'two'])
  })

  it('never sends the Return that confirms an input method’s candidate', async () => {
    const { controller, field } = mount()

    type(field, 'にほんご')
    press(field, { isComposing: true })
    press(field, { keyCode: 229 })
    await settle()

    expect(controller.send).not.toHaveBeenCalled()
    expect(field.value).toBe('にほんご')
  })

  it('sends nothing for an empty field or one that is only whitespace', async () => {
    const { controller, field } = mount()

    press(field, {})
    type(field, '  \n ')
    press(field, {})
    await settle()

    expect(controller.send).not.toHaveBeenCalled()
  })

  it('sends with the Send button, which is off while the field is empty', async () => {
    const { controller, field } = mount()
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

    expect(send.disabled).toBe(true)

    type(field, 'hi')
    expect(send.disabled).toBe(false)

    fireEvent.click(send)
    await settle()

    expect(controller.send).toHaveBeenCalledWith('researcher', 'hi')
  })

  it('does not send twice for a second Return that lands before the first has answered', async () => {
    let finish: () => void = () => undefined
    const controller = fakeController({
      send: vi.fn(() => new Promise<undefined>(resolve => (finish = () => resolve(undefined))))
    })
    const { field } = mount(controller)

    type(field, 'once')
    press(field, {})
    press(field, {})
    finish()
    await settle()

    expect(controller.send).toHaveBeenCalledTimes(1)
  })

  it('puts the words back, and says why, when the send is refused', async () => {
    const controller = fakeController({ send: vi.fn(async () => Promise.reject(new Error('gateway said no'))) })
    const { field } = mount(controller)

    type(field, 'precious words')
    press(field, {})
    await settle()

    expect(field.value).toBe('precious words')
    expect(screen.getByRole('alert').textContent).toContain('gateway said no')
  })

  it('puts a refused message ahead of what was typed meanwhile', async () => {
    let refuse: (error: Error) => void = () => undefined
    const controller = fakeController({
      send: vi.fn(() => new Promise<undefined>((_, reject) => (refuse = reject)))
    })
    const { field } = mount(controller)

    type(field, 'first')
    press(field, {})
    type(field, 'second')
    refuse(new Error('no'))
    await settle()

    expect(field.value).toBe('first\nsecond')
  })

  it('keeps the field live and holds the send while the gateway cannot carry one', async () => {
    act(() => connectionStore.getState().setStatus('reconnecting', null))

    const { controller, field } = mount()
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement

    type(field, 'written while away')
    press(field, {})
    await settle()

    expect(field.value).toBe('written while away')
    expect(send.disabled).toBe(true)
    expect(controller.send).not.toHaveBeenCalled()

    act(() => connectionStore.getState().setStatus('ready', null))
    expect(send.disabled).toBe(false)
  })

  it('does not send into a chat that has no session on the gateway yet', async () => {
    chatsStore.getState().hydrate('researcher', chatWith('researcher', []))

    const { controller, field } = mount()

    type(field, 'early')
    press(field, {})
    await settle()

    expect(controller.send).not.toHaveBeenCalled()
  })

  it('breaks the line on a bare Return on a device with no pointer but a finger, and still sends from the button', async () => {
    window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia

    const { controller, field } = mount()

    type(field, 'line')
    expect(press(field, {})).toBe(true)
    await settle()
    expect(controller.send).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    await settle()
    expect(controller.send).toHaveBeenCalledTimes(1)
    // The hint about Return is for a device that has one.
    expect(screen.queryByText(/Shift\+Enter/u)).toBeNull()
  })
})

describe('slash commands', () => {
  it('runs a line the gateway knows as a command, and sends it as a prompt otherwise', async () => {
    const controller = fakeController({
      slashRouteFor: vi.fn((_key: string, name: string) => (name === 'model' ? 'exec' : null))
    })
    const { field } = mount(controller)

    type(field, '/model gpt')
    press(field, {})
    await settle()
    type(field, '/usr/local/bin is where it lives')
    press(field, {})
    await settle()

    expect(controller.runSlash).toHaveBeenCalledExactlyOnceWith('researcher', '/model gpt')
    expect(controller.send).toHaveBeenCalledExactlyOnceWith('researcher', '/usr/local/bin is where it lives')
  })

  it('puts a prefill the command hands back into the field', async () => {
    const controller = fakeController({
      slashRouteFor: vi.fn(() => 'exec'),
      runSlash: vi.fn(async () => ({ prefill: 'the last message, to edit' }))
    })
    const { field } = mount(controller)

    type(field, '/undo')
    press(field, {})
    await settle()

    expect(field.value).toBe('the last message, to edit')
  })

  it('puts the line back when a command fails', async () => {
    const controller = fakeController({
      slashRouteFor: vi.fn(() => 'exec'),
      runSlash: vi.fn(async () => Promise.reject(new Error('not now')))
    })
    const { field } = mount(controller)

    type(field, '/model gpt')
    press(field, {})
    await settle()

    expect(field.value).toBe('/model gpt')
    expect(screen.getByRole('alert').textContent).toContain('not now')
  })
})

describe('a long failure', () => {
  it('is one paragraph that scrolls, and a stop for the keyboard, so the composer cannot grow with it', async () => {
    const long = 'x'.repeat(5000)
    const controller = fakeController({ send: vi.fn(async () => Promise.reject(new Error(long))) })
    const { field } = mount(controller)

    type(field, 'words')
    press(field, {})
    await settle()

    const alert = screen.getByRole('alert')

    expect(alert.textContent).toContain(long)
    expect(alert.className).toBe('hm-composer__failure')
    expect(alert.tabIndex).toBe(0)
  })
})

describe('a chat that is open in another window', () => {
  const SENTENCE = 'This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.'
  const DETAILS = 'session 20260923_143304_1025bb opened by cli 4m ago.'
  const refusal = () =>
    new JsonRpcGatewayError(`${SENTENCE}\nDetails: ${DETAILS}`, { code: 4090, data: { reason: 'SESSION_NOT_OWNED' } })

  async function refused(controller = fakeController({ send: vi.fn(async () => Promise.reject(refusal())) })) {
    const view = mount(controller)

    type(view.field, 'precious words')
    press(view.field, {})
    await settle()

    return view
  }

  it('says so in our own sentence, with the gateway’s details on one line and a way out, and keeps the words', async () => {
    const { controller, field } = await refused()

    // Our sentence in the reader's language, not the gateway's two lines.
    expect(screen.getByRole('alert').textContent).toMatch(/open in another Hermes window or terminal/u)
    expect(screen.getByRole('alert').textContent).not.toContain('Details:')
    expect(screen.getByText(`Details: ${DETAILS}`).getAttribute('title')).toBe(DETAILS)
    expect(screen.getByRole('button', { name: 'Start new chat' })).toBeTruthy()
    expect(field.value).toBe('precious words')

    // Nothing was sent again by itself.
    expect(controller.send).toHaveBeenCalledTimes(1)
    expect(controller.startNewConversation).not.toHaveBeenCalled()
  })

  it('starts a new chat on request, never sends the words again, and puts them in the empty field', async () => {
    const { controller, field } = await refused()

    // The reader cleared the field meanwhile.
    type(field, '')
    fireEvent.click(screen.getByRole('button', { name: 'Start new chat' }))
    await settle()

    expect(controller.startNewConversation).toHaveBeenCalledExactlyOnceWith('researcher')
    expect(field.value).toBe('precious words')
    expect(controller.send).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull()
  })

  it('leaves what the reader typed in the new chat alone', async () => {
    const { field } = await refused()

    type(field, 'something else')
    fireEvent.click(screen.getByRole('button', { name: 'Start new chat' }))
    await settle()

    expect(field.value).toBe('something else')
  })

  it('says why when the new chat could not be started, and keeps the words', async () => {
    const controller = fakeController({
      send: vi.fn(async () => Promise.reject(refusal())),
      startNewConversation: vi.fn(async () => Promise.reject(new Error('the gateway would not')))
    })
    const { field } = await refused(controller)

    fireEvent.click(screen.getByRole('button', { name: 'Start new chat' }))
    await settle()

    expect(screen.getByRole('alert').textContent).toContain('the gateway would not')
    expect(field.value).toBe('precious words')
  })

  it('shows no details line when the gateway sent none, and is gone with the next send', async () => {
    const controller = fakeController({
      send: vi
        .fn()
        .mockRejectedValueOnce(new JsonRpcGatewayError(SENTENCE, { code: 4090, data: { reason: 'SESSION_NOT_OWNED' } }))
        .mockResolvedValue(undefined)
    })
    const { field } = await refused(controller)

    expect(screen.queryByText(/^Details:/u)).toBeNull()
    expect(screen.getByRole('button', { name: 'Start new chat' })).toBeTruthy()

    press(field, {})
    await settle()

    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull()
  })

  it('is not drawn for any other refusal', async () => {
    const controller = fakeController({
      send: vi.fn(async () => Promise.reject(new JsonRpcGatewayError('nope', { code: 4002, data: { reason: 'X' } })))
    })

    await refused(controller)

    expect(screen.getByRole('alert').textContent).toContain('nope')
    expect(screen.queryByRole('button', { name: 'Start new chat' })).toBeNull()
  })
})

describe('completions', () => {
  const answer = (items: { text: string; display?: string; meta?: string }[], replaceFrom?: number) => ({
    items,
    ...(replaceFrom === undefined ? {} : { replaceFrom })
  })

  it('asks the gateway what could follow a line that begins with a slash, and lists it', async () => {
    const controller = fakeController({
      querySlash: vi.fn(async () => answer([{ text: 'model', display: '/model', meta: 'Switch the model' }], 1))
    })
    const { field } = mount(controller)

    type(field, '/mo')
    await settle()

    expect(controller.querySlash).toHaveBeenCalledWith('researcher', '/mo')

    const list = screen.getByRole('listbox')

    expect(within(list).getByRole('option').textContent).toContain('/model')
    expect(within(list).getByRole('option').textContent).toContain('Switch the model')
    expect(field.getAttribute('aria-controls')).toBe(list.id)
  })

  it('asks about nothing else', async () => {
    const { controller, field } = mount()

    type(field, 'a sentence about /mo')
    type(field, '/mo\nsecond line')
    await settle()

    expect(controller.querySlash).not.toHaveBeenCalled()
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('moves with the arrows, takes the item on Tab or Return instead of sending, and keeps what the gateway said to keep', async () => {
    const controller = fakeController({
      querySlash: vi.fn(async () =>
        answer(
          [
            { text: 'model', display: '/model' },
            { text: 'memory', display: '/memory' }
          ],
          1
        )
      )
    })
    const { field } = mount(controller)

    type(field, '/m')
    await settle()

    const options = screen.getAllByRole('option')

    expect(options[0]?.getAttribute('aria-selected')).toBe('true')
    expect(field.getAttribute('aria-activedescendant')).toBe(options[0]?.id)

    fireEvent.keyDown(field, { key: 'ArrowDown' })
    expect(screen.getAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true')

    press(field, {})
    await settle()

    // `replace_from` 1 keeps the slash and replaces the rest with the item's own text.
    expect(field.value).toBe('/memory')
    expect(controller.send).not.toHaveBeenCalled()
    expect(controller.runSlash).not.toHaveBeenCalled()
  })

  it('without a replace column, takes a bare command name', async () => {
    const controller = fakeController({ querySlash: vi.fn(async () => answer([{ text: 'model', display: '/model' }])) })
    const { field } = mount(controller)

    type(field, '/mo')
    await settle()
    fireEvent.keyDown(field, { key: 'Tab' })
    await settle()

    expect(field.value).toBe('/model ')
  })

  it('closes on Escape and stays closed until the reader types again', async () => {
    const controller = fakeController({ querySlash: vi.fn(async () => answer([{ text: 'model', display: '/model' }])) })
    const { field } = mount(controller)

    type(field, '/mo')
    await settle()
    fireEvent.keyDown(field, { key: 'Escape' })

    expect(screen.queryByRole('listbox')).toBeNull()

    type(field, '/mod')
    await settle()
    expect(screen.getByRole('listbox')).toBeTruthy()
  })

  it('lets only the newest question paint: a wide answer that arrives late must not cover a narrow one', async () => {
    const pending: ((value: ReturnType<typeof answer>) => void)[] = []
    const controller = fakeController({
      querySlash: vi.fn(() => new Promise(resolve => pending.push(resolve as never)))
    })
    const { field } = mount(controller)

    type(field, '/')
    type(field, '/mo')
    await act(async () => {
      // The newest answers first, then the stale one.
      pending[1]?.(answer([{ text: 'model', display: '/model' }], 1))
      pending[0]?.(answer([{ text: 'help', display: '/help' }], 1))
    })

    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['/model'])
  })

  it('says so when the gateway would not answer', async () => {
    const controller = fakeController({
      querySlash: vi.fn(async () => ({ items: [], failure: { method: 'commands.catalog', reason: '4018 no' } }))
    })
    const { field } = mount(controller)

    type(field, '/')
    await settle()

    expect(screen.getByRole('listbox').textContent).toContain('commands.catalog')
  })

  it('takes an item with the pointer without moving focus off the field', async () => {
    const controller = fakeController({
      querySlash: vi.fn(async () => answer([{ text: 'model', display: '/model' }], 1))
    })
    const { field } = mount(controller)

    type(field, '/mo')
    await settle()

    const option = screen.getByRole('option')

    expect(fireEvent.mouseDown(option)).toBe(false)
    fireEvent.click(option)
    await settle()

    expect(field.value).toBe('/model')
  })
})

describe('the draft', () => {
  it('comes back where the reader left it', () => {
    const { field } = mount(undefined, { drafts: memoryDrafts({ researcher: 'unfinished' }) })

    expect(field.value).toBe('unfinished')
  })

  it('is written once the reader pauses, not on every key', () => {
    vi.useFakeTimers()

    const drafts = memoryDrafts()
    const { field } = mount(undefined, { drafts })

    type(field, 'a')
    type(field, 'ab')
    type(field, 'abc')
    expect(drafts.map.size).toBe(0)

    act(() => void vi.advanceTimersByTime(400))
    expect(drafts.map.get('researcher')).toBe('abc')
  })

  it('is written when the screen is left, before the pause is over', () => {
    vi.useFakeTimers()

    const drafts = memoryDrafts()
    const { field, unmount } = mount(undefined, { drafts })

    type(field, 'half')
    unmount()

    expect(drafts.map.get('researcher')).toBe('half')
  })

  it('is forgotten when the message goes', async () => {
    const drafts = memoryDrafts({ researcher: 'to send' })
    const { field } = mount(undefined, { drafts })

    press(field, {})
    await settle()

    expect(drafts.map.has('researcher')).toBe(false)
  })

  it('is back after a failed send', async () => {
    const drafts = memoryDrafts({ researcher: 'to send' })
    const { field } = mount(fakeController({ send: vi.fn(async () => Promise.reject(new Error('no'))) }), { drafts })

    press(field, {})
    await settle()

    expect(drafts.map.get('researcher')).toBe('to send')
  })

  it('works with no store at all', () => {
    const { field } = mount()

    type(field, 'only here')

    expect(field.value).toBe('only here')
  })

  it('goes through a real key-value store, per chat', () => {
    const map = new Map<string, string>()
    const drafts = createDraftStore({
      getSync: key => map.get(key) ?? null,
      setSync: (key, value) => void map.set(key, value),
      deleteSync: key => void map.delete(key)
    })
    const { field, unmount } = mount(undefined, { drafts })

    type(field, 'kept')
    unmount()

    expect([...map.entries()]).toEqual([['draft.researcher', 'kept']])
  })
})

describe('the field grows', () => {
  it('is sized to what is in it', () => {
    const { field } = mount()

    Object.defineProperty(field, 'scrollHeight', { configurable: true, value: 96 })
    type(field, 'one\ntwo\nthree')

    expect(field.style.height).toBe('96px')
  })
})

describe('stopping', () => {
  it('shows Stop only while a reply runs, and stops it', async () => {
    const { controller } = mount()

    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()

    act(() => {
      chatsStore
        .getState()
        .hydrate(
          'researcher',
          chatWith('researcher', [], { runtimeSessionId: 'rt-1', turn: { active: true } as never })
        )
    })
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    await settle()

    expect(controller.stopTurn).toHaveBeenCalledExactlyOnceWith('researcher')
  })

  it('stays reachable while the gateway is away, and says when the interrupt did not go', async () => {
    act(() => connectionStore.getState().setStatus('reconnecting', null))
    chatsStore
      .getState()
      .hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1', turn: { active: true } as never }))

    mount(fakeController({ stopTurn: vi.fn(async () => Promise.reject(new Error('socket gone'))) }))

    const stop = screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement

    expect(stop.disabled).toBe(false)
    fireEvent.click(stop)
    await settle()

    expect(screen.getByRole('alert').textContent).toContain('socket gone')
  })

  it('still queues what is sent while a reply runs: the controller parks it', async () => {
    chatsStore
      .getState()
      .hydrate('researcher', chatWith('researcher', [], { runtimeSessionId: 'rt-1', turn: { active: true } as never }))

    const { controller, field } = mount()

    type(field, 'and then this')
    press(field, {})
    await settle()

    expect(controller.send).toHaveBeenCalledWith('researcher', 'and then this')
  })
})

describe('the queue', () => {
  const queue = (...texts: string[]): void =>
    act(() =>
      texts.forEach((text, index) => chatsStore.getState().enqueue('researcher', { id: `q:${index + 1}`, text }))
    )

  it('draws what waits as chips with Steer, Edit and Delete, in the order they go out', () => {
    mount()
    queue('first', 'second')

    const list = screen.getByRole('list', { name: 'Messages waiting to be sent' })
    const items = within(list).getAllByRole('listitem')

    expect(items.map(item => item.textContent)).toEqual([
      expect.stringContaining('first'),
      expect.stringContaining('second')
    ])
    expect(
      within(items[0]!)
        .getAllByRole('button')
        .map(button => button.textContent)
    ).toEqual(['Steer', 'Edit', 'Delete'])
  })

  it('draws three and counts the rest', () => {
    mount()
    queue('a', 'b', 'c', 'd', 'e')

    expect(screen.getAllByRole('button', { name: /^Steer/u })).toHaveLength(3)
    expect(screen.getByText('+2 more')).toBeTruthy()
  })

  it('steers one into the running reply, and says when it was too late', async () => {
    const controller = fakeController({ steerQueued: vi.fn(async () => 'rejected') })

    mount(controller)
    queue('now please')

    fireEvent.click(screen.getByRole('button', { name: /^Steer/u }))
    await settle()

    expect(controller.steerQueued).toHaveBeenCalledExactlyOnceWith('researcher', 'q:1')
    expect(screen.getByRole('alert').textContent).toMatch(/too late/iu)
  })

  it('takes one back into the field, ahead of what is there already', () => {
    const controller = fakeController({ editQueued: vi.fn(() => 'the parked words') })
    const { field } = mount(controller)

    queue('the parked words')
    type(field, 'and a draft')
    fireEvent.click(screen.getByRole('button', { name: /^Edit/u }))

    expect(controller.editQueued).toHaveBeenCalledWith('researcher', 'q:1')
    expect(field.value).toBe('the parked words\nand a draft')
  })

  it('deletes one', () => {
    const { controller } = mount()

    queue('drop me')
    fireEvent.click(screen.getByRole('button', { name: /^Delete/u }))

    expect(controller.deleteQueued).toHaveBeenCalledExactlyOnceWith('researcher', 'q:1')
  })

  it('offers no Edit for a message that carries an attachment: the field cannot be handed its bytes back', () => {
    mount()
    act(() =>
      chatsStore.getState().enqueue('researcher', { id: 'q:9', text: 'see this', attachments: ['@file:/srv/a.pdf'] })
    )

    expect(screen.queryByRole('button', { name: /^Edit/u })).toBeNull()
    expect(screen.getByRole('button', { name: /^Steer/u })).toBeTruthy()
    expect(screen.getByText(/a\.pdf/u)).toBeTruthy()
  })

  it('shows what is typed as characters, never as markup', () => {
    mount()
    queue('<img src=x onerror=alert(1)> **bold**')

    expect(document.querySelector('img')).toBeNull()
    expect(screen.getByText('<img src=x onerror=alert(1)> **bold**')).toBeTruthy()
  })
})
