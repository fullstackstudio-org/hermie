/**
 * The readers of the interactive requests' params, held to the contract's own examples
 * (`contract/requests/examples.json`, normative): every valid frame decodes into the
 * types, every frame the gateway never sends is refused or comes out clean, and what a
 * later contract adds cannot crash a reader.
 */
import { describe, expect, it } from 'vitest'

import examplesSource from '../../../../../contract/requests/examples.json?raw'
import {
  type DraftAsk,
  type FileAsk,
  type FormAsk,
  type FormField,
  instantSeconds,
  type InteractiveAsk,
  INTERACTIVE_METHODS,
  isInteractiveMethod,
  LAYOUT_LIMITS,
  LIMITS,
  minorUnits,
  onStep,
  readInteractiveParams,
  stripLineEnds,
  unknownFields,
  verbatimIssue,
  verbatimProblem
} from './interactive-types'

interface Frame {
  id: string
  method: string
  params: Record<string, unknown>
}

interface Examples {
  methods: Record<
    string,
    {
      frames: Frame[]
      invalid_frames: { name: string; layer: string; params: Record<string, unknown> }[]
      answers: { name: string; request: string; result: Record<string, unknown> }[]
    }
  >
  form_fields: { name: string; field: Record<string, unknown> }[]
}

const examples = JSON.parse(examplesSource) as Examples

/** The contract's methods this client does not read yet: `review.diff` lands with its sheet (P2-W1). */
const NOT_YET_READ = ['review.diff']

const readMethods = Object.fromEntries(
  Object.entries(examples.methods).filter(([method]) => !NOT_YET_READ.includes(method))
)

const frames = Object.entries(readMethods).flatMap(([method, entry]) => entry.frames.map(frame => ({ method, frame })))

const form = (params: Record<string, unknown>): ReturnType<typeof readInteractiveParams> =>
  readInteractiveParams('input.form', params)

/** A form frame with `fields`, the envelope the contract's own example uses. */
const formWith = (...fields: Record<string, unknown>[]): Record<string, unknown> => ({
  session_id: 's_x',
  v: 1,
  title: 'T',
  summary: 'S',
  expires_at: 1_791_119_400,
  optional: true,
  fields
})

