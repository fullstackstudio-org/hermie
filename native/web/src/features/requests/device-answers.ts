/**
 * What the device sheets answer with, composed from what the browser gave them: pure functions that take the browser's
 * own shapes (a position, a picked contact, a detected code) and return the contract's answer
 * (`contract/requests/README.md` sections 8 to 12), or `null` where there is nothing that could be sent.
 *
 * Data minimisation is here, not in a sheet's handlers (consent D10): a location is rounded to what its precision
 * says before it leaves the page, whatever the browser reported; a contact carries only the fields the person ticked
 * and nothing the request did not ask for; a code is sent as the detector read it and nothing else of the frame. The
 * gateway rounds, cleans and refuses again; a page MUST NOT depend on that.
 */
import {
  CONTACT_FIELDS,
  type ContactAnswer,
  type ContactField,
  type ContactValue,
  type LocationAnswer,
  type LocationPrecision,
  type ScanAnswer,
  type SignatureAnswer,
  type Symbology,
  SYMBOLOGIES,
  type UploadedFile,
  LIMITS
} from '../../core/requests/interactive-types'
import { displayText } from '../../core/requests/secure-input'

const lengthOf = (text: string): number => Array.from(text).length

// ── device.location ──────────────────────────────────────────────────────────────────────────────

/** What a browser's `GeolocationPosition` carries that is used. */
export interface Fix {
  latitude: number
  longitude: number
  /** Metres. */
  accuracy: number
  /** Epoch milliseconds. */
  timestamp: number
}

/** A rounding of `value` to `decimals` places, half away from zero, without a `-0`. */
const roundTo = (value: number, decimals: number): number => {
  const scale = 10 ** decimals
  const rounded = Math.round(Math.abs(value) * scale) / scale

  return value < 0 && rounded !== 0 ? -rounded : rounded
}

/** The contract's bounds: where the gateway rounds (two decimals approximate, six precise), and how little it will say. */
export const APPROXIMATE = Object.freeze({ decimals: 2, minAccuracy: 1_000 })
export const PRECISE_DECIMALS = 6
const MAX_ACCURACY = 10_000_000

/**
 * A location answer at `shared` precision, never more precise than `asked` (the person may share less, never more):
 * approximate rounds latitude and longitude to two decimals (about 1.1 km of latitude) and says no better than 1,000 m;
 * precise keeps six. `null` for a fix the contract could not carry (not a number, outside the globe).
 */
export function locationAnswer(
  asked: LocationPrecision,
  chosen: LocationPrecision,
  fix: Fix
): Extract<LocationAnswer, { status: 'answered' }> | null {
  const precision: LocationPrecision = asked === 'approximate' || chosen === 'approximate' ? 'approximate' : 'precise'
  const approximate = precision === 'approximate'
  const decimals = approximate ? APPROXIMATE.decimals : PRECISE_DECIMALS
  const lat = roundTo(fix.latitude, decimals)
  const lon = roundTo(fix.longitude, decimals)
  const reported = Number.isFinite(fix.accuracy) && fix.accuracy >= 0 ? fix.accuracy : null
  const timestamp = Number.isFinite(fix.timestamp) && fix.timestamp > 0 ? fix.timestamp : Date.now()

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180 ||
    reported === null
  ) {
    return null
  }

  const accuracy = Math.min(MAX_ACCURACY, approximate ? Math.max(reported, APPROXIMATE.minAccuracy) : reported)

  return {
    status: 'answered',
    lat,
    lon,
    accuracy_m: Math.round(accuracy * 10) / 10,
    at: Math.floor(timestamp / 1000),
    precision
  }
}

// ── device.contact ───────────────────────────────────────────────────────────────────────────────

/** What the Contact Picker returns for the properties asked (`ContactInfo`): each key an array when it was asked for. */
export interface PickedContact {
  name?: readonly string[]
  tel?: readonly string[]
  email?: readonly string[]
  address?: readonly PickedAddress[]
}

/** The picker's `ContactAddress`, the parts that make a postal address. */
export interface PickedAddress {
  addressLine?: readonly string[]
  dependentLocality?: string
  postalCode?: string
  city?: string
  region?: string
  country?: string
  organization?: string
  recipient?: string
}

/** The Contact Picker's property for each of the contract's fields, for the ones a browser can read at all. */
export const PICKER_PROPERTIES: Readonly<Partial<Record<ContactField, 'name' | 'tel' | 'email' | 'address'>>> = {
  name: 'name',
  phones: 'tel',
  emails: 'email',
  postal: 'address'
}

/** What a contact has, field by field, cleaned and cut to the contract's limits: only a field with something in it. */
export type ContactCandidate = Partial<{
  name: string
  phones: string[]
  emails: string[]
  postal: string[]
}>

const CONTACT_LIMITS = Object.freeze({
  name: 200,
  phones: 5,
  phone: 40,
  emails: 5,
  email: 254,
  postals: 3,
  postal: 300
})

/** One line, cleaned, or `null` when nothing visible is left or it is over `max` code points (cut text is not that text). */
function oneLine(raw: unknown, max: number): string | null {
  const text = displayText(raw, max + 1).replace(/\n/gu, ' ')

  return text === '' || lengthOf(text) > max ? null : text
}

