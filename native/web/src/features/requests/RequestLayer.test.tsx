/**
 * The request layer, from the outside: what it shows of an approval and a
 * clarify, what an answer sends, and what makes it a modal dialog (focus, the page
 * behind it, Escape). The controller is four functions that answer as the real one
 * does to the store (an answer marks the request answered, which is what takes it
 * off the layer); the chat store, the queue and the roster are the page's own.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { closedRequest } from '../../core/request-withdrawn'
import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { chatsStore } from '../../state/chats'
import { connectionStore } from '../../state/connection'
import { bindRequests, requestsStore } from '../../state/requests'
import { chatWith } from '../../test-support/chat-fixtures'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatRuntimeContext, type ChatScreenController } from '../chat/chat-runtime'
import { RequestLayer } from './RequestLayer'

function fakeController(over: Record<string, unknown> = {}) {
  const store = () => chatsStore.getState()
  // The real controller refuses to answer a request that is no longer open; so does this one.
  const refuseClosed = (bot: string, id: string): void => {
    const chat = store().chats[bot]
    const closed = closedRequest(chat?.items[chat.byRequestId[id] ?? ''], id)

    if (closed) {
      throw closed
    }
  }
  const controller = {
    respondApproval: vi.fn(async (bot: string, id: string, choice: string) => {
      refuseClosed(bot, id)
      store().answer(bot, id, choice)
    }),
    respondClarify: vi.fn(async (bot: string, id: string, answers: Record<string, string>) => {
      refuseClosed(bot, id)
      store().answer(bot, id, answers)
    }),
    lockClarify: vi.fn(async (bot: string, id: string, qid: string, answer: string) => {
      refuseClosed(bot, id)
      store().answer(bot, id, { [qid]: answer })
    }),
    acknowledgeApproval: vi.fn(async () => undefined),
    ...over
  }

  return controller as unknown as typeof controller & ChatScreenController
}

let controller = fakeController()
let stopBinding: () => void = () => undefined

/** The layer over a page with a field in it, which is where a reader is when a question arrives. */
function mount(options: { tapGuardMs?: number; runtime?: boolean } = {}) {
  const result = render(
    <ChatRuntimeContext.Provider
      value={options.runtime === false ? null : { controller, gatewayBaseUrl: 'http://gateway.test' }}
    >
      <div>
        <main>
          <label>
            Draft
            <textarea />
          </label>
          <button type="button">Behind</button>
        </main>
      </div>
      <RequestLayer tapGuardMs={options.tapGuardMs ?? 0} />
    </ChatRuntimeContext.Provider>
  )

  return { ...result, page: result.container.firstElementChild as HTMLElement }
}

const approval = (bot: string, id: string, params: Record<string, unknown> = {}): void =>
  void act(() =>
    chatsStore.getState().dispatchServerRequest(bot, {
      id,
      method: 'approval',
      params: { command: 'rm -rf ./build', description: 'Remove the build directory', request_id: `a-${id}`, ...params }
    })
  )

const clarify = (bot: string, id: string, params: Record<string, unknown>): void =>
  void act(() => chatsStore.getState().dispatchServerRequest(bot, { id, method: 'clarify', params }))

const dialog = (): HTMLElement => screen.getByRole('dialog')
const button = (name: string | RegExp): HTMLElement => within(dialog()).getByRole('button', { name })
const settle = (): Promise<void> => act(async () => undefined)

beforeEach(() => {
  resetShellStores()
  requestsStore.getState().reset()
  resetActiveLocale()
  connectionStore.getState().setStatus('ready', null)
  seedRoster([aBot('researcher', { displayName: 'Dr. Researcher' }), aBot('writer', { displayName: 'Writer' })])

  for (const bot of ['researcher', 'writer']) {
    chatsStore.getState().hydrate(bot, chatWith(bot, [], { runtimeSessionId: `rt-${bot}` }))
  }

  controller = fakeController()
  stopBinding = bindRequests(chatsStore, requestsStore)
})

afterEach(() => {
  stopBinding()
  vi.useRealTimers()
})

describe('with nothing to answer', () => {
  it('draws no dialog and leaves the page alone', () => {
    const { page } = mount()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(page.hasAttribute('inert')).toBe(false)
  })

  it('draws nothing, and does not fail, on a page with no runtime', () => {
    mount({ runtime: false })
    approval('researcher', 'srq-1')

    expect(dialog()).toBeTruthy()
  })
})

