/**
 * The order of the sheets in the request layer, over the real interactive model: a question that stops a bot (an
 * approval here; a clarify, a confirmation and a secure prompt go through the same rule) comes before a form, a file
 * request or a draft that is open, like the native apps' `ChatSheetOrder`.
 *
 *  - The interactive sheet steps aside WITHOUT answering and without losing what was typed or picked in it, and comes
 *    back by itself once the questions are done. It is not Later: a sheet the person put away stays away until Open.
 *  - Except while it is sending an answer or uploading: the question then waits until that is over.
 *  - The tap guard starts over for every sheet that becomes the shown one, in both directions.
 *
 * Every test runs with a tap guard that is not zero, because that is the one thing a zero guard cannot show.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { chatsStore } from '../../state/chats'
import { requestLaterStore } from '../../state/request-later'
import { requestsStore } from '../../state/requests'
import { chatWith } from '../../test-support/chat-fixtures'
import {
  button,
  dialog,
  draftFrame,
  fileFrame,
  formFrame,
  type Harness,
  lastAnswer,
  raise,
  setup,
  teardown
} from '../../test-support/interactive-layer'
import { ChatRuntimeContext, type ChatScreenController } from '../chat/chat-runtime'
import { InteractiveRuntimeContext } from './interactive-runtime'
import { preloadRequestSheets } from './request-sheets'
import { RequestLayer } from './RequestLayer'

beforeAll(async () => {
  await preloadRequestSheets()
})

const GUARD = 60
const NAME = [{ id: 'name', kind: 'text', label: 'Name' }]
const FORM = 'A form to fill in'
const APPROVAL = 'Allow this command?'

let harness: Harness
let respondApproval: ReturnType<typeof vi.fn>
let uploadFileTo: ReturnType<typeof vi.fn>

beforeEach(() => {
  harness = setup()
  chatsStore.getState().hydrate('writer', chatWith('writer', [], { runtimeSessionId: 'rt-writer' }))
  chatsStore.getState().bindRuntime('writer', 'rt-writer')
  respondApproval = vi.fn(async (bot: string, id: string, choice: string) => {
    chatsStore.getState().answer(bot, id, choice)
  })
  uploadFileTo = vi.fn(async () => ({}))
})

afterEach(() => teardown(harness))

function mount(): void {
  const controller = {
    respondApproval,
    acknowledgeApproval: vi.fn(async () => undefined),
    uploadFileTo
  } as unknown as ChatScreenController

  render(
    <ChatRuntimeContext.Provider value={{ controller, gatewayBaseUrl: 'http://gateway.test' }}>
      <InteractiveRuntimeContext.Provider value={harness.model}>
        <main>
          <label>
            Draft
            <textarea />
          </label>
        </main>
        <RequestLayer tapGuardMs={GUARD} />
      </InteractiveRuntimeContext.Provider>
    </ChatRuntimeContext.Provider>
  )
}

const approval = (bot: string, id: string, command = 'rm -rf ./build'): void =>
  void act(() =>
    chatsStore.getState().dispatchServerRequest(bot, {
      id,
      method: 'approval',
      params: { command, description: 'Remove the build directory', request_id: `a-${id}` }
    })
  )

/** Real time: the sheets' own guard runs on the page's clock. */
const wait = (ms: number): Promise<void> =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, ms))
  })

const disabled = (name: string | RegExp): boolean => (button(name) as HTMLButtonElement).disabled
const named = (name: string): HTMLElement => screen.getByRole('dialog', { name })
const field = (): HTMLInputElement => within(dialog()).getByLabelText(/^Name/u) as HTMLInputElement
const said = (): string => document.querySelector('[aria-live="polite"]')?.textContent ?? ''
/** The parked sheets: in the page, hidden, with what was entered in them. */
const parked = (): HTMLElement => document.querySelector('.hm-requests__parking') as HTMLElement

/** A form that is open, its guard over, with a name typed in it. */
async function openFormWithName(): Promise<void> {
  mount()
  raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
  await wait(GUARD * 3)
  fireEvent.change(field(), { target: { value: 'Ada Lovelace' } })
}

