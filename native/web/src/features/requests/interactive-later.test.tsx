/**
 * Later and Don't share on the interactive sheets, in the request layer over the real model:
 *
 *  - **Later** (the button, and Escape) puts the sheet away without answering. The page is usable again (nothing
 *    inert, the composer reachable), the request still waits on the gateway, and what was entered stays in the sheet
 *    while it is away: Open (the store the transcript's record uses) brings the same sheet back. A request that ends
 *    while away is forgotten.
 *  - **Don't share** on a form and a file request answers `4041 cannot_show` with reason `declined`: the person's
 *    choice, never an answer. It is never the default button, and a draft has none (Reject is its refusal).
 *  - **Return** in a one-line field does not send the form.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { interactiveStore } from '../../state/interactive'
import { requestLaterStore } from '../../state/request-later'
import { interactiveKey } from '../../state/requests'
import {
  button,
  dialog,
  draftFrame,
  fileFrame,
  formFrame,
  type Harness,
  lastAnswer,
  mount,
  queryButton,
  raise,
  setup,
  teardown
} from '../../test-support/interactive-layer'
import { preloadRequestSheets } from './request-sheets'

beforeAll(async () => {
  await preloadRequestSheets()
})

let harness: Harness

beforeEach(() => {
  harness = setup()
})

afterEach(() => teardown(harness))

const NAME = [{ id: 'name', kind: 'text', label: 'Name' }]
const key = (id: string): string => interactiveKey(id)
const field = (label: RegExp): HTMLInputElement => within(dialog()).getByLabelText(label) as HTMLInputElement

describe('Later', () => {
  it.each([
    ['input.form', () => formFrame(NAME, { optional: false })],
    ['input.file', () => fileFrame({ optional: false })],
    ['review.draft', () => draftFrame()]
  ])('puts a %s away without answering, and the page is usable', (method, frame) => {
    mount(harness)
    raise(harness, 'srq-1', method, frame())
    fireEvent.click(button('Later'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requestLaterStore.getState().away).toEqual([key('srq-1')])
    expect(harness.gw.calls).toEqual([])
    expect(harness.gw.declined).toEqual([])
    expect(interactiveStore.getState().requests).toHaveLength(1)
    // The page behind is not inert any more: the field is reachable.
    expect(document.querySelector('main textarea')?.closest('[inert]')).toBeNull()
  })

  it('is what Escape does on these sheets, and on no other', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(requestLaterStore.getState().away).toEqual([key('srq-1')])
  })

  it('keeps what was typed while the sheet is away, and brings the same sheet back on Open', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    fireEvent.change(field(/^Name/u), { target: { value: 'Ada Lovelace' } })
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(screen.queryByRole('dialog')).toBeNull()

    act(() => requestLaterStore.getState().bringBack(key('srq-1')))

    expect(screen.getByRole('dialog', { name: 'A form to fill in' })).toBe(dialog())
    expect(field(/^Name/u).value).toBe('Ada Lovelace')
    expect(document.activeElement).toBe(dialog())
  })

  it('keeps an edited draft and picked files while away', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    fireEvent.change(within(dialog()).getByLabelText('Draft'), { target: { value: 'My own words' } })
    fireEvent.click(button('Later'))
    act(() => requestLaterStore.getState().bringBack(key('srq-1')))

    expect((within(dialog()).getByLabelText('Draft') as HTMLTextAreaElement).value).toBe('My own words')

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'input.file', fileFrame())
    fireEvent.change(dialog().querySelector('[data-file-picker]') as HTMLInputElement, {
      target: { files: [new File(['x'], 'receipt.txt', { type: 'text/plain' })] }
    })
    fireEvent.click(button('Later'))
    act(() => requestLaterStore.getState().bringBack(key('srq-2')))

    expect(within(dialog()).getByText('receipt.txt')).toBeTruthy()
  })

  it('answers from the sheet once it is back', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    fireEvent.change(field(/^Name/u), { target: { value: 'Ada' } })
    fireEvent.click(button('Later'))
    act(() => requestLaterStore.getState().bringBack(key('srq-1')))
    await act(async () => {
      fireEvent.click(button('Send answers'))
    })

    expect(lastAnswer(harness)).toEqual({ status: 'answered', values: { name: 'Ada' } })
    expect(requestLaterStore.getState().away).toEqual([])
  })

  it('shows the next request while one is away, and counts only those that wait to be shown', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    raise(harness, 'srq-2', 'review.draft', draftFrame())
    raise(harness, 'srq-3', 'review.draft', draftFrame({ title: 'Third' }))

    expect(within(dialog()).getByText('2 more waiting')).toBeTruthy()

    fireEvent.click(button('Later'))

    expect(screen.getByRole('dialog', { name: 'A mail to review' })).toBe(dialog())
    expect(within(dialog()).getByText('1 more waiting')).toBeTruthy()
  })

  it('forgets a request that ended while it was away', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    fireEvent.click(button('Later'))
    act(() => harness.gw.cancel('srq-1', 'interrupted'))

    expect(requestLaterStore.getState().away).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('.hm-requests__holder')).toBeNull()
  })

  it('keeps an upload going while the sheet is away', async () => {
    let finish: (value: unknown) => void = () => undefined
    const calls: string[] = []

    mount(harness, {
      uploadFileTo: path => {
        calls.push(path)

        return new Promise(resolve => (finish = resolve))
      }
    })
    raise(harness, 'srq-1', 'input.file', fileFrame())
    fireEvent.change(dialog().querySelector('[data-file-picker]') as HTMLInputElement, {
      target: { files: [new File(['x'], 'receipt.txt', { type: 'text/plain' })] }
    })
    await act(async () => {
      fireEvent.click(button('Upload and send'))
    })
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 40))
    })
    fireEvent.click(button('Later'))
    await act(async () => finish({}))
    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 20))
    })

    expect(calls).toHaveLength(1)
    expect(lastAnswer(harness)).toMatchObject({ status: 'answered' })
    expect(interactiveStore.getState().requests).toHaveLength(0)
  })
})

describe("Don't share", () => {
  it.each([
    ['input.form', () => formFrame(NAME, { optional: false })],
    ['input.file', () => fileFrame({ optional: false })]
  ])('on a %s: 4041 cannot_show with reason declined, never an answer', (method, frame) => {
    mount(harness)
    raise(harness, 'srq-1', method, frame())

    expect(queryButton('Skip')).toBeNull()

    fireEvent.click(button("Don't share"))

    expect(harness.gw.declined).toEqual([{ id: 'srq-1', code: 4041, message: 'cannot_show', reason: 'declined' }])
    expect(harness.gw.calls).toEqual([])
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(interactiveStore.getState().notices.researcher?.notice).toEqual({
      kind: 'cannot_show',
      method,
      reason: 'declined'
    })
  })

  it('is never the default button: Send (or Upload and send) is the one that is filled', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))

    expect(button("Don't share").getAttribute('data-variant')).toBe('quiet')
    expect(button('Send answers').getAttribute('data-variant')).toBe('primary')
    expect(button('Send answers').getAttribute('type')).toBe('submit')
    expect(button("Don't share").getAttribute('type')).toBe('button')

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'input.file', fileFrame({ optional: false }))

    expect(button("Don't share").getAttribute('data-variant')).toBe('quiet')
    expect(button('Upload and send').getAttribute('data-variant')).toBe('primary')
  })

  it('is not on a draft: Reject is its refusal', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())

    expect(queryButton("Don't share")).toBeNull()
  })

  it('says so, and sends nothing, while the connection is down', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    act(() => harness.gw.status('connecting'))
    fireEvent.click(button("Don't share"))

    expect(within(dialog()).getByText(/Not connected to the gateway/u)).toBeTruthy()
    expect(harness.gw.declined).toEqual([])
  })

  it('is said in the reader’s own words in Dutch and German', async () => {
    const { setLanguageChoice } = await import('../../i18n/locale')

    await setLanguageChoice('nl')
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))

    expect(button('Niet delen')).toBeTruthy()
    expect(button('Later')).toBeTruthy()

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    await setLanguageChoice('de')
    raise(harness, 'srq-2', 'input.form', formFrame(NAME, { optional: false }))

    expect(button('Nicht teilen')).toBeTruthy()
    expect(button('Später')).toBeTruthy()
  })
})

describe('Return in a form', () => {
  it('in a one-line field does not send it; only the Send button does', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([...NAME, { id: 'when', kind: 'date', label: 'When' }]))
    fireEvent.change(field(/^Name/u), { target: { value: 'Ada' } })

    const held = fireEvent.keyDown(field(/^Name/u), { key: 'Enter' })
    const dateHeld = fireEvent.keyDown(field(/^When/u), { key: 'Enter' })

    // `false`: a handler called preventDefault, which is what stops the browser's implicit submission.
    expect(held).toBe(false)
    expect(dateHeld).toBe(false)
    expect(harness.gw.calls).toEqual([])

    await act(async () => {
      fireEvent.click(button('Send answers'))
    })

    expect(lastAnswer(harness)).toEqual({ status: 'answered', values: { name: 'Ada' } })
  })

  it('in a textarea keeps being a line break', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'notes', kind: 'text', label: 'Notes', multiline: true }]))

    expect(fireEvent.keyDown(field(/^Notes/u), { key: 'Enter' })).toBe(true)
  })

  it('on the Send button sends, as a button does', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME))
    await act(async () => {
      fireEvent.click(button('Send answers'))
    })

    expect(harness.gw.calls).toHaveLength(1)
  })
})

/** Real time: the sheets' own guard runs on the page's clock. */
const wait = (ms: number): Promise<void> =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, ms))
  })

