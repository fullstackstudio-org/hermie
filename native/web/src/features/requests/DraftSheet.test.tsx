/**
 * The sheet for a `review.draft` request, in the request layer over the real interactive model and a hand-driven
 * connection: the draft as the characters it is (never Markdown, never a link), the subject and recipients apart,
 * Approve, Approve with changes and Reject with its comment, the original beside an edit, what the eye cannot see
 * made visible, the gateway's refusal, and the guard.
 */
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { REFUSED_CODE } from '../../core/requests/interactive'
import {
  button,
  dialog,
  draftFrame,
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

const RLO = String.fromCodePoint(0x202e)
const ZWSP = String.fromCodePoint(0x200b)

const editor = (): HTMLTextAreaElement => within(dialog()).getByLabelText('Draft') as HTMLTextAreaElement
const edit = (value: string): void => void fireEvent.change(editor(), { target: { value } })
const comment = (value: string): void =>
  void fireEvent.change(within(dialog()).getByLabelText('Reason for rejecting (optional)'), { target: { value } })

const press = async (name: string | RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}

describe('the sheet', () => {
  it('says what kind of draft it is in the app’s words, with the subject and the recipients apart from the body', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame({ recipients: ['bram@example.test', 'cleo@example.test'] }))

    expect(screen.getByRole('dialog', { name: 'A mail to review' })).toBe(dialog())
    expect(dialog().textContent).toContain('On gateway gw.example.test')
    expect(within(dialog()).getByText('Subject').nextElementSibling?.textContent).toBe('Re: lunch')

    const recipients = within(dialog()).getByRole('list', { name: 'Recipients' })

    expect(
      within(recipients)
        .getAllByRole('listitem')
        .map(item => item.textContent)
    ).toEqual(['bram@example.test', 'cleo@example.test'])
    expect(editor().value).toBe('Hi Bram,\n\nThursday works.\n\nAda')
    expect(dialog().textContent).toContain('Hermie does not keep them.')
  })

  it.each([
    ['post', 'A post to review'],
    ['message', 'A message to review'],
    ['document', 'A document to review']
  ])('is told apart by its kind: %s', (kind, title) => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame({ kind, subject: undefined, recipients: [] }))

    expect(screen.getByRole('dialog', { name: title })).toBe(dialog())
    expect(within(dialog()).queryByText('Subject')).toBeNull()
    expect(within(dialog()).queryByText('Recipients')).toBeNull()
  })

  it('shows the draft verbatim, in a monospaced box that never wraps, and renders none of it', () => {
    const text = '# Heading\n\n**bold** [a link](https://evil.test) <b>tag</b>\n    indented\n\n\n\nlast'

    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame({ text, editable: false }))

    const body = dialog().querySelector<HTMLElement>('[data-draft-text]')

    expect(body?.tagName).toBe('PRE')
    expect(body?.textContent).toBe(text)
    expect(body?.className).toContain('hm-draft__text')
    expect(within(dialog()).queryByRole('textbox', { name: 'Draft' })).toBeNull()
    expect(dialog().querySelector('a, b, strong, h1, em')).toBeNull()
    expect(dialog().textContent).toContain('This text cannot be changed here.')
  })

  it('edits in a textarea that keeps its lines unwrapped and checks nothing for spelling', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())

    expect(editor().getAttribute('wrap')).toBe('off')
    expect(editor().getAttribute('spellcheck')).toBe('false')
    expect(editor().className).toContain('hm-draft__editor')
    expect(dialog().textContent).toContain('You can change the text before you approve it.')
  })

  it('offers no Skip: the person rejects', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame({ optional: true }))

    expect(queryButton('Skip')).toBeNull()
    expect(button('Reject')).toBeTruthy()
    expect(button('Approve')).toBeTruthy()
  })
})

describe('approving', () => {
  it('sends the text as it is when it was not changed', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    await press('Approve')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', text: 'Hi Bram,\n\nThursday works.\n\nAda' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says "with changes" once the text differs, shows the original beside it, and sends the edit', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())

    expect(within(dialog()).queryByText('The original from the bot')).toBeNull()

    edit('Hi Bram,\n\nFriday works better.\n\nAda')

    expect(button('Approve with changes')).toBeTruthy()
    expect(within(dialog()).queryByRole('button', { name: 'Approve' })).toBeNull()

    const original = within(dialog()).getByText('The original from the bot')
    const box = document.getElementById(original.id)?.nextElementSibling

    expect(box?.textContent).toBe('Hi Bram,\n\nThursday works.\n\nAda')

    await press('Approve with changes')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', text: 'Hi Bram,\n\nFriday works better.\n\nAda' })
  })

  it('counts a change that is only whitespace at the end of a line as no change, as the gateway does', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit('Hi Bram,  \n\nThursday works.\t\n\nAda\n\n')

    expect(button('Approve')).toBeTruthy()
  })

  it('goes back to the original on request', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit('something else')
    fireEvent.click(button('Back to the original'))

    expect(editor().value).toBe('Hi Bram,\n\nThursday works.\n\nAda')
    expect(button('Approve')).toBeTruthy()
  })

  it('sends a draft that cannot be edited as it came', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame({ editable: false }))
    await press('Approve')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', text: 'Hi Bram,\n\nThursday works.\n\nAda' })
  })

  it('will not approve an empty draft, and says why', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit('')

    expect((button('Approve with changes') as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog()).getByText('The draft cannot be empty.')).toBeTruthy()
    expect(editor().getAttribute('aria-invalid')).toBe('true')
    expect(button('Approve with changes').getAttribute('aria-describedby')).toBeTruthy()
  })
})