describe('an approval', () => {
  it('is a modal dialog, named by its question, that says who is asking', () => {
    mount()
    approval('researcher', 'srq-1')

    expect(dialog().getAttribute('aria-modal')).toBe('true')
    expect(screen.getByRole('dialog', { name: 'Allow this command?' })).toBe(dialog())
    expect(within(dialog()).getByText('From Dr. Researcher')).toBeTruthy()
    // The lead line is what the dialog is described by, and it names the bot's handle.
    expect(dialog().getAttribute('aria-describedby')).toBe(within(dialog()).getByText(/@researcher wants to run/u).id)
  })

  it('shows the command, the description and the tool as plain text, never as Markdown', () => {
    mount()
    approval('researcher', 'srq-1', {
      command: '**echo** <b>hi</b> [x](https://example.test)',
      description: '# not a heading',
      tool_name: 'run_command'
    })

    const box = dialog()

    expect(within(box).getByText('**echo** <b>hi</b> [x](https://example.test)')).toBeTruthy()
    expect(within(box).getByText('# not a heading')).toBeTruthy()
    expect(within(box).getByText(/run_command/u)).toBeTruthy()
    expect(box.querySelector('b, a, h1, strong')).toBeNull()
  })

  it('offers exactly the choices the gateway sent, in its order', () => {
    mount()
    approval('researcher', 'srq-1', { choices: ['session', 'deny', 'once'] })

    expect(
      within(dialog())
        .getAllByRole('button')
        .map(item => item.textContent)
    ).toEqual(['Allow for this session', 'Deny', 'Allow once'])
  })

  it('falls back to the engine’s own set when the gateway named none', () => {
    mount()
    approval('researcher', 'srq-1')

    expect(
      within(dialog())
        .getAllByRole('button')
        .map(item => item.textContent)
    ).toEqual(['Allow once', 'Allow for this session', 'Always allow', 'Deny'])
  })

  it('keeps the name of a choice it does not know, and warns about always', () => {
    mount()
    approval('researcher', 'srq-1', { choices: ['once', 'always', 'allow_permanent_here'] })

    expect(button('allow permanent here')).toBeTruthy()
    expect(within(dialog()).getByText(/applies to this exact command/u)).toBeTruthy()
  })

  it('sends the choice that was pressed, once, for the right bot and request', async () => {
    mount()
    approval('writer', 'srq-7')

    // The same button pressed twice before the layer has taken the sheet away.
    const deny = button('Deny')

    fireEvent.click(deny)
    fireEvent.click(deny)
    await settle()

    expect(controller.respondApproval).toHaveBeenCalledExactlyOnceWith('writer', 'srq-7', 'deny')
  })

  it('acknowledges the approval to the gateway’s queue when a person can first see it', async () => {
    mount()
    approval('researcher', 'srq-1')
    await settle()

    expect(controller.acknowledgeApproval).toHaveBeenCalledWith('researcher', 'srq-1')
  })

  it('wakes its buttons only after the guard, so a click already on its way answers nothing', () => {
    vi.useFakeTimers()
    mount({ tapGuardMs: 400 })
    approval('researcher', 'srq-1')

    const allow = button('Allow once') as HTMLButtonElement

    expect(allow.disabled).toBe(true)
    fireEvent.click(allow)
    expect(controller.respondApproval).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(450))
    expect((button('Allow once') as HTMLButtonElement).disabled).toBe(false)
  })

  it('says it in the reader’s language', async () => {
    await setLanguageChoice('nl')
    mount()
    approval('researcher', 'srq-1')

    expect(within(dialog()).getByText('Van Dr. Researcher')).toBeTruthy()
    expect(
      within(dialog())
        .getAllByRole('button')
        .map(item => item.textContent)
    ).toEqual(['Eenmalig toestaan', 'Voor deze sessie toestaan', 'Altijd toestaan', 'Weigeren'])
  })
})