describe('an approval that arrives while a form is open', () => {
  it('is shown first, and the form is parked with what was typed, not answered and not put away', async () => {
    await openFormWithName()
    approval('researcher', 'srq-a')

    expect(named(APPROVAL)).toBe(dialog())
    expect(within(dialog()).getByText('1 more waiting')).toBeTruthy()
    // The form is not in the dialog but alive in the parking place, its field as it was left.
    expect(within(dialog()).queryByLabelText(/^Name/u)).toBeNull()
    expect((within(parked()).getByLabelText(/^Name/u) as HTMLInputElement).value).toBe('Ada Lovelace')
    expect(harness.gw.calls).toEqual([])
    expect(harness.gw.declined).toEqual([])
    expect(requestLaterStore.getState().away).toEqual([])
    expect(document.activeElement).toBe(dialog())
    expect(said()).toMatch(/^A question needs your answer first\./u)
  })

  it('brings the form back by itself when the approval is answered, with the text intact', async () => {
    await openFormWithName()
    approval('researcher', 'srq-a')
    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    expect(respondApproval).toHaveBeenCalledTimes(1)
    expect(named(FORM)).toBe(dialog())
    expect(field().value).toBe('Ada Lovelace')
    expect(document.activeElement).toBe(dialog())

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Send answers'))
    })

    expect(lastAnswer(harness)).toEqual({ status: 'answered', values: { name: 'Ada Lovelace' } })
  })

  it('guards the approval from the moment it is shown over the form, and the form again when it comes back', async () => {
    await openFormWithName()
    // The form's guard is spent; the approval arrives, and a click meant for the form lands on the approval.
    approval('researcher', 'srq-a')

    expect(disabled('Allow once')).toBe(true)
    expect(disabled('Deny')).toBe(true)

    fireEvent.click(button('Allow once'))

    expect(respondApproval).not.toHaveBeenCalled()

    await wait(GUARD * 3)

    expect(disabled('Allow once')).toBe(false)

    // The double click: the second half lands on whatever the first half revealed, the form.
    await act(async () => {
      fireEvent.click(button('Allow once'))
      fireEvent.click(button('Allow once'))
    })

    expect(respondApproval).toHaveBeenCalledTimes(1)
    expect(named(FORM)).toBe(dialog())
    expect(disabled('Send answers')).toBe(true)
    expect(disabled("Don't share")).toBe(true)
    expect(field().matches(':disabled')).toBe(true)

    fireEvent.click(button('Send answers'))

    expect(harness.gw.calls).toEqual([])

    await wait(GUARD * 3)

    expect(disabled('Send answers')).toBe(false)
  })

  it('also puts a file request and a draft aside, and brings each back', async () => {
    mount()
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    await wait(GUARD * 3)
    fireEvent.change(within(dialog()).getByLabelText('Draft'), { target: { value: 'My own words' } })
    approval('researcher', 'srq-a')

    expect(named(APPROVAL)).toBe(dialog())

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    expect(named('A mail to review')).toBe(dialog())
    expect((within(dialog()).getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('My own words')

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'input.file', fileFrame())
    approval('researcher', 'srq-b')

    expect(named(APPROVAL)).toBe(dialog())
  })

  it('goes before a form that is queued behind another, whatever the order they came in', async () => {
    mount()
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    raise(harness, 'srq-2', 'review.draft', draftFrame())
    approval('researcher', 'srq-a')

    expect(named(APPROVAL)).toBe(dialog())
    expect(within(dialog()).getByText('2 more waiting')).toBeTruthy()

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    // The sheets keep their own order: the form, which came first, then the draft.
    expect(named(FORM)).toBe(dialog())
    expect(within(dialog()).getByText('1 more waiting')).toBeTruthy()
  })
})

