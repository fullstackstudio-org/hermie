/**
 * The reader of a `confirm` frame's structured fields (`contract/confirm-passkey` §4.1): what it accepts exactly as it
 * came, and every way a frame breaks the contract and is refused whole.
 */
import { describe, expect, it } from 'vitest'

import vectorsSource from '../../../../../contract/confirm-passkey/vectors.json?raw'
import { CONFIRM_FIELD_KINDS, CONFIRM_FIELD_LIMITS, readConfirmFields } from './confirm-fields'

const vectors = JSON.parse(vectorsSource) as { text_digest_v2_vectors: { name: string; fields: unknown }[] }

const field = (patch: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'cost',
  kind: 'amount',
  label: 'Estimated cost',
  value: '4.20',
  currency: '€',
  ...patch
})

const refused = (raw: unknown): boolean => !readConfirmFields(raw).ok

describe('fields that are fine', () => {
  it('is absent for a frame without any, and null is not absent', () => {
    expect(readConfirmFields(undefined)).toEqual({ ok: true, fields: undefined })
    expect(readConfirmFields(null)).toEqual({ ok: false })
  })

  it('reads every field of the contract’s vectors, exactly as it came', () => {
    for (const vector of vectors.text_digest_v2_vectors) {
      const read = readConfirmFields(vector.fields)

      expect(read.ok, vector.name).toBe(true)
      expect(read.ok ? read.fields : undefined, vector.name).toEqual(vector.fields)
    }
  })

  it('takes every kind, and a currency only on an amount', () => {
    for (const kind of CONFIRM_FIELD_KINDS) {
      const raw = kind === 'amount' ? field() : field({ kind, currency: undefined })

      expect(readConfirmFields([raw]).ok, kind).toBe(true)
    }

    expect(CONFIRM_FIELD_KINDS).toEqual(['amount', 'text', 'recipient', 'domain', 'model', 'count', 'date'])
  })

  it('keeps a string byte for byte: no trimming, cleaning or normalising', () => {
    // A precomposed and a decomposed é are different strings, and stay different.
    const read = readConfirmFields([
      field({ id: 'a', kind: 'text', currency: undefined, label: 'Café', value: 'café ·  x' }),
      field({ id: 'b', kind: 'text', currency: undefined, label: 'L', value: 'two  spaces' })
    ])

    expect(read.ok ? read.fields?.map(entry => entry.label + '|' + entry.value) : null).toEqual([
      'Café|café ·  x',
      'L|two  spaces'
    ])
  })

  it('takes eight fields, labels of 40, values of 200 and currencies of 16 code points', () => {
    const many = Array.from({ length: CONFIRM_FIELD_LIMITS.fields }, (_, index) =>
      field({ id: `f${index}`, kind: 'text', currency: undefined })
    )

    expect(readConfirmFields(many).ok).toBe(true)
    expect(readConfirmFields([field({ label: 'l'.repeat(40) })]).ok).toBe(true)
    expect(readConfirmFields([field({ value: 'v'.repeat(200) })]).ok).toBe(true)
    expect(readConfirmFields([field({ currency: 'c'.repeat(16) })]).ok).toBe(true)
    // Code points, not UTF-16 units: an astral character is one.
    expect(readConfirmFields([field({ label: '😀'.repeat(40) })]).ok).toBe(true)
    expect(readConfirmFields([field({ value: '😀'.repeat(200) })]).ok).toBe(true)
  })
})

