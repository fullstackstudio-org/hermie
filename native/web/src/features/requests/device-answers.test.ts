// @vitest-environment node
/**
 * What the device sheets answer with, composed from what a browser gives them and held to the gateway's own check of an
 * answer (`refusalFor` of the fake gateway, a port of the fork's validators: shape, then every refusal reason of
 * `contract/requests` sections 8 to 12). Data minimisation is under test here: a location is never more precise than
 * the person chose, a contact carries only what was ticked and asked for, a code only a symbology that was asked for.
 */
import { refusalFor } from '@hermie/fake-gateway'
import { describe, expect, it } from 'vitest'

import examplesSource from '../../../../../contract/requests/examples.json?raw'
import {
  candidateOf,
  contactAnswer,
  DETECTOR_FORMATS,
  type Fix,
  locationAnswer,
  scanAnswer,
  signatureAnswer,
  symbologyOf
} from './device-answers'
import { type ContactField, SYMBOLOGIES, type UploadedFile } from '../../core/requests/interactive-types'
import { flatUploadPath } from '../../core/chats/file-upload'

type Obj = Record<string, unknown>

const examples = JSON.parse(examplesSource) as { methods: Record<string, { frames: { id: string; params: Obj }[] }> }

/** The params of one of the contract's frames, as the gateway holds the request: what an answer is checked against. */
const paramsOf = (method: string, id: string): Obj => {
  const frame = examples.methods[method]?.frames.find(entry => entry.id === id)

  if (!frame) {
    throw new Error(`example gone: ${id}`)
  }

  return frame.params
}

const NOW_MS = 1_791_119_300_000
const FIX: Fix = { latitude: 52.373123456, longitude: 4.892201789, accuracy: 8.46, timestamp: NOW_MS }

describe('a location answer', () => {
  const approx = paramsOf('device.location', 'req_loc_approx')
  const precise = paramsOf('device.location', 'req_loc_precise')

  it('rounds an approximate share to two decimals and says no better than a kilometre', () => {
    const answer = locationAnswer('approximate', 'approximate', FIX)

    expect(answer).toEqual({
      status: 'answered',
      lat: 52.37,
      lon: 4.89,
      accuracy_m: 1000,
      at: 1_791_119_300,
      precision: 'approximate'
    })
    expect(refusalFor('device.location', approx, answer)).toBeNull()
  })

  it('keeps six decimals of a precise share, and the accuracy the browser reported', () => {
    const answer = locationAnswer('precise', 'precise', FIX)

    expect(answer).toMatchObject({ lat: 52.373123, lon: 4.892202, accuracy_m: 8.5, precision: 'precise' })
    expect(refusalFor('device.location', precise, answer)).toBeNull()
  })

  it('shares less when the person lowered it, and never more than was asked, whatever was chosen', () => {
    const lowered = locationAnswer('precise', 'approximate', FIX)

    expect(lowered).toMatchObject({ lat: 52.37, lon: 4.89, precision: 'approximate' })
    expect(refusalFor('device.location', precise, lowered)).toBeNull()

    // An approximate request answered "precise" would be refused (`precision:too_precise`); the page cannot say it.
    const stuck = locationAnswer('approximate', 'precise', FIX)

    expect(stuck).toMatchObject({ lat: 52.37, precision: 'approximate' })
    expect(refusalFor('device.location', approx, stuck)).toBeNull()
    expect(refusalFor('device.location', approx, { ...stuck, precision: 'precise' })).toBe('precision:too_precise')
  })

  it('does not say a better accuracy than the browser gave, and does not worsen a precise one', () => {
    expect(locationAnswer('approximate', 'approximate', { ...FIX, accuracy: 4_500 })).toMatchObject({
      accuracy_m: 4500
    })
    expect(locationAnswer('precise', 'precise', { ...FIX, accuracy: 0 })).toMatchObject({ accuracy_m: 0 })
    expect(locationAnswer('precise', 'precise', { ...FIX, accuracy: 5e9 })).toMatchObject({ accuracy_m: 10_000_000 })
  })

  it('rounds the southern and western hemispheres the same way, and never writes -0', () => {
    expect(
      locationAnswer('approximate', 'approximate', { ...FIX, latitude: -33.8688, longitude: 151.2093 })
    ).toMatchObject({
      lat: -33.87,
      lon: 151.21
    })
    expect(locationAnswer('approximate', 'approximate', { ...FIX, latitude: -0.004, longitude: -0.004 })).toMatchObject(
      {
        lat: 0,
        lon: 0
      }
    )
    expect(Object.is(locationAnswer('approximate', 'approximate', { ...FIX, latitude: -0.004 })?.lat, -0)).toBe(false)
  })

  it('gives nothing for a fix the contract could not carry', () => {
    for (const bad of [
      { latitude: 91 },
      { latitude: -90.5 },
      { longitude: 180.5 },
      { latitude: NaN },
      { longitude: Infinity },
      { accuracy: -1 },
      { accuracy: NaN }
    ]) {
      expect(locationAnswer('precise', 'precise', { ...FIX, ...bad }), JSON.stringify(bad)).toBeNull()
    }
  })

  it('stamps the time of the fix, or the clock when the browser gave none, in whole seconds', () => {
    expect(locationAnswer('precise', 'precise', { ...FIX, timestamp: 1_791_119_300_999 })?.at).toBe(1_791_119_300)
    expect(Number.isInteger(locationAnswer('precise', 'precise', { ...FIX, timestamp: 0 })?.at)).toBe(true)
  })
})

