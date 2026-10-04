/**
 * The sheet for an `input.form` request, in the request layer, over the real interactive model and a hand-driven
 * connection: every field kind with its native input, what each puts on the wire, the page's own check (the
 * gateway's problem names, next to the field), the gateway's refusal shown next to its field without the sheet
 * being rebuilt, Skip, the guard, offline, the words of the request as plain text, and what is never kept.
 */
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { deviceZone } from '../../core/requests/form-values'
import { REFUSED_CODE } from '../../core/requests/interactive'
import { chatsStore } from '../../state/chats'
import { interactiveStore } from '../../state/interactive'
import { requestsStore } from '../../state/requests'
import {
  button,
  dialog,
  formFrame,
  type Harness,
  lastAnswer,
  mount,
  NOW_SECONDS,
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

const FIELDS = [
  { id: 'name', kind: 'text', label: 'Name on the booking', required: true, max_length: 20 },
  { id: 'guests', kind: 'number', label: 'Guests', required: true, min: 1, max: 12, integer: true, default: 2 },
  { id: 'stay', kind: 'daterange', label: 'Stay', required: true, min: '2026-10-05', max: '2026-12-31' },
  { id: 'budget', kind: 'amount', label: 'Budget per night', currency: 'EUR', min: '0', max: '5000' },
  { id: 'arrival', kind: 'date', label: 'Arrival', min: '2026-10-05', max: '2026-12-31', tz: 'Europe/Amsterdam' },
  { id: 'check_in', kind: 'time', label: 'Check-in time', min: '08:00', max: '18:00' },
  { id: 'call_at', kind: 'datetime', label: 'When may we call?', tz: 'Europe/Amsterdam' },
  { id: 'remind_at', kind: 'datetime', label: 'Remind me at' },
  {
    id: 'room',
    kind: 'choice',
    label: 'Room',
    options: [
      { value: 'single', label: 'Single' },
      { value: 'double', label: 'Double' }
    ]
  },
  {
    id: 'extras',
    kind: 'choice',
    label: 'Extras',
    multiple: true,
    max_selected: 2,
    options: [
      { value: 'breakfast', label: 'Breakfast' },
      { value: 'parking', label: 'Parking' },
      { value: 'late_checkout', label: 'Late check-out' }
    ]
  },
  { id: 'newsletter', kind: 'toggle', label: 'Send me offers', default: false },
  { id: 'notes', kind: 'text', label: 'Anything we should know?', multiline: true, hint: 'Allergies, arrival time.' }
]

const control = (label: string | RegExp): HTMLInputElement => within(dialog()).getByLabelText(label) as HTMLInputElement
const type = (label: string | RegExp, value: string): void =>
  void fireEvent.change(control(label), { target: { value } })

/** Press a button and let the answer's promise settle. */
const press = async (name: string | RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(button(name))
  })
}

/** Fill in everything the form needs, the way a person would. */
function fillIn(): void {
  type(/Name on the booking/u, 'Ada Lovelace')
  type(/^Guests/u, '4')
  fireEvent.change(within(dialog()).getByLabelText('From'), { target: { value: '2026-11-14' } })
  fireEvent.change(within(dialog()).getByLabelText('To'), { target: { value: '2026-11-16' } })
  type(/Budget per night/u, '1250.50')
  type(/^Arrival/u, '2026-11-14')
  type(/Check-in time/u, '14:30')
  type(/When may we call/u, '2026-10-07T14:30')
  type(/Remind me at/u, '2026-10-07T08:30')
  fireEvent.click(within(dialog()).getByLabelText('Double'))
  fireEvent.click(within(dialog()).getByLabelText('Breakfast'))
  fireEvent.click(within(dialog()).getByLabelText('Parking'))
  fireEvent.click(within(dialog()).getByLabelText(/Send me offers/u))
  type(/Anything we should know/u, 'Arriving late.\nNo nuts, please.')
}

