/**
 * What the gateway makes of a signature's files and of the device requests' answers, pure: the vectors of the fork's
 * `tests/tui_gateway/test_interactive_device.py` that are about the code ported here (rounding, a contact, a scan, the
 * statement hash, the SVG allowlist and its value grammars, the calendar item the agent passes).
 */
import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import {
  birthdayProblem,
  cleanScanValue,
  effectivePrecision,
  precisionProblem,
  presentContact,
  roundHalfEven,
  roundLocation,
  statementSha256,
  unrequestedKey
} from './device-requests'
import { calendarItemOf, CalendarItemRefused } from './interactive'
import { pngOrSvgProblem } from './signature-svg'
import { SVG_ACCEPTED, SVG_ATTRIBUTE_VECTORS, SVG_REFUSED } from './signature-svg-vectors'

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)
const NS = 'xmlns="http://www.w3.org/2000/svg"'
const isSvg = (text: string | Uint8Array): boolean =>
  pngOrSvgProblem('image/svg+xml', typeof text === 'string' ? bytes(text) : text) === null

describe('a location', () => {
  const fix = (over: Record<string, unknown> = {}) => ({
    status: 'answered',
    lat: 52.3731,
    lon: 4.8922,
    accuracy_m: 35,
    at: 1791119300,
    precision: 'approximate',
    ...over
  })

  it('is rounded to two decimals with at least a kilometre of accuracy when approximate, whatever was sent', () => {
    expect(roundLocation(fix(), 'approximate')).toEqual({
      lat: 52.37,
      lon: 4.89,
      accuracy_m: 1000,
      at: 1791119300,
      precision: 'approximate'
    })
    expect(roundLocation(fix({ accuracy_m: 2500.55 }), 'approximate').accuracy_m).toBe(2500.6)
    expect(roundLocation(fix({ accuracy_m: 0 }), 'approximate').accuracy_m).toBe(1000)
  })

  it('never leaves a negative zero, and rounds ties to even as Python does', () => {
    const at = (lat: number, lon: number) => {
      const out = roundLocation(fix({ lat, lon }), 'approximate')

      return [out.lat, out.lon]
    }

    expect(at(52.3749, 4.8851)).toEqual([52.37, 4.89])
    expect(at(-33.8688, 151.2093)).toEqual([-33.87, 151.21])
    expect(at(89.999, -179.999)).toEqual([90, -180])

    for (const [lat, lon] of [at(0.004, -0.004), at(-0, 0)]) {
      expect(Object.is(lat, 0) && Object.is(lon, 0)).toBe(true)
    }

    // Exact binary ties: Python's round() takes the even neighbour, toFixed() the larger.
    expect(roundHalfEven(0.125, 2)).toBe(0.12)
    expect(roundHalfEven(0.375, 2)).toBe(0.38)
    expect(roundHalfEven(-0.125, 2)).toBe(-0.12)
    expect(roundHalfEven(52.375, 2)).toBe(52.38)
    expect(roundHalfEven(2.5, 0)).toBe(2)
    expect(roundHalfEven(1.005, 2)).toBe(1)
    expect(roundHalfEven(2.675, 2)).toBe(2.67)
  })

  it('keeps six decimals and one of accuracy when precise', () => {
    expect(
      roundLocation(
        fix({ lat: 52.37312345678, lon: 4.89220099999, accuracy_m: 8.4999, precision: 'precise' }),
        'precise'
      )
    ).toEqual({ lat: 52.373123, lon: 4.892201, accuracy_m: 8.5, at: 1791119300, precision: 'precise' })
  })

  it('is treated as what was asked when the client shared more', () => {
    const out = roundLocation(
      fix({ lat: 52.373123, lon: 4.892201, accuracy_m: 5, precision: 'precise' }),
      'approximate'
    )

    expect(out).toMatchObject({ precision: 'approximate', lat: 52.37, lon: 4.89, accuracy_m: 1000 })
    expect(effectivePrecision('precise', 'approximate')).toBe('approximate')
    expect(effectivePrecision('precise', 'precise')).toBe('precise')
    expect(precisionProblem('approximate', 'precise')).toBe('precision:too_precise')
    expect(precisionProblem('precise', 'approximate')).toBeNull()
    expect(precisionProblem('approximate', 'approximate')).toBeNull()
  })
})