describe('a contact answer', () => {
  const asked: ContactField[] = ['name', 'phones', 'emails', 'postal', 'birthday', 'organization']
  const picked = {
    name: ['Bram de Vries'],
    tel: ['+31 6 12345678', '+31 20 5551234'],
    email: ['bram@example.com'],
    address: [{ addressLine: ['Keizersgracht 12'], postalCode: '1015 CS', city: 'Amsterdam', country: 'Netherlands' }]
  }
  const params = paramsOf('device.contact', 'req_contact_phone')

  it('offers only what was asked for, cleaned, and cut to the contract’s limits', () => {
    expect(candidateOf(picked, ['name', 'phones'])).toEqual({
      name: 'Bram de Vries',
      phones: ['+31 6 12345678', '+31 20 5551234']
    })
    expect(candidateOf(picked, ['emails'])).toEqual({ emails: ['bram@example.com'] })
    expect(candidateOf(picked, ['postal'])).toEqual({ postal: ['Keizersgracht 12\n1015 CS Amsterdam\nNetherlands'] })
    // The fields a browser cannot read are never there.
    expect(candidateOf(picked, ['birthday', 'organization'])).toEqual({})
  })

  it('cleans what a contact book can hold: hidden characters, blank lines, lists that are too long, entries over a limit', () => {
    const messy = candidateOf(
      {
        name: ['Bram‮ de​ Vries', 'Other'],
        tel: ['+31\u0000 6 1', '   ', ...Array.from({ length: 8 }, (_, index) => `+31 6 ${index}`), 'x'.repeat(41)],
        email: ['a@b.nl', 'a@b.nl', `${'x'.repeat(250)}@example.com`]
      },
      ['name', 'phones', 'emails']
    )

    expect(messy.name).toBe('Bram de Vries')
    expect(messy.phones).toHaveLength(5)
    expect(messy.phones?.[0]).toBe('+31 6 1')
    expect(messy.phones?.every(phone => phone.length <= 40)).toBe(true)
    expect(messy.emails).toEqual(['a@b.nl'])
  })

  it('answers only the fields the person left ticked, in the contract’s order', () => {
    const candidate = candidateOf(picked, asked)
    const all = contactAnswer(asked, candidate, new Set<ContactField>(['name', 'phones', 'emails', 'postal']))
    const some = contactAnswer(['name', 'phones'], candidate, new Set<ContactField>(['phones']))

    expect(all?.contact).toEqual({
      name: 'Bram de Vries',
      phones: ['+31 6 12345678', '+31 20 5551234'],
      emails: ['bram@example.com'],
      postal: ['Keizersgracht 12\n1015 CS Amsterdam\nNetherlands']
    })
    expect(Object.keys(all?.contact ?? {})).toEqual(['name', 'phones', 'emails', 'postal'])
    expect(some).toEqual({ status: 'answered', contact: { phones: ['+31 6 12345678', '+31 20 5551234'] } })
    expect(refusalFor('device.contact', params, some)).toBeNull()
  })

  it('never carries a field the request did not list, even when it is ticked and the contact has it', () => {
    const candidate = candidateOf(picked, asked)
    const answer = contactAnswer(['name', 'phones'], candidate, new Set<ContactField>(asked))

    expect(Object.keys(answer?.contact ?? {})).toEqual(['name', 'phones'])
    expect(refusalFor('device.contact', params, answer)).toBeNull()
  })

  it('has nothing to answer when nothing is ticked or the contact has nothing asked for', () => {
    const candidate = candidateOf(picked, ['name'])

    expect(contactAnswer(['name'], candidate, new Set())).toBeNull()
    expect(contactAnswer(['phones'], candidate, new Set<ContactField>(['phones']))).toBeNull()
    expect(contactAnswer(['name'], {}, new Set<ContactField>(['name']))).toBeNull()
  })
})