describe('the sheet', () => {
  it('says what it is in the app’s words and quotes the bot’s own as plain text', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame([{ id: 'name', kind: 'text', label: 'Name' }], {
        title: 'Hotel **booking** <b>details</b>',
        summary: 'Fill [this](https://evil.test) in.',
        detail: 'Open invoices: 2026-041',
        acting_user: { id: 'u1', name: 'Ada' }
      })
    )

    expect(screen.getByRole('dialog', { name: 'A form to fill in' })).toBe(dialog())
    expect(dialog().querySelector('.hm-requests__from')?.textContent).toBe('From Dr. Researcher')
    expect(dialog().textContent).toContain('On gateway gw.example.test')

    const quotes = Array.from(dialog().querySelectorAll<HTMLElement>('[data-secure-quote]'))

    expect(quotes.map(quote => quote.textContent)).toEqual([
      'Hotel **booking** <b>details</b>\nFill [this](https://evil.test) in.',
      'Open invoices: 2026-041'
    ])
    expect(dialog().textContent).toContain('The bot acts for: Ada')
    expect(dialog().querySelector('a, b, strong, em, iframe')).toBeNull()
    expect(dialog().textContent).toContain('Hermie does not keep them.')
    expect(dialog().textContent).toMatch(/Expires in \d+:\d\d/u)
  })

  it('draws every kind of field with the browser’s own input, labelled, with a mark on the required ones', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))

    expect(control(/Name on the booking/u).type).toBe('text')
    expect(control(/^Guests/u).type).toBe('number')
    expect(control(/^Guests/u).min).toBe('1')
    expect(control(/^Guests/u).max).toBe('12')
    expect(control(/^Guests/u).step).toBe('1')
    expect(control(/^Guests/u).value).toBe('2')
    expect(control(/Budget per night/u).type).toBe('text')
    expect(control(/Budget per night/u).inputMode).toBe('decimal')
    expect(control(/^Arrival/u).type).toBe('date')
    expect(control(/^Arrival/u).min).toBe('2026-10-05')
    expect(control(/Check-in time/u).type).toBe('time')
    expect(control(/When may we call/u).type).toBe('datetime-local')
    expect(within(dialog()).getByLabelText('From').getAttribute('type')).toBe('date')
    expect(within(dialog()).getByLabelText('To').getAttribute('type')).toBe('date')
    expect(within(dialog()).getByLabelText('Single').getAttribute('type')).toBe('radio')
    expect(within(dialog()).getByLabelText('Breakfast').getAttribute('type')).toBe('checkbox')
    expect(within(dialog()).getByRole('switch', { name: /Send me offers/u })).toBeTruthy()
    expect(within(dialog()).getByLabelText(/Anything we should know/u).tagName).toBe('TEXTAREA')

    // Required: a star for the eye and the word for a screen reader, in the label.
    expect(within(dialog()).getByText('* means required')).toBeTruthy()
    expect(control(/Name on the booking/u).getAttribute('aria-required')).toBe('true')
    expect(control(/Budget per night/u).getAttribute('aria-required')).toBeNull()
    expect(within(dialog()).getAllByText('(required)', { exact: false }).length).toBeGreaterThan(2)
  })

  it('says the currency with its decimals, the zone with its offset, and what a datetime goes out as', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))

    expect(dialog().textContent).toContain('Amount in EUR, up to 2 decimals')
    expect(dialog().textContent).toMatch(/Time zone: Europe\/Amsterdam \(UTC\+0[12]:00\)/u)
    expect(dialog().textContent).toContain(`Your time zone: ${deviceZone()}`)

    type(/When may we call/u, '2026-10-07T14:30')

    expect(dialog().textContent).toContain('Sent as 2026-10-07T14:30+02:00[Europe/Amsterdam]')
    expect(control(/When may we call/u).getAttribute('aria-describedby')).toContain('-sent')
  })

  it('shows the request’s hint with the field, linked to it', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))

    const notes = control(/Anything we should know/u)
    const hint = document.getElementById(notes.getAttribute('aria-describedby') ?? '')

    expect(hint?.textContent).toBe('Allergies, arrival time.')
  })

  it('answers with the contract’s values: numbers as numbers, an amount as a decimal string, a datetime with its offset and zone', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))
    fillIn()
    await press('Send answers')

    const result = lastAnswer(harness)

    expect(result).toMatchObject({
      status: 'answered',
      values: {
        name: 'Ada Lovelace',
        guests: 4,
        stay: { start: '2026-11-14', end: '2026-11-16' },
        budget: '1250.50',
        arrival: '2026-11-14',
        check_in: '14:30',
        call_at: '2026-10-07T14:30+02:00[Europe/Amsterdam]',
        room: 'double',
        extras: ['breakfast', 'parking'],
        newsletter: true,
        notes: 'Arriving late.\nNo nuts, please.'
      }
    })
    // A datetime the field gives no zone for is in this device's, with that zone's offset.
    expect((result?.values as Record<string, string>).remind_at).toMatch(
      new RegExp(`^2026-10-07T08:30[+-]\\d\\d:\\d\\d\\[${deviceZone().replace('/', '\\/')}\\]$`, 'u')
    )
    expect(typeof (result?.values as Record<string, unknown>).guests).toBe('number')
    expect(typeof (result?.values as Record<string, unknown>).budget).toBe('string')
    expect(harness.gw.calls).toHaveLength(1)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves a field without a value out of the answer, and sends a toggle that was never touched as it is', async () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame([
        { id: 'name', kind: 'text', label: 'Name', required: true },
        { id: 'note', kind: 'text', label: 'Note' },
        { id: 'news', kind: 'toggle', label: 'News' }
      ])
    )
    type(/^Name/u, 'Ada')
    await press('Send answers')

    expect(lastAnswer(harness)).toEqual({ status: 'answered', values: { name: 'Ada', news: false } })
  })

  it('takes a comma for the point in an amount', async () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame([{ id: 'budget', kind: 'amount', label: 'Budget', currency: 'EUR' }])
    )
    type(/Budget/u, '12,50')
    await press('Send answers')

    expect(lastAnswer(harness)).toEqual({ status: 'answered', values: { budget: '12.50' } })
  })
})

