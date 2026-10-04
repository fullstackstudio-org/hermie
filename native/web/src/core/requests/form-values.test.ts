/**
 * What a form's inputs hold and what that comes to as an answer, held to the contract's own examples
 * (`contract/requests/examples.json`, normative): every valid value of every field kind comes out as that value, and
 * every invalid one is named with the problem the gateway refuses it for, in the gateway's order. Plus the datetime
 * arithmetic (offset and zone, a clock that skips a time, one that repeats it) and the answer built from many fields.
 */
import { describe, expect, it } from 'vitest'

import examplesSource from '../../../../../contract/requests/examples.json?raw'
import {
  amountText,
  boundText,
  deviceZone,
  evaluate,
  evaluateForm,
  initialRaw,
  instantToInput,
  parseFieldRefusal,
  type RawValue,
  zoneOffsetLabel
} from './form-values'
import { type FormField, readInteractiveParams } from './interactive-types'

interface FieldExample {
  name: string
  field: Record<string, unknown>
  valid: unknown[]
  invalid: { value: unknown; reason: string }[]
}

const examples = (JSON.parse(examplesSource) as { form_fields: FieldExample[] }).form_fields

/** The field as the page reads it. */
function read(raw: Record<string, unknown>): FormField {
  const result = readInteractiveParams('input.form', {
    session_id: 's',
    v: 1,
    title: 'T',
    summary: 'S',
    expires_at: 1_791_119_400,
    optional: true,
    fields: [raw]
  })

  if (!result.ok || result.ask.method !== 'input.form' || !result.ask.fields[0]) {
    throw new Error(`the contract's own field was refused: ${JSON.stringify(raw)}`)
  }

  return result.ask.fields[0]
}

const DEVICE = 'America/New_York'

/** What an input would hold for a value of the contract: text for text, a wall-clock reading for an instant. */
function rawOf(field: FormField, value: unknown): RawValue {
  if (field.kind === 'datetime' && typeof value === 'string') {
    return instantToInput(value.replace(/\[.*\]$/u, ''), field.tz ?? DEVICE) || value
  }

  if (typeof value === 'number') {
    return String(value)
  }

  return value as RawValue
}

/** `...T14:30:00+02:00[...]` and `...T14:30+02:00[...]` are one value: the answer leaves zero seconds out. */
const canonical = (value: unknown): unknown =>
  typeof value === 'string' ? value.replace(/T(\d\d:\d\d):00([+-])/u, 'T$1$2') : value

describe('every field kind, against the examples of the contract', () => {
  for (const example of examples) {
    describe(example.name, () => {
      const field = read(example.field)

      for (const valid of example.valid) {
        it(`takes ${JSON.stringify(valid)}`, () => {
          const result = evaluate(field, rawOf(field, valid), DEVICE)

          if (valid === '' || (Array.isArray(valid) && valid.length === 0)) {
            expect(result).toEqual({ none: true })
          } else {
            expect('value' in result ? canonical(result.value) : result).toEqual(canonical(valid))
          }
        })
      }

      for (const invalid of example.invalid) {
        const problem = invalid.reason.split(':').at(-1)
        // A wrong JSON type, a zone the field does not name, an offset the zone does not have, an answer without its
        // zone: an input hands none of those over (the page writes the offset and the zone itself), so it has nothing
        // to name. Only a datetime's range is the person's to get wrong.
        const untypable =
          problem === 'type' ||
          problem === 'zone' ||
          problem === 'offset' ||
          (field.kind === 'datetime' && problem !== 'below_min' && problem !== 'above_max')

        if (untypable) {
          continue
        }

        it(`refuses ${JSON.stringify(invalid.value)} as ${problem}`, () => {
          expect(evaluate(field, rawOf(field, invalid.value), DEVICE)).toEqual({ problem })
        })
      }
    })
  }
})

describe('an empty field', () => {
  it('is no value when it is not required, and missing when it is', () => {
    expect(evaluate(read({ id: 'a', kind: 'text', label: 'A' }), '', DEVICE)).toEqual({ none: true })
    expect(evaluate(read({ id: 'a', kind: 'text', label: 'A', required: true }), '', DEVICE)).toEqual({
      problem: 'missing'
    })
    expect(evaluate(read({ id: 'a', kind: 'date', label: 'A', required: true }), '', DEVICE)).toEqual({
      problem: 'missing'
    })
    expect(
      evaluate(read({ id: 'a', kind: 'daterange', label: 'A', required: true }), { start: '', end: '' }, DEVICE)
    ).toEqual({ problem: 'missing' })
    expect(
      evaluate(
        read({
          id: 'a',
          kind: 'choice',
          label: 'A',
          multiple: true,
          required: true,
          options: [{ value: 'x', label: 'X' }]
        }),
        [],
        DEVICE
      )
    ).toEqual({ problem: 'missing' })
  })

  it('is a toggle that is off, never missing', () => {
    expect(evaluate(read({ id: 't', kind: 'toggle', label: 'T', required: true }), false, DEVICE)).toEqual({
      value: false
    })
  })

  it('leaves half a range as a problem of format', () => {
    const field = read({ id: 'r', kind: 'daterange', label: 'R' })

    expect(evaluate(field, { start: '2026-11-14', end: '' }, DEVICE)).toEqual({ problem: 'format' })
  })
})