describe('the order among the questions themselves', () => {
  it('stays the order they were first seen in, with the form after both', async () => {
    mount()
    approval('researcher', 'srq-a', 'echo first')
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    approval('writer', 'srq-b', 'echo second')

    expect(within(dialog()).getByText('echo first')).toBeTruthy()
    expect(within(dialog()).getByText('2 more waiting')).toBeTruthy()

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    expect(within(dialog()).getByText('echo second')).toBeTruthy()

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    expect(named(FORM)).toBe(dialog())
    expect(requestsStore.getState().queue.map(entry => entry.kind)).toEqual(['interactive'])
  })

  it('is oldest first, as before, when there is no interactive request at all', async () => {
    mount()
    approval('researcher', 'srq-a', 'echo first')
    approval('writer', 'srq-b', 'echo second')

    expect(within(dialog()).getByText('echo first')).toBeTruthy()

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    expect(within(dialog()).getByText('echo second')).toBeTruthy()

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('an interactive sheet that is in the middle of something', () => {
  it('is not stepped over while its answer is on its way: the approval waits, and goes next', async () => {
    let settle: (value: unknown) => void = () => undefined

    harness.gw.onCall.handler = () => new Promise(resolve => (settle = resolve))
    await openFormWithName()
    await act(async () => {
      fireEvent.click(button('Send answers'))
    })
    approval('researcher', 'srq-a')

    expect(named(FORM)).toBe(dialog())
    expect(within(dialog()).getByText('1 more waiting')).toBeTruthy()
    expect(said()).toBe('')

    await act(async () => settle({ status: 'ok' }))

    expect(named(APPROVAL)).toBe(dialog())
    expect(within(dialog()).queryByText(/more waiting/u)).toBeNull()
  })

  it('gives way once an answer that did not get through is over, keeping what was typed', async () => {
    let fail: (error: Error) => void = () => undefined

    harness.gw.onCall.handler = () => new Promise((_resolve, reject) => (fail = reject))
    await openFormWithName()
    await act(async () => {
      fireEvent.click(button('Send answers'))
    })
    approval('researcher', 'srq-a')

    expect(named(FORM)).toBe(dialog())

    await act(async () => fail(new Error('socket closed')))

    expect(named(APPROVAL)).toBe(dialog())
    expect((within(parked()).getByLabelText(/^Name/u) as HTMLInputElement).value).toBe('Ada Lovelace')
  })

  it('is not stepped over while files are uploading: the approval waits for the upload and the answer', async () => {
    let finish: (value: unknown) => void = () => undefined

    uploadFileTo.mockImplementation(() => new Promise(resolve => (finish = resolve)))
    mount()
    raise(harness, 'srq-1', 'input.file', fileFrame({ optional: false }))
    await wait(GUARD * 3)
    fireEvent.change(dialog().querySelector('[data-file-picker]') as HTMLInputElement, {
      target: { files: [new File(['x'], 'receipt.txt', { type: 'text/plain' })] }
    })
    await act(async () => {
      fireEvent.click(button('Upload and send'))
    })
    await wait(40)
    approval('researcher', 'srq-a')

    expect(named('Files to upload')).toBe(dialog())

    await act(async () => finish({}))
    await wait(20)

    expect(lastAnswer(harness)).toMatchObject({ status: 'answered' })
    expect(named(APPROVAL)).toBe(dialog())
  })

  it('is stepped over once the person puts the uploading sheet away: Later is theirs to choose', async () => {
    uploadFileTo.mockImplementation(() => new Promise(() => undefined))
    mount()
    raise(harness, 'srq-1', 'input.file', fileFrame({ optional: false }))
    await wait(GUARD * 3)
    fireEvent.change(dialog().querySelector('[data-file-picker]') as HTMLInputElement, {
      target: { files: [new File(['x'], 'receipt.txt', { type: 'text/plain' })] }
    })
    await act(async () => {
      fireEvent.click(button('Upload and send'))
    })
    await wait(40)
    approval('researcher', 'srq-a')
    fireEvent.click(button(/^Later$/u))

    expect(named(APPROVAL)).toBe(dialog())
  })
})

describe('a form the person put away (Later)', () => {
  it('stays away through an approval, and comes back only on Open, with what was typed', async () => {
    await openFormWithName()
    fireEvent.click(button('Later'))
    approval('researcher', 'srq-a')

    expect(named(APPROVAL)).toBe(dialog())
    expect(within(dialog()).queryByText(/more waiting/u)).toBeNull()
    expect(said()).toBe('')

    await wait(GUARD * 3)
    await act(async () => {
      fireEvent.click(button('Allow once'))
    })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requestLaterStore.getState().away).toHaveLength(1)

    const [key] = requestLaterStore.getState().away

    act(() => requestLaterStore.getState().bringBack(key ?? ''))

    expect(named(FORM)).toBe(dialog())
    expect(field().value).toBe('Ada Lovelace')
  })

  it('opened while a question waits for its answer, comes after the question', async () => {
    await openFormWithName()
    fireEvent.click(button('Later'))
    approval('researcher', 'srq-a')

    const [key] = requestLaterStore.getState().away

    act(() => requestLaterStore.getState().bringBack(key ?? ''))

    expect(named(APPROVAL)).toBe(dialog())
    expect(within(dialog()).getByText('1 more waiting')).toBeTruthy()
  })
})