describe('one at a time', () => {
  it('shows the oldest first, says how many wait, and moves on when it is answered', async () => {
    mount()
    approval('researcher', 'srq-1', { command: 'first' })
    clarify('writer', 'srq-2', { question: 'Second?' })
    approval('researcher', 'srq-3', { command: 'third' })

    expect(within(dialog()).getByText('first')).toBeTruthy()
    expect(within(dialog()).getByText('2 more waiting')).toBeTruthy()

    fireEvent.click(button('Allow once'))
    await settle()

    expect(screen.getByRole('dialog', { name: 'Before I continue' })).toBeTruthy()
    expect(within(dialog()).getByText('Second?')).toBeTruthy()
    expect(within(dialog()).getByText('From Writer')).toBeTruthy()
    expect(within(dialog()).getByText('1 more waiting')).toBeTruthy()

    fireEvent.click(button('Skip'))
    await settle()

    expect(within(dialog()).getByText('third')).toBeTruthy()
    expect(screen.queryByText(/more waiting/u)).toBeNull()

    fireEvent.click(button('Deny'))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('names a bot whose chat is not the one on screen: it asks from anywhere', () => {
    mount()
    approval('writer', 'srq-1')

    expect(within(dialog()).getByText('From Writer')).toBeTruthy()
  })

  it('names a bot the roster does not list by its handle', () => {
    chatsStore.getState().hydrate('stranger', chatWith('stranger', [], { runtimeSessionId: 'rt-s' }))
    mount()
    approval('stranger', 'srq-1')

    expect(within(dialog()).getByText('From stranger')).toBeTruthy()
  })
})

describe('restoring and withdrawing', () => {
  it('raises the layer for requests a resume reports', () => {
    mount()
    act(() =>
      chatsStore.getState().applySnapshot('researcher', {
        open_requests: [{ id: 'srq-9', method: 'clarify', params: { question: 'Restored?', choices: ['a', 'b'] } }]
      })
    )

    expect(within(dialog()).getByText('Restored?')).toBeTruthy()
  })

  it('raises the layer for the pending approval a resume reports, and answers it', async () => {
    mount()
    act(() =>
      chatsStore.getState().applySnapshot('researcher', {
        pending_approval: { request_id: 'appr-1', command: 'make deploy' }
      })
    )

    expect(within(dialog()).getByText('make deploy')).toBeTruthy()
    fireEvent.click(button('Allow once'))
    await settle()

    expect(controller.respondApproval).toHaveBeenCalledWith('researcher', 'pending:appr-1', 'once')
  })

  it('closes when the gateway withdraws the request, and says so politely', async () => {
    const { container } = mount()

    approval('researcher', 'srq-1')
    act(() =>
      chatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'request.cancel', payload: { id: 'srq-1', reason: 'cancelled' } })
    )
    await settle()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(container.parentElement?.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'The request from Dr. Researcher was withdrawn.'
    )
  })

  it('says a timeout as a timeout', async () => {
    const { container } = mount()

    clarify('writer', 'srq-1', { question: 'Quick?' })
    act(() =>
      chatsStore
        .getState()
        .dispatchEvent('writer', { type: 'request.cancel', payload: { id: 'srq-1', reason: 'timeout' } })
    )
    await settle()

    expect(container.parentElement?.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'The request from Writer timed out.'
    )
  })

  it('says it was withdrawn when the press and the withdrawal land in the same frame', async () => {
    const { container } = mount()

    approval('researcher', 'srq-1')

    // The cancel is applied to the store, then the press arrives from the button still on screen.
    act(() => {
      chatsStore
        .getState()
        .dispatchEvent('researcher', { type: 'request.cancel', payload: { id: 'srq-1', reason: 'cancelled' } })
      fireEvent.click(button('Allow once'))
    })
    await settle()

    const item = Object.values(chatsStore.getState().chats['researcher']?.items ?? {}).find(
      entry => entry.kind === 'approval'
    )

    // The press did reach the controller, which refused it.
    expect(controller.respondApproval).toHaveBeenCalledTimes(1)
    expect(item).toMatchObject({ state: 'cancelled' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.parentElement?.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'The request from Dr. Researcher was withdrawn.'
    )
  })

  it('says a clarify that timed out in the same frame as the answer timed out', async () => {
    const { container } = mount()

    clarify('writer', 'srq-1', { question: 'Quick?' })
    act(() => {
      chatsStore
        .getState()
        .dispatchEvent('writer', { type: 'request.cancel', payload: { id: 'srq-1', reason: 'timeout' } })
      fireEvent.click(button('Skip'))
    })
    await settle()

    expect(controller.respondClarify).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(container.parentElement?.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'The request from Writer timed out.'
    )
  })

  it('says nothing about a request the reader answered themselves', async () => {
    const { container } = mount()

    approval('researcher', 'srq-1')
    fireEvent.click(button('Allow once'))
    await settle()

    expect(container.parentElement?.querySelector('[aria-live="polite"]')?.textContent).toBe('')
  })

  it('says when an answer did not reach the gateway', async () => {
    controller = fakeController({ respondApproval: vi.fn(async () => Promise.reject(new Error('socket closed'))) })
    mount()
    approval('researcher', 'srq-1')

    fireEvent.click(button('Allow once'))
    await settle()

    expect(screen.getByRole('alert').textContent).toBe('The answer was not delivered: socket closed')
  })
})

describe('a modal layer', () => {
  it('puts the rest of the page out of reach while it is open, and back when it is gone', async () => {
    const { page } = mount()

    approval('researcher', 'srq-1')
    expect(page.hasAttribute('inert')).toBe(true)

    fireEvent.click(button('Deny'))
    await settle()

    expect(page.hasAttribute('inert')).toBe(false)
  })

  it('does not close on Escape: only an answer closes it', () => {
    mount()
    approval('researcher', 'srq-1')

    const notPrevented = fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(notPrevented).toBe(false)
    expect(dialog()).toBeTruthy()
    expect(controller.respondApproval).not.toHaveBeenCalled()
  })

  it('does not close on a press of the scrim', () => {
    mount()
    approval('researcher', 'srq-1')

    fireEvent.click(dialog().parentElement as HTMLElement)
    fireEvent.mouseDown(dialog().parentElement as HTMLElement)

    expect(dialog()).toBeTruthy()
    expect(controller.respondApproval).not.toHaveBeenCalled()
  })

  it('takes focus onto the dialog itself, not onto a button a stray Return could press', () => {
    mount()
    screen.getByLabelText('Draft').focus()
    approval('researcher', 'srq-1')

    expect(document.activeElement).toBe(dialog())
  })

  it('keeps Tab and Shift+Tab inside the dialog', () => {
    mount()
    approval('researcher', 'srq-1', { choices: ['once', 'session', 'deny'] })

    const buttons = within(dialog()).getAllByRole('button')
    const command = within(dialog()).getByText('rm -rf ./build')

    // From the last control forward: back to the first focusable (the command, a scroll region).
    buttons.at(-1)?.focus()
    fireEvent.keyDown(buttons.at(-1) as HTMLElement, { key: 'Tab' })
    expect(document.activeElement).toBe(command)

    // From the first backward: to the last.
    command.focus()
    fireEvent.keyDown(command, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons.at(-1))

    // From the dialog itself backward: to the last.
    dialog().focus()
    fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(buttons.at(-1))
  })

  it('brings back a focus that lands outside it', () => {
    mount()
    approval('researcher', 'srq-1')

    act(() => screen.getByRole('button', { name: 'Behind', hidden: true }).focus())

    expect(document.activeElement).toBe(dialog())
  })

  it('gives focus back to where the reader was when the last request is answered', async () => {
    mount()

    const field = screen.getByLabelText('Draft')

    field.focus()
    approval('researcher', 'srq-1')
    expect(document.activeElement).toBe(dialog())

    fireEvent.click(button('Deny'))
    await settle()

    expect(document.activeElement).toBe(field)
  })

  it('moves focus to each next request, and gives it back only after the last', async () => {
    mount()

    const field = screen.getByLabelText('Draft')

    field.focus()
    approval('researcher', 'srq-1')
    approval('researcher', 'srq-2', { command: 'second' })
    fireEvent.click(button('Deny'))
    await settle()

    expect(document.activeElement).toBe(dialog())
    expect(within(dialog()).getByText('second')).toBeTruthy()

    fireEvent.click(button('Deny'))
    await settle()
    expect(document.activeElement).toBe(field)
  })

  it('falls back to the composer when the place the reader was has gone', async () => {
    const { page } = mount()
    const where = document.createElement('button')
    const composer = document.createElement('textarea')

    composer.setAttribute('data-composer-field', '')
    page.append(where, composer)
    where.focus()
    approval('researcher', 'srq-1')
    // The reader had been somewhere that no longer exists by the time they answer.
    where.remove()
    fireEvent.click(button('Deny'))
    await settle()

    expect(document.activeElement).toBe(composer)
  })
})

describe('a clarify', () => {
  const single = { question: 'Which one?', choices: ['Alpha', 'Beta', 'Gamma'], request_id: 'q1' }

  it('shows the question, its choices and a field for the reader’s own words, as plain text', () => {
    mount()
    clarify('researcher', 'srq-1', { ...single, question: 'Pick **one** <i>please</i>' })

    expect(screen.getByRole('dialog', { name: 'Before I continue' })).toBeTruthy()
    expect(within(dialog()).getByText('Pick **one** <i>please</i>')).toBeTruthy()
    expect(
      within(dialog())
        .getAllByRole('radio')
        .map(radio => radio.parentElement?.textContent)
    ).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(within(dialog()).getByRole('radiogroup')).toBeTruthy()
    expect(within(dialog()).getByLabelText('Or answer in your own words')).toBeTruthy()
    expect(dialog().querySelector('i')).toBeNull()
  })

  it('wakes its buttons only after the guard, so a click already on its way cannot land on Skip', () => {
    vi.useFakeTimers()
    mount({ tapGuardMs: 400 })
    clarify('researcher', 'srq-1', single)

    const skip = button('Skip') as HTMLButtonElement

    expect(skip.disabled).toBe(true)
    fireEvent.click(skip)
    expect(controller.respondClarify).not.toHaveBeenCalled()

    act(() => void vi.advanceTimersByTime(450))
    expect((button('Skip') as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button('Skip'))
    expect(controller.respondClarify).toHaveBeenCalledExactlyOnceWith('researcher', 'srq-1', { q1: '' })
  })

  it('holds the next step and the lock behind the same guard', () => {
    vi.useFakeTimers()
    mount({ tapGuardMs: 400 })
    clarify('researcher', 'srq-1', {
      request_id: 'q1',
      questions: [
        { qid: 'a', question: 'First?', choices: ['x'] },
        { qid: 'b', question: 'Second?' }
      ]
    })
    fireEvent.click(within(dialog()).getByLabelText('x'))

    for (const name of ['Next', 'Skip']) {
      expect((button(name) as HTMLButtonElement).disabled, name).toBe(true)
    }

    act(() => void vi.advanceTimersByTime(450))
    expect((button('Next') as HTMLButtonElement).disabled).toBe(false)
  })

  it('answers with the choice that was picked', async () => {
    mount()
    clarify('researcher', 'srq-1', single)

    expect((button('Submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog()).getByLabelText('Beta'))
    fireEvent.click(button('Submit'))
    await settle()

    expect(controller.respondClarify).toHaveBeenCalledExactlyOnceWith('researcher', 'srq-1', { q1: 'Beta' })
  })

  it('answers with the reader’s own words, which replace a choice', async () => {
    mount()
    clarify('researcher', 'srq-1', single)

    fireEvent.click(within(dialog()).getByLabelText('Beta'))
    fireEvent.change(within(dialog()).getByLabelText('Or answer in your own words'), {
      target: { value: 'None of those' }
    })

    expect((within(dialog()).getByLabelText('Beta') as HTMLInputElement).checked).toBe(false)

    fireEvent.click(button('Submit'))
    await settle()

    expect(controller.respondClarify).toHaveBeenCalledWith('researcher', 'srq-1', { q1: 'None of those' })
  })

  it('answers with Command+Return in the field', async () => {
    mount()
    clarify('researcher', 'srq-1', { question: 'Why?', request_id: 'q1' })

    const field = within(dialog()).getByLabelText('Or answer in your own words')

    fireEvent.change(field, { target: { value: 'because' } })
    // Plain Return writes a second line.
    expect(fireEvent.keyDown(field, { key: 'Enter' })).toBe(true)
    expect(controller.respondClarify).not.toHaveBeenCalled()

    fireEvent.keyDown(field, { key: 'Enter', metaKey: true })
    await settle()

    expect(controller.respondClarify).toHaveBeenCalledWith('researcher', 'srq-1', { q1: 'because' })
  })

  it('lets several be picked when the question allows, and joins them', async () => {
    mount()
    clarify('researcher', 'srq-1', { ...single, multi_select: true })

    expect(within(dialog()).getByText('Choose as many as apply')).toBeTruthy()

    fireEvent.click(within(dialog()).getByLabelText('Alpha'))
    fireEvent.click(within(dialog()).getByLabelText('Gamma'))
    fireEvent.click(within(dialog()).getByLabelText('Alpha'))
    fireEvent.click(within(dialog()).getByLabelText('Beta'))
    fireEvent.click(button('Submit'))
    await settle()

    expect(within(document.body).queryByRole('group')).toBeNull()
    expect(controller.respondClarify).toHaveBeenCalledWith('researcher', 'srq-1', { q1: 'Gamma, Beta' })
  })

  it('Skip answers with an empty string, so the bot goes on', async () => {
    mount()
    clarify('researcher', 'srq-1', single)

    fireEvent.click(button('Skip'))
    await settle()

    expect(controller.respondClarify).toHaveBeenCalledExactlyOnceWith('researcher', 'srq-1', { q1: '' })
  })

  describe('a batch', () => {
    const batch = {
      request_id: 'b1',
      questions: [
        { qid: 'q1', question: 'First?', choices: ['yes', 'no'] },
        { qid: 'q2', question: 'Second?' },
        { qid: 'q3', question: 'Third?', choices: ['x', 'y'], multi_select: true }
      ]
    }

    it('steps through the questions, and sends every answer at the last one', async () => {
      mount()
      clarify('researcher', 'srq-1', batch)

      expect(within(dialog()).getByText('Question 1 of 3')).toBeTruthy()
      expect(within(dialog()).queryByRole('button', { name: 'Back' })).toBeNull()

      fireEvent.click(within(dialog()).getByLabelText('yes'))
      fireEvent.click(button('Next'))

      expect(within(dialog()).getByText('Question 2 of 3')).toBeTruthy()
      // The question is where focus goes, so a reader of the screen is told which step they are on.
      expect(document.activeElement?.textContent).toBe('Second?')

      fireEvent.change(within(dialog()).getByLabelText('Or answer in your own words'), { target: { value: 'maybe' } })
      fireEvent.click(button('Back'))
      expect((within(dialog()).getByLabelText('yes') as HTMLInputElement).checked).toBe(true)
      fireEvent.click(button('Next'))
      expect((within(dialog()).getByLabelText('Or answer in your own words') as HTMLTextAreaElement).value).toBe(
        'maybe'
      )
      fireEvent.click(button('Next'))

      expect(within(dialog()).getByText('Question 3 of 3')).toBeTruthy()
      expect(controller.respondClarify).not.toHaveBeenCalled()

      fireEvent.click(within(dialog()).getByLabelText('x'))
      fireEvent.click(within(dialog()).getByLabelText('y'))
      fireEvent.click(button('Submit'))
      await settle()

      expect(controller.respondClarify).toHaveBeenCalledExactlyOnceWith('researcher', 'srq-1', {
        q1: 'yes',
        q2: 'maybe',
        q3: 'x, y'
      })
    })

    it('Skip answers the step with an empty string and moves on; on the last step it sends everything', async () => {
      mount()
      clarify('researcher', 'srq-1', batch)

      fireEvent.click(within(dialog()).getByLabelText('no'))
      fireEvent.click(button('Next'))
      fireEvent.click(button('Skip'))

      expect(within(dialog()).getByText('Question 3 of 3')).toBeTruthy()

      fireEvent.click(button('Skip'))
      await settle()

      expect(controller.respondClarify).toHaveBeenCalledExactlyOnceWith('researcher', 'srq-1', {
        q1: 'no',
        q2: '',
        q3: ''
      })
    })

    it('locks one answer on the gateway without answering the request, and then it cannot be changed', async () => {
      mount()
      clarify('researcher', 'srq-1', batch)

      fireEvent.click(within(dialog()).getByLabelText('yes'))
      fireEvent.click(button('Lock answer'))
      await settle()

      expect(controller.lockClarify).toHaveBeenCalledExactlyOnceWith('researcher', 'srq-1', 'q1', 'yes')
      expect(controller.respondClarify).not.toHaveBeenCalled()
      expect(within(dialog()).getByText('Locked')).toBeTruthy()
      expect((within(dialog()).getByLabelText('no') as HTMLInputElement).disabled).toBe(true)
      expect(within(dialog()).queryByRole('button', { name: 'Lock answer' })).toBeNull()
    })

    it('keeps an answer that was locked before, and shows it', async () => {
      mount()
      clarify('researcher', 'srq-1', { ...batch, answers: { q1: 'no' } })

      expect(within(dialog()).getByText('Locked')).toBeTruthy()
      expect((within(dialog()).getByLabelText('no') as HTMLInputElement).checked).toBe(true)

      fireEvent.click(button('Next'))
      fireEvent.click(button('Skip'))
      fireEvent.click(button('Skip'))
      await settle()

      expect(controller.respondClarify).toHaveBeenCalledWith('researcher', 'srq-1', { q1: 'no', q2: '', q3: '' })
    })
  })
})