describe('a contact', () => {
  it('is cut to the requested keys in a fixed order and cleaned', () => {
    const out = presentContact(
      {
        organization: 'Acme\u202e BV',
        phones: ['+31 6 1234\u200b5678', '  ', '+31 20 555'],
        name: 'Bram\u0000 de   Vries',
        emails: ['b@x.nl'],
        birthday: '--02-29'
      },
      ['name', 'phones', 'birthday', 'organization']
    )

    expect(Object.keys(out)).toEqual(['name', 'phones', 'birthday', 'organization'])
    expect(out).toEqual({
      name: 'Bram de Vries',
      phones: ['+31 6 12345678', '+31 20 555'],
      birthday: '--02-29',
      organization: 'Acme BV'
    })
  })

  it('keeps a postal address’s line breaks, leaves empty values out and caps the lists', () => {
    expect(
      presentContact({ postal: ['Keizersgracht 12\n\n\n1015 CS  Amsterdam', '\u200b'], name: '\u200b', phones: [] }, [
        'name',
        'phones',
        'postal'
      ])
    ).toEqual({ postal: ['Keizersgracht 12\n\n1015 CS Amsterdam'] })
    expect(
      presentContact({ phones: Array.from({ length: 9 }, (_, n) => String(n)), postal: ['a', 'a', 'a', 'a', 'a'] }, [
        'phones',
        'postal'
      ])
    ).toEqual({ phones: ['0', '1', '2', '3', '4'], postal: ['a', 'a', 'a'] })
  })

  it('names the first key that was not asked for, whatever its value', () => {
    const asked = ['name', 'phones']

    expect(unrequestedKey({ name: 'x', phones: ['1'] }, asked)).toBeNull()
    expect(unrequestedKey({ name: 'x', emails: ['e'], birthday: '--01-01' }, asked)).toBe('emails')
    expect(unrequestedKey({ name: 'x', birthday: null }, asked)).toBe('birthday')
    expect(unrequestedKey({}, asked)).toBeNull()
  })

  it.each([
    ['1984-03-17', true],
    ['--02-29', true],
    ['2024-02-29', true],
    ['2026-02-29', false],
    ['2026-02-30', false],
    ['--02-30', false],
    ['--04-31', false],
    ['0000-01-01', false],
    ['1984-13-01', false]
  ])('takes a birthday only when it is a day that exists: %s', (value, ok) => {
    expect(birthdayProblem(value) === null).toBe(ok)
  })
})

describe('a scanned value', () => {
  it.each([
    ['WIFI:T:WPA;S:my  net;P:pass word;;', 'WIFI:T:WPA;S:my  net;P:pass word;;'],
    ['https://exa\u200bmple.com/\u202etxt.exe', 'https://example.com/txt.exe'],
    ['a\u001b[31mred\u0007', 'a[31mred'],
    ['a\tb\u00a0c\u3000d', 'a b c d'],
    ['a\r\nb\rc\u2028d\u2029e\u000bf', 'a\nb\nc\nd\nef'],
    ['a\u2066b\u2069', 'ab'],
    ['a\ufeffb', 'ab'],
    ['a\u{e0041}b', 'ab'],
    ['a\u3164b', 'ab'],
    ['a\ue000b', 'ab'],
    [`e${'\u0301'.repeat(6)}`, `e${'\u0301'.repeat(4)}`],
    ['  padded  ', '  padded  '],
    ['', ''],
    [null, '']
  ])('is cleaned without being trimmed or collapsed: %j', (raw, want) => {
    expect(cleanScanValue(raw)).toBe(want)
    expect(cleanScanValue(cleanScanValue(raw))).toBe(want)
  })

  it('cleans a value of nothing visible to nothing but spaces', () => {
    expect(cleanScanValue('\u200b\u202e\u0000').trim()).toBe('')
  })
})