const ask = (result: ReturnType<typeof readInteractiveParams>): InteractiveAsk => {
  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`)
  }

  return result.ask
}

describe('the methods', () => {
  it('are the contract’s three, and nothing else is read', () => {
    expect(examples.methods).toBeDefined()
    expect(Object.keys(examples.methods).sort()).toEqual([...INTERACTIVE_METHODS, ...NOT_YET_READ].sort())
    expect(isInteractiveMethod('input.form')).toBe(true)
    expect(isInteractiveMethod('confirm')).toBe(false)
    expect(readInteractiveParams('confirm', formWith({ id: 'a', kind: 'toggle', label: 'A' }))).toEqual({
      ok: false,
      reason: 'not_supported_on_device'
    })
  })
})

describe('every valid frame of the examples', () => {
  it.each(frames.map(entry => [entry.frame.id, entry] as const))('decodes %s', (_id, { method, frame }) => {
    const result = readInteractiveParams(method, frame.params)

    expect(result.ok).toBe(true)

    if (!result.ok) {
      return
    }

    expect(result.ask.method).toBe(method)
    expect(result.ask.title).toBe(frame.params.title)
    expect(result.ask.summary).toBe(frame.params.summary)
    expect(result.ask.expiresAt).toBe(frame.params.expires_at)
    expect(result.ask.optional).toBe(frame.params.optional)
    expect(unknownFields(result.ask)).toEqual([])
  })

  it('reads the booking form field by field', () => {
    const booking = frames.find(entry => entry.frame.id === 'req_form_booking')

    if (!booking) {
      throw new Error('example gone')
    }

    const read = ask(readInteractiveParams(booking.method, booking.frame.params)) as FormAsk

    expect(read.actingUser).toBe('Ada')
    expect(read.fields.map(field => field.kind)).toEqual([
      'text',
      'number',
      'daterange',
      'amount',
      'date',
      'time',
      'datetime',
      'choice',
      'choice',
      'toggle',
      'text'
    ])
    expect(read.fields[0]).toMatchObject({
      id: 'name',
      required: true,
      maxLength: 20,
      multiline: false,
      input: 'plain'
    })
    expect(read.fields[1]).toMatchObject({ kind: 'number', min: 1, max: 12, integer: true, default: 2 })
    expect(read.fields[3]).toMatchObject({ kind: 'amount', currency: 'EUR', min: '0', max: '5000' })
    expect(read.fields[4]).toMatchObject({ kind: 'date', tz: 'Europe/Amsterdam' })
    expect(read.fields[7]).toMatchObject({ kind: 'choice', multiple: false })
    expect(read.fields[8]).toMatchObject({ kind: 'choice', multiple: true, maxSelected: 2 })
    expect(read.fields[9]).toMatchObject({ kind: 'toggle', default: false })
    expect(read.fields[10]).toMatchObject({ kind: 'text', multiline: true, maxLength: LIMITS.textMaxLength })
  })

  it('reads a file request, its upload rules and its preference for the camera', () => {
    const receipt = frames.find(entry => entry.frame.id === 'req_file_receipt')
    const contracts = frames.find(entry => entry.frame.id === 'req_file_contracts')

    if (!receipt || !contracts) {
      throw new Error('example gone')
    }

    const photo = ask(readInteractiveParams(receipt.method, receipt.frame.params)) as FileAsk
    const documents = ask(readInteractiveParams(contracts.method, contracts.frame.params)) as FileAsk

    expect(photo).toMatchObject({
      accept: 'image',
      capture: 'photo',
      multiple: false,
      optional: true,
      upload: {
        dir: '/home/ada/work/uploads/hermie/2026-10-04',
        maxBytes: 10_485_760,
        maxFiles: 1,
        stripMetadata: true
      }
    })
    expect(documents).toMatchObject({ accept: 'document', multiple: true, optional: false })
    expect(documents.capture).toBeUndefined()
    expect(documents.upload.maxTotalBytes).toBe(52_428_800)
  })

  it('reads a draft verbatim: its blank lines are the draft’s', () => {
    const mail = frames.find(entry => entry.frame.id === 'req_draft_mail')

    if (!mail) {
      throw new Error('example gone')
    }

    const read = ask(readInteractiveParams(mail.method, mail.frame.params)) as DraftAsk

    expect(read.text).toBe(mail.frame.params.text)
    expect(read.text).toContain('\n\n')
    expect(read).toMatchObject({
      kind: 'mail',
      subject: 'Re: Flat on the Oudegracht',
      recipients: ['Bram de Vries <bram@example.com>'],
      editable: true,
      optional: false
    })
  })

  it('reads every field definition of the examples', () => {
    expect(examples.form_fields.length).toBeGreaterThan(10)

    for (const { name, field } of examples.form_fields) {
      const result = form(formWith(field))

      expect(result.ok, name).toBe(true)
      expect(unknownFields(ask(result)), name).toEqual([])
    }
  })
})

describe('every frame the gateway never sends', () => {
  const invalid = Object.entries(readMethods).flatMap(([method, entry]) =>
    entry.invalid_frames.map(frame => ({ method, ...frame }))
  )

  it('is there to be held to', () => {
    expect(invalid.length).toBeGreaterThan(25)
  })

  it.each(invalid.map(entry => [`${entry.method} ${entry.name}`, entry] as const))(
    '%s is refused or comes out clean',
    (_name, entry) => {
      const result = readInteractiveParams(entry.method, entry.params)

      if (!result.ok) {
        expect(result.reason).toBe('not_supported_on_device')

        return
      }

      // Only a text the gateway refused for a character it cannot show may pass, and then without that character.
      expect(entry.name).toMatch(/separator/u)
      expect(result.ask.title).not.toMatch(/[\u2028\u2029]/u)
    }
  )

  it('refuses every contradiction between fields (the contract’s cross_field layer)', () => {
    const contradictions = invalid.filter(entry => entry.layer === 'cross_field')

    expect(contradictions.length).toBeGreaterThan(20)

    for (const entry of contradictions) {
      expect(readInteractiveParams(entry.method, entry.params).ok, entry.name).toBe(false)
    }
  })
})

describe('the envelope', () => {
  const draft = (): Record<string, unknown> => {
    const mail = frames.find(entry => entry.frame.id === 'req_draft_post')

    return { ...(mail?.frame.params ?? {}) }
  }

  it('declines a version it does not know with its own reason', () => {
    expect(readInteractiveParams('review.draft', { ...draft(), v: 2 })).toEqual({
      ok: false,
      reason: 'unsupported_version'
    })
    expect(readInteractiveParams('review.draft', { ...draft(), v: undefined })).toEqual({
      ok: false,
      reason: 'unsupported_version'
    })
  })

  it('declines what is not params, and never throws', () => {
    for (const nonsense of [null, undefined, 'x', 7, [], [{}], { v: 1 }]) {
      expect(readInteractiveParams('input.form', nonsense).ok).toBe(false)
    }
  })

  it('needs a heading, words, and a deadline', () => {
    expect(readInteractiveParams('review.draft', { ...draft(), title: '' }).ok).toBe(false)
    expect(readInteractiveParams('review.draft', { ...draft(), title: '\u202E\u0000' }).ok).toBe(false)
    expect(readInteractiveParams('review.draft', { ...draft(), summary: 7 }).ok).toBe(false)
    expect(readInteractiveParams('review.draft', { ...draft(), expires_at: undefined }).ok).toBe(false)
    expect(readInteractiveParams('review.draft', { ...draft(), expires_at: '1791119400' }).ok).toBe(false)
  })

  it('cleans and bounds every text the sheet will draw', () => {
    const read = ask(
      readInteractiveParams('review.draft', {
        ...draft(),
        title: `Pay\u202E now\u0000!${'x'.repeat(200)}`,
        summary: 'Line\n\n\n\none  \t two',
        detail: `Detail\u200B text`,
        subject: 'Re:\u202E hi',
        recipients: ['bram\u202E@example.com', 'a'.repeat(500)],
        acting_user: { id: 'u', name: 'Ada\u202E Lovelace' }
      })
    ) as DraftAsk

    expect(read.title).not.toMatch(/\u202E/u)
    expect(read.title).not.toContain('\u0000')
    expect(Array.from(read.title).length).toBeLessThanOrEqual(LIMITS.title + 1)
    expect(read.title.endsWith('…')).toBe(true)
    expect(read.summary).toBe('Line\none two')
    expect(read.detail).toBe('Detail text')
    expect(read.subject).toBe('Re: hi')
    expect(read.recipients[0]).toBe('bram@example.com')
    expect(Array.from(read.recipients[1] ?? '').length).toBeLessThanOrEqual(LIMITS.draftRecipient + 1)
    expect(read.actingUser).toBe('Ada Lovelace')
  })

  it('defaults Skip the way the contract does: offered for input, never for a review', () => {
    const { optional: _optional, ...bare } = formWith({ id: 'a', kind: 'toggle', label: 'A' })
    const { optional: _optionalDraft, ...bareDraft } = draft()

    expect(ask(form(bare)).optional).toBe(true)
    expect(ask(readInteractiveParams('review.draft', bareDraft)).optional).toBe(false)
  })
})

describe('a form', () => {
  it('has one to twelve fields', () => {
    const field = (index: number): Record<string, unknown> => ({ id: `f${index}`, kind: 'toggle', label: 'F' })

    expect(form(formWith()).ok).toBe(false)
    expect(form(formWith(...Array.from({ length: 12 }, (_, index) => field(index)))).ok).toBe(true)
    expect(form(formWith(...Array.from({ length: 13 }, (_, index) => field(index)))).ok).toBe(false)
  })

  it('reads a kind it does not know as an unknown field, and says which', () => {
    const read = ask(
      form(
        formWith(
          { id: 'name', kind: 'text', label: 'Name' },
          { id: 'sig', kind: 'signature\u202E', label: 'Sign here', required: true }
        )
      )
    )
    const unknown = unknownFields(read)

    expect(unknown).toEqual([{ kind: 'unknown', rawKind: 'signature', id: 'sig', label: 'Sign here', required: true }])
    expect((read as FormAsk).fields.map((field: FormField) => field.kind)).toEqual(['text', 'unknown'])
  })

  it('refuses a field with no usable id, and ids that repeat', () => {
    expect(form(formWith({ id: 'Name', kind: 'toggle', label: 'N' })).ok).toBe(false)
    expect(form(formWith({ kind: 'toggle', label: 'N' })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'toggle', label: 'N' }, { id: 'a', kind: 'toggle', label: 'M' })).ok).toBe(
      false
    )
    expect(form(formWith({ id: 'a', kind: 'toggle', label: '' })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'toggle', label: 'x'.repeat(61) })).ok).toBe(false)
  })

  it('cleans labels, hints, option labels and a text’s default, and keeps option values and ids exactly', () => {
    const read = ask(
      form(
        formWith(
          { id: 'name', kind: 'text', label: 'Na\u202Eme', hint: 'Your\u0000 name', default: 'Ada\u200B' },
          { id: 'room', kind: 'choice', label: 'Room', options: [{ value: 'dbl_1', label: 'Dou\u202Eble' }] }
        )
      )
    ) as FormAsk

    expect(read.fields[0]).toMatchObject({ id: 'name', label: 'Name', hint: 'Your name', default: 'Ada' })
    expect(read.fields[1]).toMatchObject({ options: [{ value: 'dbl_1', label: 'Double' }] })
  })

  it('starts a multi-line field with its default as it came: that is what goes back unless it is changed', () => {
    const text = 'Line one  \n\n\n\nLine five\twith a tab'
    const read = ask(
      form(formWith({ id: 'note', kind: 'text', label: 'Note', multiline: true, default: text }))
    ) as FormAsk

    expect(read.fields[0]).toMatchObject({ kind: 'text', multiline: true, default: text })
  })

  it('declines a multi-line default that would put a control, bidi or invisible character in the field', () => {
    for (const bad of ['Pay \u202Eexe.txt', 'a\u0000b', 'a\u200Bb', 'a\rb', 'a\u2028b', 'a\uE000b']) {
      expect(
        form(formWith({ id: 'note', kind: 'text', label: 'Note', multiline: true, default: bad })),
        JSON.stringify(bad)
      ).toEqual({ ok: false, reason: 'not_supported_on_device' })
    }

    // A one-line default is cleaned for display instead, as before.
    expect(ask(form(formWith({ id: 'name', kind: 'text', label: 'Name', default: 'Ada\u202E' })))).toMatchObject({
      fields: [{ default: 'Ada' }]
    })
  })

  it('reads a keyboard hint it does not know as plain, instead of refusing the form', () => {
    const read = ask(
      form(
        formWith(
          { id: 'code', kind: 'text', label: 'Code', input: 'otp' },
          { id: 'mail', kind: 'text', label: 'Mail', input: 'email' },
          { id: 'odd', kind: 'text', label: 'Odd', input: 7 }
        )
      )
    ) as FormAsk

    expect(read.fields.map(field => (field.kind === 'text' ? field.input : null))).toEqual(['plain', 'email', 'plain'])
  })

  it('reads amounts in thousandths, and refuses the decimals a currency does not have', () => {
    expect(form(formWith({ id: 'a', kind: 'amount', label: 'A', currency: 'EUR', max: '10.50' })).ok).toBe(true)
    expect(form(formWith({ id: 'a', kind: 'amount', label: 'A', currency: 'EUR', max: '10.505' })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'amount', label: 'A', currency: 'JPY', max: '10.5' })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'amount', label: 'A', currency: 'KWD', max: '10.505' })).ok).toBe(true)
    expect(form(formWith({ id: 'a', kind: 'amount', label: 'A', currency: 'eur' })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'amount', label: 'A', currency: 'EUR', max: 10 })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'amount', label: 'A', currency: 'EUR', min: '1.00', max: '0.99' })).ok).toBe(
      false
    )
  })

  it('reads instants with their offset, never Z and never fractions', () => {
    expect(instantSeconds('2026-10-05T00:00+02:00')).toBe(Date.UTC(2026, 9, 4, 22, 0, 0) / 1000)
    expect(instantSeconds('2026-10-05T00:00:30-05:30')).toBe(Date.UTC(2026, 9, 5, 5, 30, 30) / 1000)
    expect(instantSeconds('2026-10-05T00:00:00Z')).toBeNull()
    expect(instantSeconds('2026-10-05T00:00:00.5+02:00')).toBeNull()
    expect(instantSeconds('2026-02-30T00:00+02:00')).toBeNull()
    expect(instantSeconds('2026-10-05T24:00+02:00')).toBeNull()
    expect(instantSeconds(5)).toBeNull()
  })

  it('refuses a zone this runtime does not know, and a number that is not a number', () => {
    expect(form(formWith({ id: 'a', kind: 'date', label: 'A', tz: 'Mars/Olympus_Mons' })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'date', label: 'A', tz: 'Europe/Amsterdam' })).ok).toBe(true)
    expect(form(formWith({ id: 'a', kind: 'number', label: 'A', min: '1' })).ok).toBe(false)
    expect(form(formWith({ id: 'a', kind: 'number', label: 'A', step: 0 })).ok).toBe(false)
  })

  it('refuses a choice with no options, too many, or a selection bound that makes no sense', () => {
    const options = (count: number): Record<string, unknown>[] =>
      Array.from({ length: count }, (_, index) => ({ value: `o${index}`, label: `O${index}` }))
    const choice = (extra: Record<string, unknown>, count = 3): Record<string, unknown> => ({
      id: 'c',
      kind: 'choice',
      label: 'C',
      options: options(count),
      ...extra
    })

    expect(form(formWith(choice({}, 0))).ok).toBe(false)
    expect(form(formWith(choice({}, 13))).ok).toBe(false)
    expect(form(formWith(choice({}, 12))).ok).toBe(true)
    expect(form(formWith(choice({ multiple: true, min_selected: 1, max_selected: 3 }))).ok).toBe(true)
    expect(form(formWith(choice({ multiple: true, min_selected: 4 }))).ok).toBe(false)
    expect(form(formWith(choice({ min_selected: 1 }))).ok).toBe(false)
    expect(form(formWith(choice({ multiple: true, default: ['o0', 'o0'] }))).ok).toBe(false)
  })
})

describe('a file request', () => {
  const base = (): Record<string, unknown> => {
    const frame = frames.find(entry => entry.frame.id === 'req_file_receipt')

    return JSON.parse(JSON.stringify(frame?.frame.params ?? {})) as Record<string, unknown>
  }

  it('ignores a capture preference it does not know, and refuses an accept it does not know', () => {
    expect((ask(readInteractiveParams('input.file', { ...base(), capture: 'hologram' })) as FileAsk).capture).toBe(
      undefined
    )
    expect(readInteractiveParams('input.file', { ...base(), accept: 'video' }).ok).toBe(false)
  })

  it('keeps `capture: scan` as a preference the page may ignore', () => {
    expect((ask(readInteractiveParams('input.file', { ...base(), capture: 'scan' })) as FileAsk).capture).toBe('scan')
  })

  it('refuses upload rules that are not bounded', () => {
    const upload = (patch: Record<string, unknown>): Record<string, unknown> => ({
      ...base(),
      upload: { ...(base().upload as Record<string, unknown>), ...patch }
    })

    expect(readInteractiveParams('input.file', upload({ dir: '' })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ dir: 'uploads/hermie' })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ dir: '/home/ada/../root/uploads' })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ dir: '/home/ada/..' })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ dir: '/home/ada/up\u0000loads' })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ dir: '/home/ada/up\nloads' })).ok).toBe(false)
    // A name with dots in it is a name.
    expect(readInteractiveParams('input.file', upload({ dir: '/home/ada/..uploads/x..y' })).ok).toBe(true)
    expect(readInteractiveParams('input.file', upload({ max_files: 11 })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ max_files: 0 })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ max_bytes: LIMITS.uploadBytes + 1 })).ok).toBe(false)
    expect(readInteractiveParams('input.file', upload({ max_total_bytes: 1 })).ok).toBe(false)
    expect(readInteractiveParams('input.file', { ...base(), upload: 'here' }).ok).toBe(false)
  })
})

describe('a draft', () => {
  const base = (): Record<string, unknown> => {
    const frame = frames.find(entry => entry.frame.id === 'req_draft_mail')

    return JSON.parse(JSON.stringify(frame?.frame.params ?? {})) as Record<string, unknown>
  }

  it('is carried verbatim, trailing blanks and all, and bounded', () => {
    const text = 'One  \n\n\nTwo  \u00A0'

    expect((ask(readInteractiveParams('review.draft', { ...base(), text })) as DraftAsk).text).toBe(text)
    expect(readInteractiveParams('review.draft', { ...base(), text: '' }).ok).toBe(false)
    expect(readInteractiveParams('review.draft', { ...base(), text: 'x'.repeat(LIMITS.draftText + 1) }).ok).toBe(false)
    expect(readInteractiveParams('review.draft', { ...base(), kind: 'tweet' }).ok).toBe(false)
    expect(readInteractiveParams('review.draft', { ...base(), recipients: Array(11).fill('a@b.c') }).ok).toBe(false)
  })

  it('declines a text the gateway’s verbatim rule refuses: it could not be approved as it is', () => {
    for (const bad of [
      'Hello\tBram',
      'Hello \u202EBram',
      'Hello\u200BBram',
      'Hello\u00A0Bram',
      'Hello\u0000Bram',
      'Hello\rBram',
      'Hello\u2028Bram',
      'Hello\uE000Bram',
      'Hello\u{10FFFF}Bram',
      'Hello\u2800Bram',
      'Hello\uFE0FBram',
      `e${'\u0301'.repeat(5)}`,
      'lone \uD800 surrogate'
    ]) {
      expect(verbatimProblem(bad), JSON.stringify(bad)).toBe(true)
      expect(readInteractiveParams('review.draft', { ...base(), text: bad })).toEqual({
        ok: false,
        reason: 'not_supported_on_device'
      })
    }

    // Line-end whitespace is stripped by the gateway before it looks; four marks on one letter are allowed.
    for (const good of [
      'Hello Bram,  \n\nThanks.\t \n',
      'One  \n\n\nTwo  \u00A0',
      `e${'\u0301'.repeat(4)}`,
      'Grüße 👋🏽'
    ]) {
      expect(verbatimProblem(good), JSON.stringify(good)).toBe(false)
    }
  })
})

describe('the gateway’s draft rules (contract §6.1 to §6.3)', () => {
  const sp = (count: number): string => ' '.repeat(count)
  const cp = (code: number): string => String.fromCodePoint(code)

  it('strips first: LF only, Python’s isspace at the end of each line and of the text, leading whitespace kept', () => {
    expect(stripLineEnds('a  \nb\t\n\n  c \n\n')).toBe('a\nb\n\n  c')
    // CR is not a line break: it is whitespace at the end of a line (or refused in the middle of one).
    expect(stripLineEnds('a\r\nb\r\n')).toBe('a\nb')
    expect(stripLineEnds(`a${cp(0xa0)}${cp(0x3000)}${cp(0x2028)}\nb`)).toBe('a\nb')
    expect(stripLineEnds(`a${cp(0x1c)}${cp(0x85)}${cp(0x202f)}\nb`)).toBe('a\nb')
    expect(stripLineEnds('   \n  \nx')).toBe('\n\nx')
    expect(stripLineEnds('  \n \t ')).toBe('')
    expect(stripLineEnds('\n\nx')).toBe('\n\nx')
  })

  it('refuses a character that cannot be shown as it is, after stripping', () => {
    expect(verbatimIssue('a\tb')).toEqual({ rule: 'character', codePoint: 9 })
    expect(verbatimIssue('a\rb')).toEqual({ rule: 'character', codePoint: 13 })
    expect(verbatimIssue(`a${cp(0x7f)}b`)).toEqual({ rule: 'character', codePoint: 0x7f })
    expect(verbatimIssue(`a${cp(0x85)}b`)).toEqual({ rule: 'character', codePoint: 0x85 })
    expect(verbatimIssue(`a${cp(0xa0)}b`)).toEqual({ rule: 'character', codePoint: 0xa0 })
    expect(verbatimIssue(`a${cp(0x2028)}b`)).toEqual({ rule: 'character', codePoint: 0x2028 })
    expect(verbatimIssue(`a${cp(0x200b)}b`)).toEqual({ rule: 'character', codePoint: 0x200b })
    expect(verbatimIssue(`a${cp(0xad)}b`)).toEqual({ rule: 'character', codePoint: 0xad })
    expect(verbatimIssue(`a${cp(0xfe0f)}b`)).toEqual({ rule: 'character', codePoint: 0xfe0f })
    expect(verbatimIssue(`a${cp(0xe0100)}b`)).toEqual({ rule: 'character', codePoint: 0xe0100 })
    expect(verbatimIssue(`a${cp(0x3164)}b`)).toEqual({ rule: 'character', codePoint: 0x3164 })
    expect(verbatimIssue(`a${cp(0x2800)}b`)).toEqual({ rule: 'character', codePoint: 0x2800 })
    expect(verbatimIssue(`a${cp(0x1d159)}b`)).toEqual({ rule: 'character', codePoint: 0x1d159 })
    expect(verbatimIssue(`a${cp(0xe000)}b`)).toEqual({ rule: 'character', codePoint: 0xe000 })
    expect(verbatimIssue(`a${cp(0x0378)}b`)).toEqual({ rule: 'character', codePoint: 0x378 })
    // A tab or a CR at the end of a line is stripped, not refused.
    expect(verbatimIssue('a\t\nb\r\n')).toBeNull()
    expect(verbatimIssue('plain text\n\n  indented\n')).toBeNull()
  })

  it('refuses more than 4 combining marks in a row, counted from any character before them', () => {
    const marks = (count: number): string => cp(0x301).repeat(count)

    expect(verbatimIssue(`e${marks(4)}`)).toBeNull()
    expect(verbatimIssue(`e${marks(5)}`)).toEqual({ rule: 'marks' })
    expect(verbatimIssue(marks(5))).toEqual({ rule: 'marks' })
    // A space or a base letter resets the count.
    expect(verbatimIssue(`${marks(4)} ${marks(4)}`)).toBeNull()
  })

  it('refuses spacing that could push part of a text out of view, with the rule and the line', () => {
    expect(LAYOUT_LIMITS).toEqual({ spaceRun: 16, indent: 32, blankLines: 3, lineChars: 2000 })
    expect(verbatimIssue(`x${sp(17)}y`)).toEqual({ rule: 'space_run', line: 1, size: 17 })
    expect(verbatimIssue(`x${sp(16)}y`)).toBeNull()
    expect(verbatimIssue(`${sp(33)}x`)).toEqual({ rule: 'indent', line: 1, size: 33 })
    expect(verbatimIssue(`${sp(32)}x`)).toBeNull()
    // The indent is not also a space run; a later run on a deep line is measured against MAX_SPACE_RUN.
    expect(verbatimIssue(`${sp(32)}x${sp(16)}y`)).toBeNull()
    expect(verbatimIssue(`${sp(32)}x${sp(17)}y`)).toEqual({ rule: 'space_run', line: 1, size: 17 })
    expect(verbatimIssue('a\n\n\n\nb')).toBeNull()
    expect(verbatimIssue('a\n\n\n\n\nb')).toEqual({ rule: 'blank_lines', line: 2 })
    expect(verbatimIssue('\n\n\n\nx')).toEqual({ rule: 'blank_lines', line: 1 })
    // A line of spaces is an empty line once stripped; blank lines at the end are stripped, never counted.
    expect(verbatimIssue('a\n \n  \n   \n    \nb')).toEqual({ rule: 'blank_lines', line: 2 })
    expect(verbatimIssue('a\n\n\n\n\n\n\n')).toBeNull()
    expect(verbatimIssue('x'.repeat(2000))).toBeNull()
    expect(verbatimIssue(`ok\n${'x'.repeat(2001)}`)).toEqual({ rule: 'line_length', line: 2, size: 2001 })
    // Code points, not UTF-16 units.
    expect(verbatimIssue('😀'.repeat(2000))).toBeNull()
    expect(verbatimIssue('😀'.repeat(2001))).toEqual({ rule: 'line_length', line: 1, size: 2001 })
    // The indent counts in the line's length.
    expect(verbatimIssue(`${sp(10)}${'x'.repeat(1991)}`)).toEqual({ rule: 'line_length', line: 1, size: 2001 })
  })

  it('judges the characters before the layout, and the stripped text, as the gateway does', () => {
    expect(verbatimIssue(`${sp(40)}x\t y`)).toEqual({ rule: 'character', codePoint: 9 })
    expect(verbatimProblem(`x${sp(17)}y`)).toBe(true)
    expect(verbatimProblem(`x${sp(17)}y`, { layout: false })).toBe(false)
    expect(verbatimProblem('a\tb', { tab: true, layout: false })).toBe(false)
  })

  it('declines a draft frame whose text breaks a layout rule: it could not be approved as it is', () => {
    const frame = (text: string): Record<string, unknown> => ({
      session_id: 's',
      v: 1,
      title: 'T',
      summary: 'S',
      expires_at: 1_791_119_400,
      optional: false,
      kind: 'mail',
      text,
      editable: true
    })

    expect(readInteractiveParams('review.draft', frame(`x${sp(17)}y`))).toEqual({
      ok: false,
      reason: 'not_supported_on_device'
    })
    expect(readInteractiveParams('review.draft', frame('fine')).ok).toBe(true)
  })
})

describe('ISO 4217 minor units, as the gateway’s table has them', () => {
  it.each([
    ['EUR', 2],
    ['USD', 2],
    ['JPY', 0],
    ['KRW', 0],
    ['ISK', 0],
    ['CLP', 0],
    ['VND', 0],
    ['KWD', 3],
    ['BHD', 3],
    ['IQD', 3],
    ['JOD', 3],
    // The browser's own locale data says 0 for these; the gateway's table (ISO 4217) says 2.
    ['HUF', 2],
    ['IDR', 2],
    ['COP', 2],
    ['TWD', 2],
    ['LBP', 2],
    // ISO 4217 has four decimals for these, and a decimal string never has more than three.
    ['CLF', 3],
    ['UYW', 3],
    // Not in the table: the answer check's two.
    ['XXX', 2],
    ['ZZZ', 2]
  ])('%s has %i decimals', (code, decimals) => {
    expect(minorUnits(code)).toBe(decimals)
  })
})

describe('a step in exact decimal arithmetic', () => {
  it('is on a step by integer arithmetic, with no floating-point tolerance', () => {
    expect(onStep(0.3, 0, 0.1)).toBe(true)
    expect(onStep('0.3', 0, 0.1)).toBe(true)
    expect(onStep('0.30000000000000004', 0, 0.1)).toBe(false)
    expect(onStep('0.3000000001', 0, 0.1)).toBe(false)
    expect(onStep(7, 1, 2)).toBe(true)
    expect(onStep(4, 1, 2)).toBe(false)
    expect(onStep('1.05', 1, 0.05)).toBe(true)
    expect(onStep('-0.5', -1, 0.25)).toBe(true)
    expect(onStep('1e3', 0, 5)).toBe(true)
    expect(onStep('1e-7', 0, 1e-7)).toBe(true)
    expect(onStep('3e-7', 0, 2e-7)).toBe(false)
    expect(onStep('12345678901234567890.5', 0, 0.5)).toBe(true)
    expect(onStep(5, undefined, undefined)).toBe(true)
  })
})