describe('the page’s own check', () => {
  it('holds a form back, names the problem next to its field in the gateway’s terms, and takes focus there', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))
    type(/Name on the booking/u, 'Ada')
    type(/Budget per night/u, '1250.505')
    await press('Send answers')

    expect(harness.gw.calls).toEqual([])
    expect(screen.getByRole('dialog')).toBe(dialog())

    const budget = control(/Budget per night/u)

    expect(budget.getAttribute('aria-invalid')).toBe('true')
    expect(
      document.getElementById(budget.getAttribute('aria-describedby')?.split(' ').at(-1) ?? '')?.textContent
    ).toMatch(/Enter an amount in EUR with a point and at most 2 decimals/u)
    // The first field with a problem is the stay (required, empty), which comes before the amount.
    expect(within(dialog()).getByLabelText('From')).toBe(document.activeElement)
    expect(within(dialog()).getByText(/answers need attention/u).textContent).toBe('2 answers need attention.')
    expect(control(/Name on the booking/u).getAttribute('aria-invalid')).toBeNull()
  })

  it.each([
    ['name', 'x'.repeat(21), 'At most 20 characters.'],
    ['guests', '0', 'The lowest allowed is 1.'],
    ['guests', '13', 'The highest allowed is 12.'],
    ['guests', '2.5', 'Enter a whole number.'],
    ['guests', '', 'This is required.']
  ])('names %s = %j: %s', async (id, value, message) => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame([FIELDS[0], { ...FIELDS[1], default: undefined }, { id: 'ok', kind: 'toggle', label: 'Ok' }])
    )
    type(id === 'name' ? /Name on the booking/u : /^Guests/u, value)

    if (id !== 'name') {
      type(/Name on the booking/u, 'Ada')
    } else {
      type(/^Guests/u, '2')
    }

    await press('Send answers')

    expect(within(dialog()).getByText(message)).toBeTruthy()
    expect(harness.gw.calls).toEqual([])
  })

  it('says a date outside the range, a range that ends before it starts, and a time the clocks skip', async () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame([
        { id: 'arrival', kind: 'date', label: 'Arrival', min: '2026-10-05' },
        { id: 'stay', kind: 'daterange', label: 'Stay' },
        { id: 'call_at', kind: 'datetime', label: 'Call at', tz: 'Europe/Amsterdam' }
      ])
    )
    type(/^Arrival/u, '2026-10-04')
    fireEvent.change(within(dialog()).getByLabelText('From'), { target: { value: '2026-11-16' } })
    fireEvent.change(within(dialog()).getByLabelText('To'), { target: { value: '2026-11-14' } })
    type(/Call at/u, '2026-03-29T02:30')
    await press('Send answers')

    expect(within(dialog()).getByText('The earliest allowed is 2026-10-05.')).toBeTruthy()
    expect(within(dialog()).getByText('The end is before the start.')).toBeTruthy()
    expect(within(dialog()).getByText(/does not exist in this time zone/u)).toBeTruthy()
    expect(harness.gw.calls).toEqual([])
  })

  it('checks a field when it is left, before Send, and takes the problem back when it is fixed', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name', required: true }]))

    fireEvent.blur(control(/^Name/u))
    expect(within(dialog()).getByText('This is required.')).toBeTruthy()

    type(/^Name/u, 'Ada')
    expect(within(dialog()).queryByText('This is required.')).toBeNull()
    expect(control(/^Name/u).getAttribute('aria-invalid')).toBeNull()
  })

  it('does not name a problem in a group of inputs while focus is still inside it', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))

    const from = within(dialog()).getByLabelText('From')
    const to = within(dialog()).getByLabelText('To')

    fireEvent.change(from, { target: { value: '2026-11-14' } })
    fireEvent.blur(from, { relatedTarget: to })

    expect(within(dialog()).queryByText('Enter a start and an end date, or leave both empty.')).toBeNull()
  })

  it('offers a way back from a single choice that is not required', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))
    fireEvent.click(within(dialog()).getByLabelText('Double'))

    expect((within(dialog()).getByLabelText('Double') as HTMLInputElement).checked).toBe(true)
    fireEvent.click(button('Clear'))
    expect((within(dialog()).getByLabelText('Double') as HTMLInputElement).checked).toBe(false)
  })

  it('uses a select for a single choice of many, and sends the option’s value, never its label', async () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame([
        {
          id: 'city',
          kind: 'choice',
          label: 'City',
          options: ['a', 'b', 'c', 'd', 'e', 'f'].map(value => ({ value: `v_${value}`, label: `City ${value}` }))
        }
      ])
    )

    const select = control(/City/u) as unknown as HTMLSelectElement

    expect(select.tagName).toBe('SELECT')
    expect(Array.from(select.options).map(option => option.textContent)).toContain('City c')
    expect(dialog().innerHTML).not.toContain('v_c')
    fireEvent.change(select, { target: { value: '2' } })
    await press('Send answers')

    expect(lastAnswer(harness)).toEqual({ status: 'answered', values: { city: 'v_c' } })
  })
})