describe('a frame whose fields break §4.1 is refused whole', () => {
  it('has one to eight fields, in a list', () => {
    expect(refused([])).toBe(true)
    expect(refused({ id: 'cost' })).toBe(true)
    expect(refused('fields')).toBe(true)
    expect(
      refused(Array.from({ length: 9 }, (_, index) => field({ id: `f${index}`, kind: 'text', currency: undefined })))
    ).toBe(true)
  })

  it('refuses one bad field among good ones, and shows none of them', () => {
    const read = readConfirmFields([field(), field({ id: 'to', kind: 'recipient', currency: undefined, value: '' })])

    expect(read).toEqual({ ok: false })
  })

  it('has an id of the contract’s shape, once', () => {
    for (const id of ['Cost', '1cost', 'co-st', '', 'x'.repeat(33), 7, undefined]) {
      expect(refused([field({ id })]), String(id)).toBe(true)
    }

    expect(refused([field(), field()])).toBe(true)
    expect(refused([field({ id: 'x'.repeat(32) })])).toBe(false)
  })

  it('has a kind the contract names', () => {
    for (const kind of ['link', 'AMOUNT', 'secret', '', 7, undefined]) {
      expect(refused([field({ kind, currency: undefined })]), String(kind)).toBe(true)
    }
  })

  it('has no key the contract does not name', () => {
    expect(refused([field({ href: 'https://example.com' })])).toBe(true)
    expect(refused([field({ hint: 'x' })])).toBe(true)
  })

  it('bounds the lengths, in code points, and does not allow an empty one', () => {
    expect(refused([field({ label: '' })])).toBe(true)
    expect(refused([field({ label: 'l'.repeat(41) })])).toBe(true)
    expect(refused([field({ label: '😀'.repeat(41) })])).toBe(true)
    expect(refused([field({ value: '' })])).toBe(true)
    expect(refused([field({ value: 'v'.repeat(201) })])).toBe(true)
    expect(refused([field({ currency: '' })])).toBe(true)
    expect(refused([field({ currency: 'c'.repeat(17) })])).toBe(true)
    expect(refused([field({ label: 7 })])).toBe(true)
    expect(refused([field({ value: null })])).toBe(true)
  })

  it('has a currency on an amount and on nothing else', () => {
    expect(refused([field({ kind: 'text' })])).toBe(true)
    expect(refused([field({ kind: 'count', currency: 'EUR' })])).toBe(true)
    expect(refused([field({ currency: null })])).toBe(true)
    expect(refused([field({ currency: undefined })])).toBe(false)
  })

  it.each([
    ['a line feed', 'a\nb'],
    ['a carriage return', 'a\rb'],
    ['a tab', 'a\tb'],
    ['a vertical tab', 'a\u000bb'],
    ['a line separator', 'a b'],
    ['a paragraph separator', 'a b'],
    ['a next-line character', 'a\u0085b'],
    ['a right-to-left override', 'a‮b'],
    ['a bidi isolate', 'a⁦b'],
    ['a zero-width space', 'a​b'],
    ['a zero-width joiner', 'a‍b'],
    ['a byte order mark', 'a﻿b'],
    ['a no-break space', 'a b'],
    ['an ideographic space', 'a　b'],
    ['a blank Hangul letter', 'aㅤb'],
    ['a blank Braille pattern', 'a⠀b'],
    ['a Khitan small script filler (U+16FE4)', 'a\u{16fe4}b'],
    ['a musical null notehead (U+1D159)', 'a\u{1d159}b'],
    ['a variation selector', 'a️b'],
    ['a tag character', 'a\u{e0041}b'],
    ['a soft hyphen', 'a­b'],
    ['a control character', 'a\u0007b'],
    ['an unassigned code point', 'a\u{378}b'],
    ['a lone surrogate', 'a\ud800b'],
    ['a private-use character', 'ab'],
    ['five combining marks in a row', 'á̂̃̄̅b'],
    ['a run of 17 spaces', `a${' '.repeat(17)}b`],
    ['a space at the start', ' a'],
    ['a space at the end', 'a ']
  ])('refuses %s in a label, a value and a currency', (_name, text) => {
    expect(refused([field({ label: text })])).toBe(true)
    expect(refused([field({ value: text })])).toBe(true)
    expect(refused([field({ currency: text })])).toBe(true)
  })

  it('takes four combining marks in a row and a run of 16 spaces', () => {
    expect(refused([field({ value: 'á̂̃̄b' })])).toBe(false)
    expect(refused([field({ value: `a${' '.repeat(16)}b` })])).toBe(false)
  })
})
