/**
 * The three interactive sheets through axe, in both colour schemes and every language, in each state a person meets
 * them in: a form with every kind of field, with problems and with a refusal; a file request empty, with files, with
 * a problem, uploading and failed; a draft editable, read-only and with what the eye cannot see.
 *
 * jsdom has no layout and loads no stylesheet, so colour contrast is not run here (`ui/theme.contrast.test.ts` measures
 * the theme's pairs, and `e2e/requests-interactive.spec.ts` runs axe with contrast in a real browser). What this checks
 * is the structure: names, labels, descriptions, groups, roles, the dialog's relations.
 */
import { JsonRpcGatewayError } from '@hermes/shared/json-rpc-channel'
import { act, fireEvent, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { FileUploadError } from '../../core/chats/file-upload'
import { REFUSED_CODE } from '../../core/requests/interactive'
import { setLanguageChoice } from '../../i18n/locale'
import { applyTheme } from '../../platform/theme-target'
import {
  button,
  dialog,
  draftFrame,
  fileFrame,
  formFrame,
  type Harness,
  mount,
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

afterEach(() => {
  teardown(harness)
  document.documentElement.removeAttribute('data-tint')
})

async function violations(): Promise<string[]> {
  const result = await axe.run(document.documentElement, { rules: { 'color-contrast': { enabled: false } } })

  return result.violations.map(
    violation => `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
  )
}

const FIELDS = [
  { id: 'name', kind: 'text', label: 'Name on the booking', required: true, max_length: 20, hint: 'As on the card.' },
  { id: 'guests', kind: 'number', label: 'Guests', required: true, min: 1, max: 12, integer: true, default: 2 },
  { id: 'stay', kind: 'daterange', label: 'Stay', required: true, min: '2026-10-05', max: '2026-12-31' },
  { id: 'budget', kind: 'amount', label: 'Budget per night', currency: 'EUR', min: '0', max: '5000' },
  { id: 'arrival', kind: 'date', label: 'Arrival', tz: 'Europe/Amsterdam' },
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
    id: 'city',
    kind: 'choice',
    label: 'City',
    options: ['a', 'b', 'c', 'd', 'e'].map(value => ({ value, label: `City ${value}` }))
  },
  {
    id: 'extras',
    kind: 'choice',
    label: 'Extras',
    multiple: true,
    min_selected: 1,
    max_selected: 2,
    options: [
      { value: 'breakfast', label: 'Breakfast' },
      { value: 'parking', label: 'Parking' },
      { value: 'late_checkout', label: 'Late check-out' }
    ]
  },
  { id: 'newsletter', kind: 'toggle', label: 'Send me offers', default: false },
  { id: 'notes', kind: 'text', label: 'Anything we should know?', multiline: true, max_length: 500 }
]

const up = {
  dir: '/home/ada/work/uploads/hermie/2026-10-04',
  max_bytes: 1_048_576,
  max_total_bytes: 2_097_152,
  max_files: 3,
  strip_metadata: true
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 40))
  })
}

describe.each(['light', 'dark'] as const)('in the %s scheme', scheme => {
  beforeEach(() => applyTheme({ scheme, tint: 'blue' }))

  it('has no violation with a form of every kind of field', async () => {
    mount(harness)
    raise(
      harness,
      'srq-1',
      'input.form',
      formFrame(FIELDS, { detail: 'Open invoices: 2026-041', acting_user: { id: 'u', name: 'Ada' } })
    )

    expect(screen.getByRole('dialog', { name: 'A form to fill in' })).toBeTruthy()
    expect(await violations()).toEqual([])
  })

  it('has no violation with a form that has problems and a refusal', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))
    fireEvent.change(within(dialog()).getByLabelText(/Budget per night/u), { target: { value: '12.505' } })
    await act(async () => {
      fireEvent.click(button('Send answers'))
    })

    expect(within(dialog()).getByText(/answers need attention/u)).toBeTruthy()
    expect(await violations()).toEqual([])

    fireEvent.change(within(dialog()).getByLabelText(/Name on the booking/u), { target: { value: 'Ada' } })
    fireEvent.change(within(dialog()).getByLabelText(/Budget per night/u), { target: { value: '12.50' } })
    fireEvent.change(within(dialog()).getByLabelText('From'), { target: { value: '2026-11-14' } })
    fireEvent.change(within(dialog()).getByLabelText('To'), { target: { value: '2026-11-16' } })
    harness.gw.onCall.handler = () => {
      throw new JsonRpcGatewayError('refused', { code: REFUSED_CODE, data: { reason: 'field:name:too_long' } })
    }
    await act(async () => {
      fireEvent.click(button('Send answers'))
    })

    expect(within(dialog()).getByText('At most 20 characters.')).toBeTruthy()
    expect(await violations()).toEqual([])
  })

  it('has no violation with a file request empty, with files, with a problem, uploading and failed', async () => {
    let fail = true

    mount(harness, {
      uploadFileTo: async () => {
        if (fail) {
          throw new FileUploadError('failed', 'down')
        }

        return new Promise(() => undefined)
      }
    })
    raise(harness, 'srq-1', 'input.file', fileFrame({ accept: 'any', multiple: true, upload: up }))
    expect(await violations()).toEqual([])

    const input = dialog().querySelector<HTMLInputElement>('[data-file-picker]') as HTMLInputElement

    fireEvent.change(input, {
      target: {
        files: [
          new File(['aaa'], 'receipt.txt', { type: 'text/plain' }),
          new File(['x'.repeat(2_000_000)], 'huge.bin', { type: 'application/octet-stream' })
        ]
      }
    })

    expect(within(dialog()).getByRole('list', { name: 'Files to upload' })).toBeTruthy()
    expect(within(dialog()).getByText(/huge.bin is larger/u)).toBeTruthy()
    expect(await violations()).toEqual([])

    await act(async () => {
      fireEvent.click(button('Upload and send'))
    })
    await settle()

    expect(within(dialog()).getByText('receipt.txt could not be uploaded.')).toBeTruthy()
    expect(await violations()).toEqual([])

    fail = false
    await act(async () => {
      fireEvent.click(button('Try again'))
    })
    await settle()

    expect(within(dialog()).getByRole('progressbar', { name: 'Upload progress' })).toBeTruthy()
    expect(await violations()).toEqual([])
  })

  it('has no violation with a draft, editable, read-only and with hidden characters in it', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'review.draft', draftFrame({ recipients: ['bram@example.test', 'cleo@example.test'] }))
    expect(await violations()).toEqual([])

    fireEvent.change(within(dialog()).getByLabelText('Draft'), {
      target: { value: `Pay ${String.fromCodePoint(0x202e)}txt.exe now` }
    })

    expect(within(dialog()).getByText('The text with those characters shown')).toBeTruthy()
    expect(await violations()).toEqual([])

    fireEvent.change(within(dialog()).getByLabelText('Draft'), { target: { value: 'something else' } })

    expect(within(dialog()).getByText('The original from the bot')).toBeTruthy()
    expect(await violations()).toEqual([])

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'review.draft', draftFrame({ editable: false }))

    expect(within(dialog()).queryByRole('textbox', { name: 'Draft' })).toBeNull()
    expect(await violations()).toEqual([])
  })
})

describe.each(['nl', 'de'] as const)('in %s', locale => {
  beforeEach(async () => {
    await setLanguageChoice(locale)
  })

  it('has no violation with a form, a file request and a draft', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.form', formFrame(FIELDS))

    expect(document.documentElement.lang).toBe(locale)
    expect(await violations()).toEqual([])

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'input.file', fileFrame({ upload: up }))
    expect(await violations()).toEqual([])

    act(() => harness.gw.cancel('srq-2', 'interrupted'))
    raise(harness, 'srq-3', 'review.draft', draftFrame())
    expect(await violations()).toEqual([])
  })
})