/** The first `limit` distinct lines of `values`, each one cleaned line within `max`. */
function lines(values: readonly unknown[] | undefined, limit: number, max: number): string[] {
  const out: string[] = []

  for (const value of values ?? []) {
    const line = oneLine(value, max)

    if (line !== null && !out.includes(line) && out.length < limit) {
      out.push(line)
    }
  }

  return out
}

/** An address as lines of text: the street lines, then `postal code city`, the region and the country. */
function postalOf(address: PickedAddress): string | null {
  const street = (address.addressLine ?? []).map(line => displayText(line, CONTACT_LIMITS.postal)).filter(Boolean)
  const town = [address.postalCode, address.city]
    .map(part => displayText(part, 80))
    .filter(Boolean)
    .join(' ')
  const text = displayText(
    [...street, town, displayText(address.region, 80), displayText(address.country, 80)].filter(Boolean).join('\n'),
    CONTACT_LIMITS.postal + 1
  )

  return text === '' || lengthOf(text) > CONTACT_LIMITS.postal ? null : text
}

/** What a picked contact has to share, of the fields the request asked for and the browser can read. */
export function candidateOf(picked: PickedContact, asked: readonly ContactField[]): ContactCandidate {
  const out: ContactCandidate = {}
  const name = asked.includes('name') ? lines(picked.name, 1, CONTACT_LIMITS.name)[0] : undefined
  const phones = asked.includes('phones') ? lines(picked.tel, CONTACT_LIMITS.phones, CONTACT_LIMITS.phone) : []
  const emails = asked.includes('emails') ? lines(picked.email, CONTACT_LIMITS.emails, CONTACT_LIMITS.email) : []
  const postal = asked.includes('postal')
    ? [...new Set((picked.address ?? []).map(postalOf).filter((text): text is string => text !== null))].slice(
        0,
        CONTACT_LIMITS.postals
      )
    : []

  if (name !== undefined) {
    out.name = name
  }

  if (phones.length > 0) {
    out.phones = phones
  }

  if (emails.length > 0) {
    out.emails = emails
  }

  if (postal.length > 0) {
    out.postal = postal
  }

  return out
}

/**
 * The contact answer: ONLY the fields the person left ticked, in the contract's order, and only fields that were asked
 * for and that the contact has. `null` when nothing is left (the person skips instead).
 */
export function contactAnswer(
  asked: readonly ContactField[],
  candidate: ContactCandidate,
  ticked: ReadonlySet<ContactField>
): Extract<ContactAnswer, { status: 'answered' }> | null {
  const contact: { -readonly [K in keyof ContactValue]: ContactValue[K] } = {}

  for (const field of CONTACT_FIELDS) {
    if (!asked.includes(field) || !ticked.has(field)) {
      continue
    }

    if (field === 'name' && candidate.name !== undefined) {
      contact.name = candidate.name
    } else if (field === 'phones' && candidate.phones) {
      contact.phones = candidate.phones
    } else if (field === 'emails' && candidate.emails) {
      contact.emails = candidate.emails
    } else if (field === 'postal' && candidate.postal) {
      contact.postal = candidate.postal
    }
  }

  return Object.keys(contact).length === 0 ? null : { status: 'answered', contact }
}

// ── device.scan ──────────────────────────────────────────────────────────────────────────────────

/** `BarcodeDetector`'s format names for the contract's symbologies. */
export const DETECTOR_FORMATS: Readonly<Record<Symbology, string>> = {
  qr: 'qr_code',
  ean13: 'ean_13',
  ean8: 'ean_8',
  code128: 'code_128',
  pdf417: 'pdf417',
  datamatrix: 'data_matrix',
  aztec: 'aztec'
}

/** The contract's symbology for a detector's format name, or `null` for one the contract does not have. */
export const symbologyOf = (format: string): Symbology | null =>
  SYMBOLOGIES.find(name => DETECTOR_FORMATS[name] === format) ?? null

/**
 * The code a detector read, as an answer, when it is one of the symbologies asked for (any of the seven when the request
 * names none) and a value the contract carries (1 to 4,096 code points). The value is the detector's text as it is: the
 * gateway cleans it, and the sheet shows it with what the eye cannot see marked, before it is sent.
 */
export function scanAnswer(
  asked: readonly Symbology[] | undefined,
  detected: { rawValue: string; format: string }
): Extract<ScanAnswer, { status: 'answered' }> | null {
  const symbology = symbologyOf(detected.format)
  const value = detected.rawValue

  if (
    symbology === null ||
    (asked !== undefined && !asked.includes(symbology)) ||
    typeof value !== 'string' ||
    value === '' ||
    lengthOf(value) > LIMITS.scanValue
  ) {
    return null
  }

  return { status: 'answered', value, symbology }
}

// ── input.signature ──────────────────────────────────────────────────────────────────────────────

/**
 * The signature answer: the PNG and the SVG by reference, when it was signed (the client's clock, Unix seconds) and the
 * SHA-256 of the statement the person saw. The two files in the order the contract's example has them.
 */
export function signatureAnswer(
  png: UploadedFile,
  svg: UploadedFile,
  statementHash: string,
  signedAtMs: number
): Extract<SignatureAnswer, { status: 'answered' }> {
  return {
    status: 'answered',
    files: [png, svg],
    signed_at: Math.floor(signedAtMs / 1000),
    statement_sha256: statementHash
  }
}