describe('text', () => {
  it('counts code points, not UTF-16 units', () => {
    const field = read({ id: 'a', kind: 'text', label: 'A', max_length: 3 })

    expect(evaluate(field, '😀😀😀', DEVICE)).toEqual({ value: '😀😀😀' })
    expect(evaluate(field, '😀😀😀😀', DEVICE)).toEqual({ problem: 'too_long' })
  })

  it('keeps a line break only in a multi-line field, and sends the text as typed', () => {
    expect(evaluate(read({ id: 'a', kind: 'text', label: 'A', multiline: true }), ' a\nb ', DEVICE)).toEqual({
      value: ' a\nb '
    })
    expect(evaluate(read({ id: 'a', kind: 'text', label: 'A' }), 'a\u2028b', DEVICE)).toEqual({ problem: 'format' })
  })
})

describe('number', () => {
  it('reads what an input hands over, and nothing it cannot', () => {
    const field = read({ id: 'n', kind: 'number', label: 'N' })

    expect(evaluate(field, '12.5', DEVICE)).toEqual({ value: 12.5 })
    expect(evaluate(field, '-3', DEVICE)).toEqual({ value: -3 })
    expect(evaluate(field, '1e3', DEVICE)).toEqual({ value: 1000 })
    expect(evaluate(field, ' 7 ', DEVICE)).toEqual({ value: 7 })
    expect(evaluate(field, '0x10', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(field, 'Infinity', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(field, '1e999', DEVICE)).toEqual({ problem: 'format' })
  })

  it('names the range before the whole number and the step, as the gateway does', () => {
    const field = read({ id: 'n', kind: 'number', label: 'N', min: 1, max: 5, integer: true, step: 2 })

    expect(evaluate(field, '0.5', DEVICE)).toEqual({ problem: 'below_min' })
    expect(evaluate(field, '2.5', DEVICE)).toEqual({ problem: 'not_integer' })
    expect(evaluate(field, '2', DEVICE)).toEqual({ problem: 'step' })
    expect(evaluate(field, '3', DEVICE)).toEqual({ value: 3 })
  })
})

describe('amount', () => {
  it('is a decimal string with the currency’s decimals at most, never a number', () => {
    const euro = read({ id: 'a', kind: 'amount', label: 'A', currency: 'EUR' })
    const yen = read({ id: 'a', kind: 'amount', label: 'A', currency: 'JPY' })
    const dinar = read({ id: 'a', kind: 'amount', label: 'A', currency: 'KWD' })

    expect(evaluate(euro, '12.50', DEVICE)).toEqual({ value: '12.50' })
    expect(evaluate(euro, '12.5', DEVICE)).toEqual({ value: '12.5' })
    expect(evaluate(euro, '12.505', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(yen, '1500', DEVICE)).toEqual({ value: '1500' })
    expect(evaluate(yen, '1500.5', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(dinar, '1.234', DEVICE)).toEqual({ value: '1.234' })
    expect(evaluate(euro, '007', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(euro, '1e3', DEVICE)).toEqual({ problem: 'format' })
  })

  it('takes a comma for the point, once, and nothing else', () => {
    const euro = read({ id: 'a', kind: 'amount', label: 'A', currency: 'EUR' })

    expect(amountText('12,50')).toBe('12.50')
    expect(amountText(' 12,50 ')).toBe('12.50')
    expect(amountText('1,250.50')).toBe('1,250.50')
    expect(amountText('1,2,3')).toBe('1,2,3')
    expect(evaluate(euro, '12,50', DEVICE)).toEqual({ value: '12.50' })
    expect(evaluate(euro, '1,250.50', DEVICE)).toEqual({ problem: 'format' })
  })

  it('compares exactly, in thousandths', () => {
    const field = read({ id: 'a', kind: 'amount', label: 'A', currency: 'KWD', min: '0.001', max: '0.003' })

    expect(evaluate(field, '0.001', DEVICE)).toEqual({ value: '0.001' })
    expect(evaluate(field, '0.000', DEVICE)).toEqual({ problem: 'below_min' })
    expect(evaluate(field, '0.004', DEVICE)).toEqual({ problem: 'above_max' })
  })
})

describe('datetime', () => {
  const amsterdam = read({ id: 'd', kind: 'datetime', label: 'D', tz: 'Europe/Amsterdam' })
  const device = read({ id: 'd', kind: 'datetime', label: 'D' })

  it('carries the offset of the zone at that instant, and the zone in brackets', () => {
    expect(evaluate(amsterdam, '2026-10-07T14:30', DEVICE)).toEqual({
      value: '2026-10-07T14:30+02:00[Europe/Amsterdam]'
    })
    expect(evaluate(amsterdam, '2026-11-07T09:00', DEVICE)).toEqual({
      value: '2026-11-07T09:00+01:00[Europe/Amsterdam]'
    })
    expect(evaluate(amsterdam, '2026-11-07T09:00:30', DEVICE)).toEqual({
      value: '2026-11-07T09:00:30+01:00[Europe/Amsterdam]'
    })
  })

  it('is in the device’s zone when the field names none', () => {
    expect(evaluate(device, '2026-10-07T08:30', 'America/New_York')).toEqual({
      value: '2026-10-07T08:30-04:00[America/New_York]'
    })
    expect(evaluate(device, '2026-10-07T08:30', 'UTC')).toEqual({ value: '2026-10-07T08:30+00:00[UTC]' })
    expect(evaluate(device, '2026-10-07T08:30', 'Asia/Kolkata')).toEqual({
      value: '2026-10-07T08:30+05:30[Asia/Kolkata]'
    })
  })

  it('refuses a time the clocks skip, and takes the first of one they repeat', () => {
    // Europe/Amsterdam: 2026-03-29 02:00 jumps to 03:00; 2026-10-25 03:00 goes back to 02:00.
    expect(evaluate(amsterdam, '2026-03-29T02:30', DEVICE)).toEqual({ problem: 'offset' })
    expect(evaluate(amsterdam, '2026-03-29T03:30', DEVICE)).toEqual({
      value: '2026-03-29T03:30+02:00[Europe/Amsterdam]'
    })
    expect(evaluate(amsterdam, '2026-10-25T02:30', DEVICE)).toEqual({
      value: '2026-10-25T02:30+02:00[Europe/Amsterdam]'
    })
  })

  it('compares instants, whatever offset the bounds are written in', () => {
    const bounded = read({
      id: 'd',
      kind: 'datetime',
      label: 'D',
      tz: 'Europe/Amsterdam',
      min: '2026-10-05T00:00:00+02:00',
      max: '2026-10-05T12:00:00+00:00'
    })

    expect(evaluate(bounded, '2026-10-04T23:59', DEVICE)).toEqual({ problem: 'below_min' })
    expect(evaluate(bounded, '2026-10-05T00:00', DEVICE)).toEqual({ value: '2026-10-05T00:00+02:00[Europe/Amsterdam]' })
    expect(evaluate(bounded, '2026-10-05T14:00', DEVICE)).toEqual({ value: '2026-10-05T14:00+02:00[Europe/Amsterdam]' })
    expect(evaluate(bounded, '2026-10-05T14:01', DEVICE)).toEqual({ problem: 'above_max' })
  })

  it('refuses text that is not a real date and time, and a zone this browser does not know', () => {
    expect(evaluate(amsterdam, '2026-02-30T10:00', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(amsterdam, '2026-10-07 14:30', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(read({ id: 'd', kind: 'datetime', label: 'D' }), '2026-10-07T14:30', 'Mars/Olympus_Mons')).toEqual({
      problem: 'zone'
    })
  })

  it('shows a default in the zone the answer is in', () => {
    const field = read({
      id: 'd',
      kind: 'datetime',
      label: 'D',
      tz: 'Europe/Amsterdam',
      default: '2026-10-07T12:30:00+00:00'
    })
    const bare = read({ id: 'd', kind: 'datetime', label: 'D', default: '2026-10-07T12:30:00+00:00' })

    expect(initialRaw(field, 'America/New_York')).toBe('2026-10-07T14:30')
    expect(initialRaw(bare, 'America/New_York')).toBe('2026-10-07T08:30')
  })

  it('says the zone’s offset, never a made-up one', () => {
    expect(zoneOffsetLabel('Europe/Amsterdam', Date.UTC(2026, 6, 1))).toBe('UTC+02:00')
    expect(zoneOffsetLabel('Europe/Amsterdam', Date.UTC(2026, 0, 1))).toBe('UTC+01:00')
    expect(zoneOffsetLabel('UTC')).toBe('UTC')
    expect(zoneOffsetLabel('No/Such_Zone')).toBe('UTC')
    expect(typeof deviceZone()).toBe('string')
  })

  it('words a bound as a reading in the field’s zone', () => {
    const field = read({
      id: 'd',
      kind: 'datetime',
      label: 'D',
      tz: 'Europe/Amsterdam',
      min: '2026-10-05T00:00:00+02:00'
    })

    expect(boundText(field, 'min', DEVICE)).toBe('2026-10-05 00:00')
    expect(boundText(field, 'max', DEVICE)).toBe('')
  })
})

describe('the answer of a whole form', () => {
  it('holds the values of the fields that have one, and the problem of each that has one', () => {
    const fields = [
      read({ id: 'name', kind: 'text', label: 'Name', required: true }),
      read({ id: 'guests', kind: 'number', label: 'Guests', integer: true, min: 1 }),
      read({ id: 'budget', kind: 'amount', label: 'Budget', currency: 'EUR' }),
      read({ id: 'notes', kind: 'text', label: 'Notes' }),
      read({ id: 'news', kind: 'toggle', label: 'News' })
    ]

    expect(evaluateForm(fields, { name: 'Ada', guests: '0', budget: '80', notes: '', news: true }, DEVICE)).toEqual({
      values: { name: 'Ada', budget: '80', news: true },
      problems: { guests: 'below_min' }
    })
  })

  it('lists a multiple choice in the options’ order', () => {
    const field = read({
      id: 'x',
      kind: 'choice',
      label: 'X',
      multiple: true,
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
        { value: 'c', label: 'C' }
      ]
    })

    expect(evaluate(field, ['c', 'a'], DEVICE)).toEqual({ value: ['a', 'c'] })
  })

  it('starts from the request’s defaults', () => {
    expect(initialRaw(read({ id: 'g', kind: 'number', label: 'G', default: 2 }), DEVICE)).toBe('2')
    expect(initialRaw(read({ id: 't', kind: 'toggle', label: 'T' }), DEVICE)).toBe(false)
    expect(initialRaw(read({ id: 't', kind: 'toggle', label: 'T', default: true }), DEVICE)).toBe(true)
    expect(initialRaw(read({ id: 'r', kind: 'daterange', label: 'R' }), DEVICE)).toEqual({ start: '', end: '' })
    expect(
      initialRaw(
        read({
          id: 'c',
          kind: 'choice',
          label: 'C',
          multiple: true,
          options: [{ value: 'a', label: 'A' }],
          default: ['a']
        }),
        DEVICE
      )
    ).toEqual(['a'])
  })
})

describe('a refusal of a field', () => {
  it('is read into the field and the problem', () => {
    expect(parseFieldRefusal('field:budget:format')).toEqual({ id: 'budget', problem: 'format' })
    expect(parseFieldRefusal('field:a_1:below_min')).toEqual({ id: 'a_1', problem: 'below_min' })
    expect(parseFieldRefusal('field:a:from_a_later_contract')).toEqual({ id: 'a', problem: 'unknown' })
    expect(parseFieldRefusal('files:too_many')).toBeNull()
    expect(parseFieldRefusal('field:Bad:format')).toBeNull()
    expect(parseFieldRefusal(null)).toBeNull()
  })
})

describe('minor units come from the gateway’s table, not the browser’s locale data', () => {
  it('takes two decimals for HUF, IDR and COP, whatever the platform says', () => {
    const forint = read({ id: 'a', kind: 'amount', label: 'A', currency: 'HUF' })

    expect(evaluate(forint, '1500.50', DEVICE)).toEqual({ value: '1500.50' })
    expect(evaluate(forint, '1500.505', DEVICE)).toEqual({ problem: 'format' })
    expect(evaluate(read({ id: 'a', kind: 'amount', label: 'A', currency: 'IDR' }), '10.25', DEVICE)).toEqual({
      value: '10.25'
    })
    expect(evaluate(read({ id: 'a', kind: 'amount', label: 'A', currency: 'IQD' }), '1.234', DEVICE)).toEqual({
      value: '1.234'
    })
    expect(evaluate(read({ id: 'a', kind: 'amount', label: 'A', currency: 'CLP' }), '10.5', DEVICE)).toEqual({
      problem: 'format'
    })
  })
})

describe('a step is exact', () => {
  it('takes 0.3 on a step of 0.1 and refuses what is only nearly on it', () => {
    const field = read({ id: 'n', kind: 'number', label: 'N', step: 0.1 })

    expect(evaluate(field, '0.3', DEVICE)).toEqual({ value: 0.3 })
    expect(evaluate(field, '0.30000000000000004', DEVICE)).toEqual({ problem: 'step' })
    expect(evaluate(field, '0.35', DEVICE)).toEqual({ problem: 'step' })
  })
})