const disabled = (name: string | RegExp): boolean => (button(name) as HTMLButtonElement).disabled

describe('the tap guard runs from the moment a sheet is shown', () => {
  const GUARD = 60

  it('guards a sheet that appears behind another that was answered: a second click cannot approve unread mail', async () => {
    mount(harness, { tapGuardMs: GUARD })
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    raise(harness, 'srq-2', 'review.draft', draftFrame())
    // The form's own guard ends; the draft behind it has been mounted all that time.
    await wait(GUARD * 3)
    expect(disabled('Send answers')).toBe(false)

    await act(async () => {
      fireEvent.click(button('Send answers'))
      // The double click: its second half, at once.
      fireEvent.click(button('Send answers'))
    })

    expect(screen.getByRole('dialog', { name: 'A mail to review' })).toBe(dialog())
    expect(disabled('Approve')).toBe(true)
    expect(disabled('Reject')).toBe(true)
    expect(within(dialog()).getByLabelText('Draft')).toHaveProperty('disabled', true)

    // A click on it now answers nothing.
    fireEvent.click(button('Approve'))
    expect(harness.gw.calls.filter(call => call.params.id === 'srq-2')).toEqual([])

    await wait(GUARD * 3)

    expect(disabled('Approve')).toBe(false)
  })

  it('starts over when a sheet that was put away is opened again', async () => {
    mount(harness, { tapGuardMs: GUARD })
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    await wait(GUARD * 3)
    expect(disabled('Send answers')).toBe(false)

    fireEvent.click(button('Later'))
    act(() => requestLaterStore.getState().bringBack(key('srq-1')))

    expect(disabled('Send answers')).toBe(true)
    expect(disabled("Don't share")).toBe(true)
    expect(field(/^Name/u).matches(':disabled')).toBe(true)

    await wait(GUARD * 3)

    expect(disabled('Send answers')).toBe(false)
  })

  it('is unchanged for a sheet that simply appears: off for a moment, then on', async () => {
    mount(harness, { tapGuardMs: GUARD })
    raise(harness, 'srq-1', 'review.draft', draftFrame())

    expect(disabled('Approve')).toBe(true)

    await wait(GUARD * 3)

    expect(disabled('Approve')).toBe(false)
  })

  it('guards a sheet queued behind one that was put away, and one that is the next of several', async () => {
    mount(harness, { tapGuardMs: GUARD })
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    raise(harness, 'srq-2', 'input.file', fileFrame({ optional: false }))
    await wait(GUARD * 3)
    fireEvent.click(button('Later'))

    expect(screen.getByRole('dialog', { name: 'Files to upload' })).toBe(dialog())
    expect(disabled("Don't share")).toBe(true)

    await wait(GUARD * 3)

    expect(disabled("Don't share")).toBe(false)
  })
})

describe('what is said when a request ends', () => {
  it('is said for the sheet that was on screen, even while another is put away', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    raise(harness, 'srq-2', 'review.draft', draftFrame())
    // A is first in the queue and put away; B is the one shown.
    fireEvent.click(button('Later'))
    expect(screen.getByRole('dialog', { name: 'A mail to review' })).toBe(dialog())

    act(() => harness.gw.cancel('srq-2', 'interrupted'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(
      'The request from Dr. Researcher was withdrawn.'
    )
  })

  it('does not say a put-away sheet left when it only went away', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    fireEvent.click(button('Later'))

    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('')
  })
})

describe('Escape while an input method is composing', () => {
  it('is the input method’s, not Later', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(NAME, { optional: false }))
    fireEvent.keyDown(field(/^Name/u), { key: 'Escape', isComposing: true })

    expect(screen.getByRole('dialog')).toBe(dialog())
    expect(requestLaterStore.getState().away).toEqual([])
  })
})