describe('the gateway’s refusal', () => {
  const refuse = (reason: string) => () => {
    throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason } })
  }

  it('is shown next to its field, in the same words; the sheet is not rebuilt; fixing the field takes it back', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))
    fillIn()

    const guests = control(/^Guests/u)
    const before = dialog()

    harness.gw.onCall.handler = refuse('field:name:too_long')
    await press('Send answers')

    // The request stays open, on the same dialog and the same inputs, with everything still typed in.
    expect(dialog()).toBe(before)
    expect(control(/^Guests/u)).toBe(guests)
    expect(guests.value).toBe('4')
    expect(control(/Name on the booking/u).value).toBe('Ada Lovelace')
    expect(interactiveStore.getState().requests[0]?.refusal).toBe('field:name:too_long')

    const name = control(/Name on the booking/u)

    expect(within(dialog()).getByText('At most 20 characters.')).toBeTruthy()
    expect(name.getAttribute('aria-invalid')).toBe('true')
    expect(name).toBe(document.activeElement)

    // Fixed, and sent again: accepted.
    harness.gw.onCall.handler = () => ({ status: 'ok' })
    type(/Name on the booking/u, 'Ada')
    expect(within(dialog()).queryByText('At most 20 characters.')).toBeNull()
    await press('Send answers')

    expect(harness.gw.calls).toHaveLength(2)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says a refusal that names no field in words of its own, with the gateway’s reason', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    type(/^Name/u, 'Ada')
    harness.gw.onCall.handler = refuse('bad_shape')
    await press('Send answers')

    expect(within(dialog()).getByRole('alert').textContent).toBe('The gateway did not accept this answer (bad_shape).')
    expect(control(/^Name/u).value).toBe('Ada')
  })

  it('is read as a problem of its field for every problem the contract names', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))
    fillIn()
    harness.gw.onCall.handler = refuse('field:budget:above_max')
    await press('Send answers')

    expect(within(dialog()).getByText('The highest allowed is 5000 EUR.')).toBeTruthy()
    expect(control(/Budget per night/u)).toBe(document.activeElement)
  })
})