describe('what the eye cannot see', () => {
  it('is counted and shown by its code point, the approval waits, and one press removes it', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit(`Pay ${RLO}txt.exe${ZWSP} now`)

    expect(within(dialog()).getByText(/The text holds 2 characters that you cannot see/u)).toBeTruthy()
    expect((button('Approve with changes') as HTMLButtonElement).disabled).toBe(true)

    const preview = within(dialog()).getByText('The text with those characters shown').id

    expect(document.getElementById(preview)?.nextElementSibling?.textContent).toBe('Pay [U+202E]txt.exe[U+200B] now')

    fireEvent.click(button('Remove them'))

    expect(editor().value).toBe('Pay txt.exe now')
    expect(within(dialog()).queryByText(/characters that you cannot see/u)).toBeNull()

    await press('Approve with changes')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', text: 'Pay txt.exe now' })
  })

  it('treats a tab like one of them: the gateway refuses it', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit('a\tb')

    expect(within(dialog()).getByText(/The text holds 1 character that you cannot see/u)).toBeTruthy()
    expect(within(dialog()).getByText('The text with those characters shown')).toBeTruthy()
    expect((button('Approve with changes') as HTMLButtonElement).disabled).toBe(true)
  })

  it('does not stop a rejection', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit(`bad${RLO}text`)
    await press('Reject')

    expect(lastAnswer(harness)).toEqual({ decision: 'rejected' })
  })
})

describe('rejecting', () => {
  it('sends the decision, and the comment when there is one', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    comment('  Too informal for Bram.  ')
    await press('Reject')

    expect(lastAnswer(harness)).toEqual({ decision: 'rejected', comment: 'Too informal for Bram.' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves the comment out when it is empty or only blank', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    comment('   \n ')
    await press('Reject')

    expect(lastAnswer(harness)).toEqual({ decision: 'rejected' })
  })

  it('will not send a comment of more than 1,000 characters, and says so', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    comment('x'.repeat(1001))

    expect((button('Reject') as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog()).getByText('At most 1000 characters.')).toBeTruthy()

    comment('x'.repeat(1000))

    expect((button('Reject') as HTMLButtonElement).disabled).toBe(false)
  })

  it('does not take the comment into an approval', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    comment('never mind')
    await press('Approve')

    expect(lastAnswer(harness)).toEqual({ decision: 'approved', text: 'Hi Bram,\n\nThursday works.\n\nAda' })
  })
})

describe('the gateway’s refusal', () => {
  const refuse = (reason: string) => () => {
    throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason } })
  }

  it('says text:not_verbatim in words, keeps the text, and goes away once the text is changed', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit('Hi Bram, a new line')
    harness.gw.onCall.handler = refuse('text:not_verbatim')
    await press('Approve with changes')

    expect(within(dialog()).getByRole('alert').textContent).toContain('cannot be sent as they are')
    expect(editor().value).toBe('Hi Bram, a new line')

    edit('Hi Bram, a newer line')

    expect(within(dialog()).queryByRole('alert')).toBeNull()
  })

  it('says text:edited in words, and any other reason as the gateway gave it', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame({ editable: false }))
    harness.gw.onCall.handler = refuse('text:edited')
    await press('Approve')

    expect(within(dialog()).getByRole('alert').textContent).toContain('This draft cannot be changed.')

    harness.gw.onCall.handler = refuse('bad_shape')
    await press('Approve')

    expect(within(dialog()).getByRole('alert').textContent).toBe('The gateway did not accept this answer (bad_shape).')
  })
})

describe('the guard and the connection', () => {
  it('takes nothing for a moment after it appears', async () => {
    mount(harness, { tapGuardMs: 40 })
    raise(harness, 'srq-1', 'review.draft', draftFrame())

    expect((button('Approve') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Reject') as HTMLButtonElement).disabled).toBe(true)
    expect(editor().disabled).toBe(true)

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })

    expect((button('Approve') as HTMLButtonElement).disabled).toBe(false)
    expect(editor().disabled).toBe(false)
  })

  it('says so and keeps the edit when the connection is down', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    edit('an edit')
    act(() => harness.gw.status('connecting'))
    await press('Approve with changes')

    expect(within(dialog()).getByText(/Not connected to the gateway/u)).toBeTruthy()
    expect(harness.gw.calls).toEqual([])
    expect(editor().value).toBe('an edit')
  })

  it('does not close on Escape', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(screen.getByRole('dialog')).toBe(dialog())
  })

  it('answers once however often Approve is pressed, and keeps its buttons off while the answer is on its way', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())

    let release: (value: unknown) => void = () => undefined

    harness.gw.onCall.handler = () => new Promise(resolve => (release = resolve))

    await act(async () => {
      fireEvent.click(button('Approve'))
      fireEvent.click(button('Approve'))
    })

    expect(harness.gw.calls).toHaveLength(1)
    expect((button('Approve') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Reject') as HTMLButtonElement).disabled).toBe(true)

    await act(async () => release({ status: 'ok' }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('goes when the gateway answers elsewhere, and says so', () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame())
    act(() => harness.gw.cancel('srq-1', 'resolved'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toContain('answered on another device')
  })
})