describe('a scan answer', () => {
  const any = paramsOf('device.scan', 'req_scan_any')
  const ean = paramsOf('device.scan', 'req_scan_ean')

  it('maps the detector’s names to the contract’s, both ways, for all seven symbologies', () => {
    for (const name of SYMBOLOGIES) {
      expect(symbologyOf(DETECTOR_FORMATS[name])).toBe(name)
    }

    expect(symbologyOf('upc_a')).toBeNull()
    expect(symbologyOf('qr')).toBeNull()
  })

  it('answers what the detector read, as it read it, for a symbology that was asked for', () => {
    const answer = scanAnswer(undefined, { rawValue: 'WIFI:T:WPA;S:Home 5G;P:correct horse;;', format: 'qr_code' })

    expect(answer).toEqual({ status: 'answered', value: 'WIFI:T:WPA;S:Home 5G;P:correct horse;;', symbology: 'qr' })
    expect(refusalFor('device.scan', any, answer)).toBeNull()
    expect(scanAnswer(['ean13', 'ean8'], { rawValue: '4006381333931', format: 'ean_13' })).toEqual({
      status: 'answered',
      value: '4006381333931',
      symbology: 'ean13'
    })
  })

  it('does not answer a symbology that was not asked for, one the contract does not have, or a value it cannot carry', () => {
    const code = { rawValue: 'https://example.com/box', format: 'qr_code' }

    expect(scanAnswer(['ean13', 'ean8'], code)).toBeNull()
    expect(refusalFor('device.scan', ean, { status: 'answered', value: code.rawValue, symbology: 'qr' })).toBe(
      'symbology:not_requested'
    )
    expect(scanAnswer(undefined, { rawValue: '012345678905', format: 'upc_a' })).toBeNull()
    expect(scanAnswer(undefined, { rawValue: '', format: 'qr_code' })).toBeNull()
    expect(scanAnswer(undefined, { rawValue: 'x'.repeat(4_097), format: 'qr_code' })).toBeNull()
    expect(scanAnswer(undefined, { rawValue: 'x'.repeat(4_096), format: 'qr_code' })).not.toBeNull()
  })

  it('leaves the value to the gateway’s cleaning: an invisible-only value is the gateway’s refusal, not a made-up skip', () => {
    const answer = scanAnswer(undefined, { rawValue: '​‮ ​', format: 'qr_code' })

    expect(answer).not.toBeNull()
    expect(refusalFor('device.scan', any, answer)).toBe('scan:empty')
  })
})

describe('a signature answer', () => {
  const params = paramsOf('input.signature', 'req_sig_lease')
  const dir = (params.upload as { dir: string }).dir
  const file = (name: string, mime: string, bytes: number): UploadedFile => ({
    path: flatUploadPath(dir, name),
    name,
    mime,
    bytes,
    sha256: 'a'.repeat(64)
  })

  it('names the two files, when it was signed in whole seconds, and the statement’s fingerprint', () => {
    const answer = signatureAnswer(
      file('signature.png', 'image/png', 18_211),
      file('signature.svg', 'image/svg+xml', 6_412),
      'b'.repeat(64),
      1_791_119_310_999
    )

    expect(answer).toMatchObject({ status: 'answered', signed_at: 1_791_119_310, statement_sha256: 'b'.repeat(64) })
    expect(answer.files.map(entry => entry.name)).toEqual(['signature.png', 'signature.svg'])
    // The fingerprint is checked against the statement; a made-up one is refused with the contract's reason.
    expect(refusalFor('input.signature', params, answer)).toBe('statement:mismatch')
  })

  it('is taken by the gateway with the statement’s real fingerprint', async () => {
    const { statementSha256 } = await import('./signature-export')
    const answer = signatureAnswer(
      file('signature.png', 'image/png', 18_211),
      file('signature.svg', 'image/svg+xml', 6_412),
      await statementSha256(String(params.statement)),
      NOW_MS
    )

    expect(refusalFor('input.signature', params, answer)).toBeNull()
  })
})