describe('Skip, the guard and the connection', () => {
  it('skips an optional form: {status: skipped}', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name', required: true }]))
    await press('Skip')

    expect(harness.gw.calls).toEqual([
      { method: 'request.answer', params: { id: 'srq-1', result: { status: 'skipped' } } }
    ])
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers no Skip for a form that is not optional', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }], { optional: false }))

    expect(queryButton('Skip')).toBeNull()
    expect(button('Send answers')).toBeTruthy()
  })

  it('takes nothing for a moment after it appears: the fields and the buttons are off (the tap guard)', async () => {
    mount(harness, { tapGuardMs: 40 })
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))

    expect((button('Send answers') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Skip') as HTMLButtonElement).disabled).toBe(true)
    expect(control(/^Name/u).matches(':disabled')).toBe(true)

    await act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 100))
    })

    expect((button('Send answers') as HTMLButtonElement).disabled).toBe(false)
    expect(control(/^Name/u).matches(':disabled')).toBe(false)
  })

  it('does not close on Escape: only an answer closes a question', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    fireEvent.keyDown(dialog(), { key: 'Escape' })

    expect(screen.getByRole('dialog')).toBe(dialog())
    expect(harness.gw.calls).toEqual([])
  })

  it('says so, sends nothing and keeps what was typed when Send is pressed while the connection is down', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    type(/^Name/u, 'Ada')
    act(() => harness.gw.status('connecting'))
    await press('Send answers')

    expect(within(dialog()).getByText(/Not connected to the gateway/u)).toBeTruthy()
    expect(harness.gw.calls).toEqual([])
    expect(control(/^Name/u).value).toBe('Ada')
    expect((button('Send answers') as HTMLButtonElement).disabled).toBe(false)
  })

  it('disables its buttons and fields while an answer is on its way, and answers once however often Send is pressed', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    type(/^Name/u, 'Ada')

    let release: (value: unknown) => void = () => undefined

    harness.gw.onCall.handler = () => new Promise(resolve => (release = resolve))

    await act(async () => {
      fireEvent.click(button('Send answers'))
      fireEvent.click(button('Send answers'))
    })

    expect((button('Send answers') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Skip') as HTMLButtonElement).disabled).toBe(true)
    expect(control(/^Name/u).matches(':disabled')).toBe(true)
    expect(harness.gw.calls).toHaveLength(1)

    await act(async () => release({ status: 'ok' }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(harness.gw.calls).toHaveLength(1)
  })

  it('says a call that failed without the gateway’s word, and leaves the request open for another try', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    type(/^Name/u, 'Ada')
    harness.gw.onCall.handler = () => {
      throw new Error('socket closed')
    }
    await press('Send answers')

    expect(within(dialog()).getByText(/could not be sent/u)).toBeTruthy()
    expect(control(/^Name/u).value).toBe('Ada')

    harness.gw.onCall.handler = () => ({ status: 'ok' })
    await press('Send answers')

    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('says when the gateway asks again because an answer never reached it', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    await press('Send answers')
    expect(screen.queryByRole('dialog')).toBeNull()

    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]), true)

    expect(within(dialog()).getByText('Your earlier answer did not reach the gateway. Enter it again.')).toBeTruthy()
  })

  it('goes when the gateway withdraws the request, and the reader is told in words', () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    act(() => harness.gw.cancel('srq-1', 'interrupted'))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toContain('The request from Dr. Researcher was withdrawn.')
  })

  it('goes when its time runs out, and the reader is told so', () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame([{ id: 'name', kind: 'text', label: 'Name' }], { expires_at: NOW_SECONDS + 30 })
    )
    act(() => harness.timers.advance(30_000))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.body.textContent).toContain('The request from Dr. Researcher timed out.')
  })
})

describe('what is typed', () => {
  it('is in no store of the page, only in the answer', async () => {
    const secret = 'zz-private-marker-9431'

    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame([{ id: 'name', kind: 'text', label: 'Name' }]))
    type(/^Name/u, secret)

    const everything = (): string =>
      JSON.stringify([interactiveStore.getState(), requestsStore.getState(), chatsStore.getState()])

    expect(everything()).not.toContain(secret)

    await press('Send answers')

    expect(JSON.stringify(lastAnswer(harness))).toContain(secret)
    expect(everything()).not.toContain(secret)
    expect(harness.gw.replies).toEqual([])
  })
})

// A smoke test of the render itself, so a mount that throws is not mistaken for a quiet pass elsewhere.
describe('mounting', () => {
  it('renders nothing for a request that is not there', () => {
    const view = render(<main />)

    expect(view.container.querySelector('[role="dialog"]')).toBeNull()
  })
})