describe('the statement hash', () => {
  it('is the SHA-256 of the exact UTF-8 bytes, with no normalisation', () => {
    expect(statementSha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')

    const text = 'Gelezen en akkoord — café ✓'

    expect(statementSha256(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(new Set([statementSha256('a'), statementSha256('a\n'), statementSha256('a ')]).size).toBe(3)
    expect(statementSha256('\u00e9')).not.toBe(statementSha256('e\u0301'))
  })
})

describe('the two files of a signature', () => {
  it('takes a PNG by its signature and nothing else as a PNG', () => {
    const png = (head: number[]) => pngOrSvgProblem('image/png', Uint8Array.from(head))
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

    expect(png([...signature, 1, 2, 3])).toBeNull()
    expect(png([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a])).toBe('type')
    expect(png([...bytes('GIF89a')])).toBe('type')
    expect(png([])).toBe('type')
    expect(pngOrSvgProblem('image/jpeg', Uint8Array.from([0xff, 0xd8, 0xff]))).toBe('type')
  })

  const accepted = SVG_ACCEPTED
  const refused = SVG_REFUSED

  it.each(accepted)('takes %s', (_name, text) => {
    expect(isSvg(text)).toBe(true)
  })

  it.each(refused)('refuses %s', (_name, text) => {
    expect(isSvg(text)).toBe(false)
  })

  // Every attribute value must match its grammar: a value is accepted by what it IS, never by what it lacks.
  it.each(SVG_ATTRIBUTE_VECTORS)('reads %s="%s" as %s', (attr, value, ok) => {
    expect(isSvg(`<svg ${NS}><path ${attr}="${value}"/></svg>`)).toBe(ok)
  })

  it('reads a megabyte of anything in linear time', () => {
    const blobs = [
      `${'<!---->'.repeat(150_000)}x`,
      '<use '.repeat(200_000),
      ` on${'a'.repeat(1_000_000)}`,
      '<!--'.repeat(250_000),
      `<svg ${'onx '.repeat(250_000)}`,
      `${' '.repeat(1_000_000)}<svg>`,
      `<svg ${NS}><path d="${'M0 0 '.repeat(80_000)}X"/></svg>`,
      `<svg ${NS}><path transform="scale(${'1 '.repeat(200_000)}x)"/></svg>`,
      `<svg ${NS}><path stroke="rgb(${'1,'.repeat(200_000)})"/></svg>`
    ]
    const started = Date.now()

    for (const blob of blobs) {
      isSvg(blob)
    }

    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('the calendar item the agent passes', () => {
  const ITEM = { title: 'Dentist', start: '2026-10-12T09:30+02:00', end: '2026-10-12T10:00+02:00' }
  const refusal = (item: unknown): string => {
    try {
      calendarItemOf(item)
    } catch (error) {
      expect(error).toBeInstanceOf(CalendarItemRefused)

      return (error as Error).message
    }

    return ''
  }

  it('is cleaned and holds only what was given', () => {
    expect(calendarItemOf(ITEM)).toEqual(ITEM)

    const out = calendarItemOf({
      ...ITEM,
      title: 'Den\u202e tist\n2',
      notes: 'Bring  it\n\n\n\nnow\u200b',
      location: 'Room\n4',
      all_day: false,
      url: 'https://example.com/a',
      alarm_minutes: 15
    })

    expect(out).toMatchObject({
      title: 'Den tist 2',
      notes: 'Bring it\n\nnow',
      location: 'Room 4',
      alarm_minutes: 15,
      url: 'https://example.com/a'
    })
    expect(out).not.toHaveProperty('all_day')
    expect(calendarItemOf({ title: 'Only a title' })).toEqual({ title: 'Only a title' })
  })

  it.each([
    ['Dentist', 'item must be an object'],
    [[], 'item must be an object'],
    [null, 'item must be an object'],
    [{}, 'item.title is required'],
    [{ title: '\u200b' }, 'item.title is required'],
    [{ title: 5 }, 'must be a string'],
    [{ title: 'x'.repeat(121) }, 'item.title is 121 characters; the limit is 120'],
    [{ title: 'x', notes: 'n'.repeat(2001) }, 'item.notes is 2001 characters; the limit is 2000'],
    [{ title: 'x', location: 'l'.repeat(201) }, 'item.location is 201 characters; the limit is 200'],
    [{ title: 'x', attendees: ['a'] }, "keys that are not part of a calendar item: 'attendees'"],
    [{ title: 'x', all_day: 'yes' }, 'item.all_day must be true or false'],
    [{ title: 'x', alarm_minutes: true }, 'item.alarm_minutes must be a whole number'],
    [{ title: 'x', alarm_minutes: 1.5 }, 'item.alarm_minutes must be a whole number'],
    [{ title: 'x', start: 5 }, 'item.start must be a string'],
    [{ title: 'x', start: '2026-10-12T09:30' }, 'item: start'],
    [{ title: 'x', start: '2026-10-12' }, 'a timed item takes instants'],
    [{ title: 'x', all_day: true, start: '2026-10-12T09:30+02:00' }, 'an all-day item takes dates'],
    [{ title: 'x', end: '2026-10-12T09:30+02:00' }, 'end needs start'],
    [{ ...ITEM, end: '2026-10-12T09:00+02:00' }, 'end is before start'],
    [{ title: 'x', alarm_minutes: 5 }, 'alarm_minutes needs start'],
    [{ title: 'x', url: 'javascript:alert(1)' }, 'item: url'],
    [{ title: 'x', url: 'https://a b' }, 'item: url'],
    [{ title: 'x', all_day: true, start: '2026-02-30' }, 'item']
  ])('is refused with what to fix: %j', (item, message) => {
    expect(refusal(item)).toContain(message)
  })

  it('never echoes the agent’s value in the refusal', () => {
    expect(refusal({ title: 'x', url: 'https://bank.nl@evil.example/secret-marker' })).not.toMatch(/bank|marker/)
    expect(refusal({ title: 'x', start: 'secret-marker' })).not.toContain('marker')
  })

  it.each([
    ['https://example.com/a', true],
    ['http://example.com/a@b', true],
    ['https://example.com?mail=a@b.nl', true],
    ['https://bank.nl@evil.example/login', false],
    ['https://user:pw@host/', false],
    ['https://@host/', false],
    ['https://evil.example\\@bank.nl/', false],
    ['https://evil.example\\.bank.nl/', false],
    ['https://example.com/a\\b', true],
    ['https://example.com/\u202etxt.exe', false],
    ['https://exa\u200bmple.com/', false],
    ['https://\u2066example.com/', false],
    ['https://example.com/\ue000', false],
    ['https://example.com/\u00ad', false],
    ['https://example.com/\ufeff', false],
    ['https://example.com/\u3164', false],
    ['https://example.com/\u{e0041}', false],
    ['https://example.com/\u0378', false],
    ['https://example.com/a b', false],
    ['javascript:alert(1)', false],
    ['ftp://example.com/', false]
  ])('shows a url without user information or a hidden character only: %j', (url, ok) => {
    expect(refusal({ title: 'x', url }) === '').toBe(ok)
  })
})
