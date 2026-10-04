/**
 * The sheets that reach for the device, in the request layer over the real interactive model and a hand-driven
 * connection, with the browser's own APIs (geolocation, the contact picker, a barcode detector, a camera, a recorder)
 * stood in for by what the test hands them: the answer each sheet gives, what it never does without a press, what it
 * leaves out, and how each failure ends. The real APIs (permission prompts, a real canvas, a real recorder) are a
 * browser's: `e2e/requests-device.spec.ts` runs the sheets in Chromium and WebKit against the fake gateway.
 */
import { refusalFor } from '@hermie/fake-gateway'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { REFUSED_CODE } from '../../core/requests/interactive'
import { bytesOf } from '../../core/requests/sha256'
import { requestLaterStore } from '../../state/request-later'
import { interactiveKey } from '../../state/requests'
import {
  button,
  contactFrame,
  dialog,
  type Harness,
  lastAnswer,
  locationFrame,
  mount,
  queryButton,
  raise,
  scanFrame,
  setup,
  signatureFrame,
  teardown,
  type UploadCall,
  voiceFrame
} from '../../test-support/interactive-layer'
import { pngChunkTypes, pngOf } from '../../test-support/png'
import { preloadRequestSheets } from './request-sheets'
import { statementSha256 } from './signature-export'

beforeAll(async () => {
  await preloadRequestSheets()
})

let harness: Harness
/** The properties a test put on `navigator`, taken off again. */
const stubbed: string[] = []

beforeEach(() => {
  harness = setup()
})

afterEach(() => {
  teardown(harness)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()

  for (const name of stubbed.splice(0)) {
    delete (navigator as unknown as Record<string, unknown>)[name]
  }
})

/** Give `navigator` what a browser would (jsdom has none of it). */
function onNavigator(props: Record<string, unknown>): void {
  for (const [name, value] of Object.entries(props)) {
    Object.defineProperty(navigator, name, { value, configurable: true })
    stubbed.push(name)
  }
}

/** Wait for the device chunk, which is fetched when the first request for the device is on the page. */
const sheetNamed = (name: string): Promise<HTMLElement> => screen.findByRole('dialog', { name })

/** Press a button and let the promises settle. */
const press = async (name: string | RegExp): Promise<void> => {
  await act(async () => {
    fireEvent.click(button(name))
  })
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  })
}

const settle = (): Promise<void> =>
  act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 20))
  })

const declinedWith = (): unknown[] => harness.gw.declined.map(entry => entry.reason)

const NOW_MS = 1_791_119_300_000

/** A geolocation that answers each call with `behave`, and remembers what it was asked. */
function geolocation(
  behave: (
    ok: (position: GeolocationPosition) => void,
    fail: (error: { code: number }) => void,
    options: PositionOptions
  ) => void
) {
  return { getCurrentPosition: vi.fn(behave) }
}

const fix = (latitude: number, longitude: number, accuracy: number) => (ok: (position: GeolocationPosition) => void) =>
  ok({ coords: { latitude, longitude, accuracy }, timestamp: NOW_MS } as GeolocationPosition)

describe('a location', () => {
  it('asks the browser only after Share, for a fix without high accuracy when the bot asked for an approximate one', async () => {
    const place = geolocation(fix(52.373123, 4.892201, 8.5))

    onNavigator({ geolocation: place })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame({ precision: 'approximate' }))
    await sheetNamed('Your location, once')

    // Nothing is asked of the browser by opening the sheet, and it offers nothing more exact than was asked.
    expect(place.getCurrentPosition).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('The bot asked for your approximate location only.')
    expect(dialog().querySelector('[data-precision="precise"]')).toBeNull()
    expect(dialog().textContent).toContain('Hermie asks your browser for where you are, once')

    await press('Share location')

    expect(place.getCurrentPosition).toHaveBeenCalledTimes(1)
    expect(place.getCurrentPosition.mock.calls[0]?.[2]).toMatchObject({ enableHighAccuracy: false, maximumAge: 0 })
    // Rounded on the page before it leaves, whatever the browser reported.
    expect(lastAnswer(harness)).toEqual({
      status: 'answered',
      lat: 52.37,
      lon: 4.89,
      accuracy_m: 1000,
      at: 1_791_119_300,
      precision: 'approximate'
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shares a precise fix as it is, and the person can lower it first: then it is asked for and rounded as approximate', async () => {
    const place = geolocation(fix(52.373123, 4.892201, 8.46))

    onNavigator({ geolocation: place })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame({ precision: 'precise' }))
    await sheetNamed('Your location, once')

    expect((dialog().querySelector('[data-precision="precise"]') as HTMLInputElement).checked).toBe(true)

    await press('Share location')

    expect(place.getCurrentPosition.mock.calls[0]?.[2]).toMatchObject({ enableHighAccuracy: true })
    expect(lastAnswer(harness)).toMatchObject({ lat: 52.373123, lon: 4.892201, accuracy_m: 8.5, precision: 'precise' })

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'device.location', locationFrame({ precision: 'precise' }))
    await sheetNamed('Your location, once')
    fireEvent.click(dialog().querySelector('[data-precision="approximate"]') as HTMLElement)
    await press('Share location')

    expect(place.getCurrentPosition.mock.calls[1]?.[2]).toMatchObject({ enableHighAccuracy: false })
    expect(lastAnswer(harness)).toMatchObject({ lat: 52.37, lon: 4.89, precision: 'approximate' })
  })

  it('is what the gateway takes, for every precision the person can end up sharing', async () => {
    const place = geolocation(fix(-33.8688, 151.2093, 35))

    onNavigator({ geolocation: place })
    mount(harness)

    for (const [index, precision] of (['approximate', 'precise'] as const).entries()) {
      raise(harness, `srq-${index}`, 'device.location', locationFrame({ precision }))
      await sheetNamed('Your location, once')
      await press('Share location')

      expect(refusalFor('device.location', { precision } as never, lastAnswer(harness))).toBeNull()
    }
  })

  it('tells the bot when the browser says no, which is an answer of its own and not a skip', async () => {
    onNavigator({ geolocation: geolocation((_ok, fail) => fail({ code: 1 })) })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame())
    await sheetNamed('Your location, once')
    await press('Share location')

    expect(declinedWith()).toEqual(['permission_denied'])
    expect(harness.gw.calls.filter(call => call.method === 'request.answer')).toEqual([])
  })

  it('says a fix that could not be had, and lets the person try again or give up', async () => {
    let tries = 0
    const place = geolocation((ok, fail) => (++tries === 1 ? fail({ code: 3 }) : fix(1, 2, 3)(ok)))

    onNavigator({ geolocation: place })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame())
    await sheetNamed('Your location, once')
    await press('Share location')

    expect(within(dialog()).getByRole('alert').textContent).toContain('could not be found')
    expect(declinedWith()).toEqual([])

    await press('Try again')

    expect(place.getCurrentPosition).toHaveBeenCalledTimes(2)
    expect(lastAnswer(harness)).toMatchObject({ status: 'answered', precision: 'approximate' })
  })

  it('gives up with its own reason', async () => {
    onNavigator({ geolocation: geolocation((_ok, fail) => fail({ code: 2 })) })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame())
    await sheetNamed('Your location, once')
    await press('Share location')
    await press('Give up')

    expect(declinedWith()).toEqual(['location_unavailable'])
  })

  it('does not use a fix that arrives after the sheet went', async () => {
    let deliver: () => void = () => undefined
    const place = geolocation(ok => {
      deliver = () => fix(1, 2, 3)(ok)
    })

    onNavigator({ geolocation: place })
    const view = mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame())
    await sheetNamed('Your location, once')
    await press('Share location')
    view.unmount()
    deliver()
    await settle()

    expect(harness.gw.calls.filter(call => call.method === 'request.answer')).toEqual([])
  })

  it('does not use a fix that arrives after the sheet was put away, and Share looks again when it is back', async () => {
    const deliveries: (() => void)[] = []
    const place = geolocation(ok => {
      deliveries.push(() => fix(1, 2, 3)(ok))
    })

    onNavigator({ geolocation: place })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame())
    await sheetNamed('Your location, once')
    await press('Share location')
    await press('Later')
    deliveries[0]?.()
    await settle()

    expect(harness.gw.calls.filter(call => call.method === 'request.answer')).toEqual([])

    bringBack('srq-1')
    await press('Share location')

    expect(place.getCurrentPosition).toHaveBeenCalledTimes(2)

    deliveries[1]?.()
    await settle()

    expect(lastAnswer(harness)).toMatchObject({ status: 'answered' })
  })

  it('keeps Don’t share on while the browser is looking, and ends the lookup: a fix that comes later is not sent', async () => {
    let deliver: () => void = () => undefined
    const place = geolocation(ok => {
      deliver = () => fix(1, 2, 3)(ok)
    })

    onNavigator({ geolocation: place })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame())
    await sheetNamed('Your location, once')
    await press('Share location')

    // Looking: Share is off, Don't share is not.
    expect((button('Share location') as HTMLButtonElement).disabled).toBe(true)
    expect((button("Don't share") as HTMLButtonElement).disabled).toBe(false)

    await press("Don't share")

    expect(declinedWith()).toEqual(['declined'])

    deliver()
    await settle()

    expect(harness.gw.calls.filter(call => call.method === 'request.answer')).toEqual([])
  })

  it('offers Skip when the request is optional and Don’t share always, and neither is an answer from a stray press', async () => {
    onNavigator({ geolocation: geolocation(fix(1, 2, 3)) })
    mount(harness)
    raise(harness, 'srq-1', 'device.location', locationFrame({ optional: false }))
    await sheetNamed('Your location, once')

    expect(queryButton('Skip')).toBeNull()

    await press("Don't share")

    expect(declinedWith()).toEqual(['declined'])

    act(() => harness.gw.cancel('srq-1', 'interrupted'))
    raise(harness, 'srq-2', 'device.location', locationFrame({ optional: true }))
    await sheetNamed('Your location, once')
    await press('Skip')

    expect(lastAnswer(harness)).toEqual({ status: 'skipped' })
  })
})

/** What the picker hands back for Bram, who has everything. */
const BRAM = {
  name: ['Bram de Vries'],
  tel: ['+31 6 12345678', '+31 20 5551234'],
  email: ['bram@example.com'],
  address: [{ addressLine: ['Keizersgracht 12'], postalCode: '1015 CS', city: 'Amsterdam', country: 'Netherlands' }]
}

function contacts(behave: () => Promise<unknown[]> = async () => [BRAM]) {
  return {
    select: vi.fn(async (_properties: string[], _options?: unknown) => behave()),
    getProperties: vi.fn(async () => ['name', 'tel', 'email', 'address', 'icon'])
  }
}

describe('a contact', () => {
  it('opens the picker only for the properties the request asked for, on a press', async () => {
    const picker = contacts()

    onNavigator({ contacts: picker })
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame({ fields: ['name', 'phones'] }))
    await sheetNamed('A contact to share')
    await settle()

    expect(picker.select).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('The bot asks for: name and phone numbers.')

    await press('Choose a contact')

    expect(picker.select).toHaveBeenCalledTimes(1)
    expect(picker.select.mock.calls[0]?.[0]).toEqual(['name', 'tel'])
    expect(picker.select.mock.calls[0]?.[1]).toEqual({ multiple: false })
  })

  it('shows what the contact has of those fields, all ticked, and sends exactly what stays ticked', async () => {
    onNavigator({ contacts: contacts() })
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame({ fields: ['name', 'phones', 'emails'] }))
    await sheetNamed('A contact to share')
    await settle()
    await press('Choose a contact')

    const boxes = within(dialog()).getAllByRole('checkbox') as HTMLInputElement[]

    expect(boxes.map(box => box.checked)).toEqual([true, true, true])
    expect(dialog().textContent).toContain('Bram de Vries')
    expect(dialog().textContent).toContain('+31 20 5551234')
    expect(dialog().textContent).toContain('bram@example.com')
    // The address was not asked for: it is not even shown.
    expect(dialog().textContent).not.toContain('Keizersgracht')

    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'name' }))
    await press('Send contact')

    expect(lastAnswer(harness)).toEqual({
      status: 'answered',
      contact: { phones: ['+31 6 12345678', '+31 20 5551234'], emails: ['bram@example.com'] }
    })
  })

  it('is what the gateway takes, and sends nothing while nothing is ticked', async () => {
    onNavigator({ contacts: contacts() })
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame({ fields: ['name', 'phones'] }))
    await sheetNamed('A contact to share')
    await settle()
    await press('Choose a contact')
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'name' }))
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'phone numbers' }))

    expect((button('Send contact') as HTMLButtonElement).disabled).toBe(true)
    expect(dialog().textContent).toContain('Tick at least one field to send.')

    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'phone numbers' }))
    await press('Send contact')

    expect(refusalFor('device.contact', { fields: ['name', 'phones'] } as never, lastAnswer(harness))).toBeNull()
  })

  it('says what a browser cannot read, and does not ask the picker for it', async () => {
    const picker = contacts()

    onNavigator({ contacts: picker })
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame({ fields: ['name', 'birthday', 'organization'] }))
    await sheetNamed('A contact to share')
    await settle()

    expect(dialog().textContent).toContain('This browser cannot read: birthday and organisation.')

    await press('Choose a contact')

    expect(picker.select.mock.calls[0]?.[0]).toEqual(['name'])
  })

  it('declines, with its own reason, a request for nothing the browser can read', async () => {
    onNavigator({ contacts: contacts() })
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame({ fields: ['birthday'] }))
    await sheetNamed('A contact to share')
    await settle()

    expect(dialog().textContent).toContain('cannot read any of the fields')
    expect(queryButton('Choose a contact')).toBeNull()

    await press('Tell the bot this is not possible here')

    expect(declinedWith()).toEqual(['not_supported_on_device'])
  })

  it('changes nothing when the picker is dismissed, and says so when it fails', async () => {
    let behave: () => Promise<unknown[]> = async () => []
    const picker = contacts(() => behave())

    onNavigator({ contacts: picker })
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame())
    await sheetNamed('A contact to share')
    await settle()
    await press('Choose a contact')

    expect(within(dialog()).queryAllByRole('checkbox')).toEqual([])
    expect(within(dialog()).queryByRole('alert')).toBeNull()

    behave = async () => Promise.reject(new Error('InvalidStateError'))
    await press('Choose a contact')

    expect(within(dialog()).getByRole('alert').textContent).toContain('could not be read')
  })

  it('says a contact with none of the asked fields, and offers another', async () => {
    onNavigator({ contacts: contacts(async () => [{ name: ['Bram'], tel: [] }]) })
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame({ fields: ['phones'] }))
    await sheetNamed('A contact to share')
    await settle()
    await press('Choose a contact')

    expect(dialog().textContent).toContain('none of the fields the bot asked for')
    expect(button('Choose another contact')).toBeTruthy()
    expect(queryButton('Send contact')).toBeNull()
  })

  it('shows what the gateway refused a contact for, and the gateway’s refusal stays until the person changes it', async () => {
    onNavigator({ contacts: contacts() })
    harness.gw.onCall.handler = () => {
      throw Object.assign(new Error('refused'), { code: REFUSED_CODE, data: { reason: 'contact:empty' } })
    }
    mount(harness)
    raise(harness, 'srq-1', 'device.contact', contactFrame({ fields: ['name'] }))
    await sheetNamed('A contact to share')
    await settle()
    await press('Choose a contact')
    await press('Send contact')

    expect(screen.getByRole('dialog')).toBeTruthy()
  })
})

/** A stream with one track, and the tracks' stops. */
function camera() {
  const stop = vi.fn()
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream

  return { stream, stop, getUserMedia: vi.fn(async (_constraints: unknown) => stream) }
}

/**
 * A camera or microphone whose permission is answered by the test, when it likes: every call is a pending request for
 * a stream of its own, and `arrive` is the person (or the browser) saying yes.
 */
function lateMedia() {
  const asked: { stop: ReturnType<typeof vi.fn>; arrive: () => void }[] = []
  const getUserMedia = vi.fn(
    (_constraints: unknown) =>
      new Promise<MediaStream>(resolve => {
        const stop = vi.fn()
        const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream

        asked.push({ stop, arrive: () => resolve(stream) })
      })
  )

  return { asked, getUserMedia }
}

/** Bring a sheet that was put away (Later) back, as the transcript's Open does. */
const bringBack = (id: string): void => {
  act(() => requestLaterStore.getState().bringBack(interactiveKey(id)))
}

/** A detector class that reads the codes `read` returns, for the formats it supports. */
function detectorClass(
  read: () => { rawValue: string; format: string }[],
  supported = ['qr_code', 'ean_13', 'ean_8', 'code_128', 'pdf417', 'data_matrix', 'aztec']
) {
  const detect = vi.fn(async (_video: unknown) => read())
  const made: { formats?: string[] }[] = []

  class Detector {
    static getSupportedFormats = async (): Promise<string[]> => supported

    constructor(options: { formats?: string[] } = {}) {
      made.push(options)
    }

    detect = detect
  }

  return { Detector, detect, made }
}

/** jsdom has no playing video: say that it is ready, and that playing it works. */
function playableVideo(): void {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(async () => undefined)
  Object.defineProperty(HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true })
}

describe('a code to scan', () => {
  const QR = { rawValue: 'https://example.com/box?id=7', format: 'qr_code' }

  it('starts the camera only after Start, shows what the code says as plain text, and sends it only on a press', async () => {
    const cam = camera()
    const detector = detectorClass(() => [QR])

    playableVideo()
    onNavigator({ mediaDevices: { getUserMedia: cam.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detector.Detector)
    mount(harness)
    raise(harness, 'srq-1', 'device.scan', scanFrame({ formats: ['qr', 'ean13'] }))
    await sheetNamed('A code to scan')
    await settle()

    expect(cam.getUserMedia).not.toHaveBeenCalled()
    expect(dialog().textContent).toContain('The bot is looking for: QR code and EAN-13.')

    await press('Start the camera')

    expect(cam.getUserMedia).toHaveBeenCalledTimes(1)
    expect(cam.getUserMedia.mock.calls[0]?.[0]).toMatchObject({ audio: false })
    // The detector is asked for the symbologies that were asked for, and nothing else.
    expect(detector.made[0]?.formats).toEqual(['qr_code', 'ean_13'])

    await waitFor(() => expect(dialog().querySelector('[data-scan-value]')).not.toBeNull(), { timeout: 3_000 })

    // Shown, never opened: plain text, no link anywhere on the sheet, and the camera is let go the moment it was read.
    expect(dialog().querySelector('[data-scan-value]')?.textContent).toBe('https://example.com/box?id=7')
    expect(dialog().querySelector('a')).toBeNull()
    expect(cam.stop).toHaveBeenCalled()
    expect(harness.gw.calls.filter(call => call.method === 'request.answer')).toEqual([])

    await press('Send this code')

    expect(lastAnswer(harness)).toEqual({ status: 'answered', value: 'https://example.com/box?id=7', symbology: 'qr' })
    expect(refusalFor('device.scan', { formats: ['qr', 'ean13'] } as never, lastAnswer(harness))).toBeNull()
  })

  it('marks what the eye cannot see in a code, before it is sent', async () => {
    const cam = camera()

    playableVideo()
    onNavigator({ mediaDevices: { getUserMedia: cam.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detectorClass(() => [{ rawValue: 'pay‮now​', format: 'qr_code' }]).Detector)
    mount(harness)
    raise(harness, 'srq-1', 'device.scan', scanFrame())
    await sheetNamed('A code to scan')
    await settle()
    await press('Start the camera')
    await waitFor(() => expect(dialog().querySelector('[data-scan-value]')).not.toBeNull(), { timeout: 3_000 })

    expect(dialog().querySelector('[data-scan-value]')?.textContent).toBe('pay[U+202E]now[U+200B]')
  })

  it('scans again from the start, and ignores a code that is not of a symbology asked for', async () => {
    const cam = camera()
    const reads = [
      [{ rawValue: '4006381333931', format: 'ean_13' }],
      [QR],
      [
        { rawValue: 'x', format: 'upc_a' },
        { rawValue: 'WIFI:T:WPA;;', format: 'qr_code' }
      ]
    ]
    const detector = detectorClass(() => reads.shift() ?? [])

    playableVideo()
    onNavigator({ mediaDevices: { getUserMedia: cam.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detector.Detector)
    mount(harness)
    raise(harness, 'srq-1', 'device.scan', scanFrame({ formats: ['qr'] }))
    await sheetNamed('A code to scan')
    await settle()
    await press('Start the camera')
    await waitFor(() => expect(dialog().querySelector('[data-scan-value]')).not.toBeNull(), { timeout: 3_000 })

    // The EAN code was never taken for the answer: the QR code is what stopped the camera.
    expect(dialog().querySelector('[data-scan-value]')?.textContent).toBe('https://example.com/box?id=7')

    await press('Scan again')

    expect(cam.getUserMedia).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(dialog().querySelector('[data-scan-value]')?.textContent).toBe('WIFI:T:WPA;;'), {
      timeout: 3_000
    })
  })

  it('says when the browser reads none of the symbologies asked for, and offers the way to say so', async () => {
    const cam = camera()

    onNavigator({ mediaDevices: { getUserMedia: cam.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detectorClass(() => [], ['qr_code']).Detector)
    mount(harness)
    raise(harness, 'srq-1', 'device.scan', scanFrame({ formats: ['pdf417'] }))
    await sheetNamed('A code to scan')
    await settle()

    expect(dialog().textContent).toContain('cannot read the kinds of code the bot asked for')
    expect(queryButton('Start the camera')).toBeNull()

    await press('Tell the bot this is not possible here')

    expect(declinedWith()).toEqual(['not_supported_on_device'])
    expect(cam.getUserMedia).not.toHaveBeenCalled()
  })

  it.each([
    ['NotAllowedError', 'permission_denied'],
    ['NotFoundError', 'no_camera']
  ])('tells the bot why the camera is not there (%s)', async (name, reason) => {
    onNavigator({
      mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error(name), { name }))) }
    })
    vi.stubGlobal('BarcodeDetector', detectorClass(() => []).Detector)
    mount(harness)
    raise(harness, 'srq-1', 'device.scan', scanFrame())
    await sheetNamed('A code to scan')
    await settle()
    await press('Start the camera')

    expect(declinedWith()).toEqual([reason])
  })

  it('lets go of the camera when the sheet is put away, and when it goes', async () => {
    const cam = camera()

    playableVideo()
    onNavigator({ mediaDevices: { getUserMedia: cam.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detectorClass(() => []).Detector)

    const view = mount(harness)

    raise(harness, 'srq-1', 'device.scan', scanFrame())
    await sheetNamed('A code to scan')
    await settle()
    await press('Start the camera')

    expect(cam.stop).not.toHaveBeenCalled()

    await press('Later')

    expect(cam.stop).toHaveBeenCalledTimes(1)

    // Back again, the camera runs once more; it is let go once more when the sheet goes.
    bringBack('srq-1')
    await press('Start the camera')

    expect(cam.getUserMedia).toHaveBeenCalledTimes(2)
    expect(cam.stop).toHaveBeenCalledTimes(1)

    view.unmount()

    expect(cam.stop).toHaveBeenCalledTimes(2)
  })

  it('stops a camera that arrives after the sheet was put away and Start was pressed again, and keeps only the last', async () => {
    const late = lateMedia()

    playableVideo()
    onNavigator({ mediaDevices: { getUserMedia: late.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detectorClass(() => []).Detector)

    const view = mount(harness)

    raise(harness, 'srq-1', 'device.scan', scanFrame())
    await sheetNamed('A code to scan')
    await settle()
    await press('Start the camera')
    // Later while the camera is still starting, then open it again and press Start once more.
    await press('Later')
    bringBack('srq-1')
    await press('Start the camera')

    expect(late.asked).toHaveLength(2)

    await act(async () => {
      late.asked[0]?.arrive()
      late.asked[1]?.arrive()
    })
    await settle()

    // The first camera is nobody's: stopped as it arrived. The second is the one on screen.
    expect(late.asked[0]?.stop).toHaveBeenCalledTimes(1)
    expect(late.asked[1]?.stop).not.toHaveBeenCalled()
    expect(dialog().querySelector('[data-scan-video]')).not.toBeNull()

    view.unmount()

    expect(late.asked[1]?.stop).toHaveBeenCalledTimes(1)
  })

  it('stops a camera the person allowed only after the sheet was put away', async () => {
    const late = lateMedia()

    onNavigator({ mediaDevices: { getUserMedia: late.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detectorClass(() => []).Detector)
    mount(harness)
    raise(harness, 'srq-1', 'device.scan', scanFrame())
    await sheetNamed('A code to scan')
    await settle()
    await press('Start the camera')
    await press('Later')
    await act(async () => late.asked[0]?.arrive())
    await settle()

    expect(late.asked[0]?.stop).toHaveBeenCalledTimes(1)

    bringBack('srq-1')

    // Nothing is looking: the sheet is back at its start, with no picture.
    expect(dialog().querySelector('[data-scan-video]')).toBeNull()
    expect(button('Start the camera')).toBeTruthy()
  })

  it('stops a camera the person allowed only after the sheet went', async () => {
    const late = lateMedia()

    onNavigator({ mediaDevices: { getUserMedia: late.getUserMedia } })
    vi.stubGlobal('BarcodeDetector', detectorClass(() => []).Detector)

    const view = mount(harness)

    raise(harness, 'srq-1', 'device.scan', scanFrame())
    await sheetNamed('A code to scan')
    await settle()
    await press('Start the camera')
    view.unmount()
    await act(async () => late.asked[0]?.arrive())
    await settle()

    expect(late.asked[0]?.stop).toHaveBeenCalledTimes(1)
  })
})

/** A recorder that records `bytes` of `type` once stopped. */
function recorderClass(options: { supported?: string[]; bytes?: string; type?: string } = {}) {
  const made: { mimeType: string; started: number; stopped: number }[] = []

  class Recorder {
    static isTypeSupported = (type: string): boolean => (options.supported ?? []).includes(type)
    mimeType: string
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    private readonly record: (typeof made)[number]

    constructor(_stream: MediaStream, init?: { mimeType?: string }) {
      this.mimeType = options.type ?? init?.mimeType ?? 'audio/webm;codecs=opus'
      this.record = { mimeType: init?.mimeType ?? '', started: 0, stopped: 0 }
      made.push(this.record)
    }

    start(): void {
      this.record.started += 1
    }

    stop(): void {
      this.record.stopped += 1
      this.ondataavailable?.({ data: new Blob([options.bytes ?? 'voice-bytes'], { type: this.mimeType }) })
      this.onstop?.()
    }
  }

  return { Recorder, made }
}

/** What the layer hands `uploadFileTo`, and what it was asked to keep. */
function uploads() {
  const calls: UploadCall[] = []

  return {
    calls,
    fn: async (path: string, file: UploadCall['file']) => {
      calls.push({ path, file })

      return {}
    }
  }
}

const textOf = (blob: unknown): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader()

    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob as Blob)
  })

describe('a voice note', () => {
  function recordable(recorder: ReturnType<typeof recorderClass>) {
    const cam = camera()

    vi.stubGlobal('MediaRecorder', recorder.Recorder)
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:voice-0', revokeObjectURL: () => undefined })
    )
    onNavigator({ mediaDevices: { getUserMedia: cam.getUserMedia } })

    return cam
  }

  it('is the file sheet where the browser cannot record: an audio file is picked instead', async () => {
    mount(harness)
    raise(harness, 'srq-1', 'input.file', voiceFrame())

    expect(await screen.findByRole('dialog', { name: 'Files to upload' })).toBeTruthy()
    expect(queryButton('Record')).toBeNull()
  })

  it('records only after Record, plays the recording back, and uploads and sends it only on Send, with no transcript', async () => {
    const recorder = recorderClass({ supported: ['audio/mp4', 'audio/webm'], type: 'audio/mp4;codecs=mp4a.40.2' })
    const cam = recordable(recorder)
    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')

    expect(cam.getUserMedia).not.toHaveBeenCalled()
    expect(queryButton('Send recording')).toBeNull()

    await press('Record')

    expect(cam.getUserMedia).toHaveBeenCalledWith({ audio: true })
    // `audio/mp4` is preferred where the browser records it.
    expect(recorder.made[0]?.mimeType).toBe('audio/mp4')

    await press('Stop')

    expect(cam.stop).toHaveBeenCalled()
    expect(dialog().querySelector('[data-voice-player]')?.getAttribute('src')).toBe('blob:voice-0')
    // Nothing was uploaded or answered while the person was still listening.
    expect(up.calls).toEqual([])
    expect(harness.gw.calls.filter(call => call.method === 'request.answer')).toEqual([])

    await press('Send recording')

    expect(up.calls).toHaveLength(1)
    expect(up.calls[0]?.path).toMatch(/^\/home\/ada\/work\/uploads\/hermie\/2026-10-04\/[0-9a-f]{16}-voice-note\.m4a$/u)

    const result = lastAnswer(harness) as { status: string; files: Record<string, unknown>[]; text?: string }

    // The declared type has no parameters, and no transcript was made.
    expect(result.files).toEqual([
      {
        path: up.calls[0]?.path,
        name: 'voice-note.m4a',
        mime: 'audio/mp4',
        bytes: 11,
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/u)
      }
    ])
    expect(result.status).toBe('answered')
    expect('text' in result).toBe(false)
    expect(refusalFor('input.file', voiceFrame() as never, result)).toBeNull()
  })

  it('strips the codecs from the type a browser records in, and names the file for it', async () => {
    recordable(recorderClass({ supported: ['audio/webm;codecs=opus'], type: 'audio/webm;codecs=opus' }))

    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')
    await press('Stop')
    await press('Send recording')

    expect(up.calls[0]?.file).toMatchObject({ name: 'voice-note.webm', mimeType: 'audio/webm' })
    expect(((lastAnswer(harness) as { files: { mime: string }[] }).files[0] as { mime: string }).mime).toBe(
      'audio/webm'
    )
  })

  it('throws the recording away when the person records again', async () => {
    const recorder = recorderClass()

    recordable(recorder)
    mount(harness, { uploadFileTo: uploads().fn })
    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')
    await press('Stop')
    await press('Record again')

    expect(recorder.made).toHaveLength(2)
    expect(queryButton('Send recording')).toBeNull()
  })

  it('does not record or send when the microphone is refused: a file can be chosen instead', async () => {
    onNavigator({
      mediaDevices: {
        getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' })))
      }
    })
    vi.stubGlobal('MediaRecorder', recorderClass().Recorder)
    mount(harness)
    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')

    expect(within(dialog()).getByRole('alert').textContent).toContain('choose an audio file instead')
    // Not a decline: the bot is not told the phone has no microphone when a file could be picked.
    expect(declinedWith()).toEqual([])

    await press('Choose an audio file instead')

    expect(screen.getByRole('dialog', { name: 'Files to upload' })).toBeTruthy()
  })

  it('stops by itself at the size the gateway takes, and says so', async () => {
    const recorder = recorderClass({ bytes: 'x'.repeat(2_000) })

    recordable(recorder)
    mount(harness, { uploadFileTo: uploads().fn })
    raise(
      harness,
      'srq-1',
      'input.file',
      voiceFrame({ upload: { dir: '/up', max_bytes: 2_000, max_total_bytes: 2_000, max_files: 1 } })
    )
    await sheetNamed('A voice note to record')
    await press('Record')
    await press('Stop')

    expect(dialog().querySelector('[data-voice-player]')).not.toBeNull()
  })

  it('lets go of the microphone when the sheet is put away, keeping what was recorded', async () => {
    const recorder = recorderClass()
    const cam = recordable(recorder)

    mount(harness, { uploadFileTo: uploads().fn })
    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')

    expect(recorder.made[0]?.stopped).toBe(0)

    await press('Later')

    expect(recorder.made[0]?.stopped).toBe(1)
    expect(cam.stop).toHaveBeenCalled()
  })

  it('stops the recorder and lets go of the microphone when the sheet goes while it is recording', async () => {
    const recorder = recorderClass()
    const cam = recordable(recorder)

    const view = mount(harness, { uploadFileTo: uploads().fn })

    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')

    expect(recorder.made[0]?.started).toBe(1)
    expect(recorder.made[0]?.stopped).toBe(0)
    expect(cam.stop).not.toHaveBeenCalled()

    view.unmount()

    expect(recorder.made[0]?.stopped).toBe(1)
    expect(cam.stop).toHaveBeenCalledTimes(1)
  })

  it('stops a microphone that arrives after the sheet was put away and Record was pressed again, and records with the last', async () => {
    const recorder = recorderClass()
    const late = lateMedia()

    vi.stubGlobal('MediaRecorder', recorder.Recorder)
    vi.stubGlobal(
      'URL',
      Object.assign(URL, { createObjectURL: () => 'blob:voice-0', revokeObjectURL: () => undefined })
    )
    onNavigator({ mediaDevices: { getUserMedia: late.getUserMedia } })

    const view = mount(harness, { uploadFileTo: uploads().fn })

    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')
    await press('Later')
    bringBack('srq-1')
    await press('Record')

    expect(late.asked).toHaveLength(2)

    await act(async () => {
      late.asked[0]?.arrive()
      late.asked[1]?.arrive()
    })
    await settle()

    expect(late.asked[0]?.stop).toHaveBeenCalledTimes(1)
    expect(late.asked[1]?.stop).not.toHaveBeenCalled()
    // One recorder only, on the second microphone.
    expect(recorder.made).toHaveLength(1)

    view.unmount()

    expect(late.asked[1]?.stop).toHaveBeenCalledTimes(1)
  })

  it('stops a microphone the person allowed only after the sheet was put away, and does not record', async () => {
    const recorder = recorderClass()
    const late = lateMedia()

    vi.stubGlobal('MediaRecorder', recorder.Recorder)
    onNavigator({ mediaDevices: { getUserMedia: late.getUserMedia } })
    mount(harness, { uploadFileTo: uploads().fn })
    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')
    await press('Later')
    await act(async () => late.asked[0]?.arrive())
    await settle()

    expect(late.asked[0]?.stop).toHaveBeenCalledTimes(1)
    expect(recorder.made).toEqual([])
  })

  it('stops a microphone the person allowed only after the sheet went, and does not record', async () => {
    const recorder = recorderClass()
    const late = lateMedia()

    vi.stubGlobal('MediaRecorder', recorder.Recorder)
    onNavigator({ mediaDevices: { getUserMedia: late.getUserMedia } })

    const view = mount(harness, { uploadFileTo: uploads().fn })

    raise(harness, 'srq-1', 'input.file', voiceFrame())
    await sheetNamed('A voice note to record')
    await press('Record')
    view.unmount()
    await act(async () => late.asked[0]?.arrive())
    await settle()

    expect(late.asked[0]?.stop).toHaveBeenCalledTimes(1)
    expect(recorder.made).toEqual([])
  })
})

/** A canvas a test can draw on: every call is a no-op, and a PNG is what it encodes. */
function canvasThatEncodes(
  chunks: readonly string[] = ['IHDR', 'sRGB', 'eXIf', 'tEXt', 'IDAT', 'IEND']
): void {
  const context = new Proxy({}, { get: () => () => undefined, set: () => true })

  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => context) as never)
  HTMLCanvasElement.prototype.toBlob = function toBlob(callback: BlobCallback) {
    // An encoder like WebKit's, which adds metadata of its own to the picture.
    callback(new Blob([pngOf(chunks)], { type: 'image/png' }))
  }
  vi.stubGlobal('Path2D', class Path2DStub {})
}

/** A pointer event, which jsdom does not have: a mouse event that says which pointer it is. */
function pointer(target: Element, type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true })

  Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'touch' } })
  fireEvent(target, event)
}

/** A stroke across the pad. */
function draw(): void {
  const pad = dialog().querySelector('[data-signature-pad]') as HTMLCanvasElement

  vi.spyOn(pad, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 200 } as DOMRect)
  pad.setPointerCapture = () => undefined
  pointer(pad, 'pointerdown', 40, 150)

  for (let step = 1; step <= 12; step += 1) {
    pointer(pad, 'pointermove', 40 + step * 25, 150 - Math.sin(step) * 60)
  }

  pointer(pad, 'pointerup', 340, 120)
}

describe('a signature', () => {
  const STATEMENT = 'I have read the rental agreement dated 3 October 2026 and agree to its terms.'

  it('shows the statement as it is, with the signer, and does not take a signature that is not drawn', async () => {
    canvasThatEncodes()
    mount(harness, { uploadFileTo: uploads().fn })
    raise(harness, 'srq-1', 'input.signature', signatureFrame())
    await sheetNamed('A signature to give')

    expect(dialog().querySelector('[data-signature-statement]')?.textContent).toBe(STATEMENT)
    expect(dialog().textContent).toContain('Ada Lovelace')
    expect(within(dialog()).getByRole('img', { name: /Signature pad/u })).toBeTruthy()
    expect((button('Sign and send') as HTMLButtonElement).disabled).toBe(true)
    expect((button('Clear') as HTMLButtonElement).disabled).toBe(true)
  })

  it('draws with a pointer, uploads a PNG and an SVG into the request’s directory and answers with their references and the statement’s fingerprint', async () => {
    canvasThatEncodes()

    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.signature', signatureFrame())
    await sheetNamed('A signature to give')
    draw()

    expect((button('Sign and send') as HTMLButtonElement).disabled).toBe(false)

    await press('Sign and send')

    expect(up.calls.map(call => call.file.name)).toEqual(['signature.png', 'signature.svg'])
    expect(up.calls.map(call => call.file.mimeType)).toEqual(['image/png', 'image/svg+xml'])

    for (const call of up.calls) {
      expect(call.path).toMatch(/^\/home\/ada\/work\/uploads\/hermie\/2026-10-04\/[0-9a-f]{16}-signature\.(png|svg)$/u)
    }

    const result = lastAnswer(harness) as {
      status: string
      files: { name: string; mime: string; bytes: number }[]
      signed_at: number
      statement_sha256: string
    }

    expect(result.status).toBe('answered')
    expect(result.files.map(file => [file.name, file.mime])).toEqual([
      ['signature.png', 'image/png'],
      ['signature.svg', 'image/svg+xml']
    ])
    expect(result.statement_sha256).toBe(await statementSha256(STATEMENT))
    expect(Number.isInteger(result.signed_at)).toBe(true)

    // The PNG that went up is the picture and nothing else, though the encoder added metadata.
    const png = new Uint8Array(await bytesOf(up.calls[0]?.file.body as Blob))

    expect(pngChunkTypes(png)).toEqual(['IHDR', 'sRGB', 'IDAT', 'IEND'])

    // The SVG that went up is what the gateway’s allowlist takes.
    const svg = await textOf(up.calls[1]?.file.body)

    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u)
    expect(svg).toContain('<path d="M')
    expect(refusalFor('input.signature', signatureFrame() as never, result)).toBeNull()
  })

  it('exports the drawing as it was when Sign was pressed: a pointer still down adds nothing to the files', async () => {
    canvasThatEncodes()

    const up = uploads()

    mount(harness, { uploadFileTo: up.fn })
    raise(harness, 'srq-1', 'input.signature', signatureFrame())
    await sheetNamed('A signature to give')

    const pad = dialog().querySelector('[data-signature-pad]') as HTMLCanvasElement

    vi.spyOn(pad, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 600, height: 200 } as DOMRect)
    pad.setPointerCapture = () => undefined
    pointer(pad, 'pointerdown', 40, 150)

    for (let step = 1; step <= 12; step += 1) {
      pointer(pad, 'pointermove', 40 + step * 25, 150 - Math.sin(step) * 60)
    }

    // Sign is pressed with the finger still down, which goes on moving while the files are made.
    act(() => {
      fireEvent.click(button('Sign and send'))
      pointer(pad, 'pointermove', 590, 10)
    })
    await settle()
    act(() => {
      pointer(pad, 'pointermove', 580, 20)
    })
    await settle()

    const svg = await textOf(up.calls[1]?.file.body)

    expect(up.calls.map(call => call.file.name)).toEqual(['signature.png', 'signature.svg'])
    expect(svg).toMatch(/L340 /u)
    expect(svg).not.toMatch(/\b5[89]0 /u)
  })

  it('clears the pad, and a cleared pad is not a signature', async () => {
    canvasThatEncodes()
    mount(harness, { uploadFileTo: uploads().fn })
    raise(harness, 'srq-1', 'input.signature', signatureFrame())
    await sheetNamed('A signature to give')
    draw()

    expect((button('Sign and send') as HTMLButtonElement).disabled).toBe(false)

    fireEvent.click(button('Clear'))

    expect((button('Sign and send') as HTMLButtonElement).disabled).toBe(true)
  })

  it('hashes the statement exactly as it came, whitespace and all', async () => {
    canvasThatEncodes()

    const statement = 'I agree.  \nTwice.   '

    mount(harness, { uploadFileTo: uploads().fn })
    raise(harness, 'srq-1', 'input.signature', signatureFrame({ statement }))
    await sheetNamed('A signature to give')
    draw()
    await press('Sign and send')

    expect((lastAnswer(harness) as { statement_sha256: string }).statement_sha256).toBe(
      await statementSha256(statement)
    )
    expect((lastAnswer(harness) as { statement_sha256: string }).statement_sha256).not.toBe(
      await statementSha256(statement.trim())
    )
  })

  it('says an upload that failed, keeps the drawing, and tells the bot when the person gives up', async () => {
    canvasThatEncodes()

    let failing = true
    const up = uploads()

    mount(harness, {
      uploadFileTo: async (path, file) => {
        if (failing) {
          throw Object.assign(new Error('boom'), { name: 'FileUploadError', reason: 'failed' })
        }

        return up.fn(path, file)
      }
    })
    raise(harness, 'srq-1', 'input.signature', signatureFrame())
    await sheetNamed('A signature to give')
    draw()
    await press('Sign and send')

    expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0)
    expect(harness.gw.calls.filter(call => call.method === 'request.answer')).toEqual([])

    failing = false
    await press('Try again')

    expect(lastAnswer(harness)).toMatchObject({ status: 'answered' })
  })

  it('does not draw with the secondary mouse button', async () => {
    canvasThatEncodes()
    mount(harness, { uploadFileTo: uploads().fn })
    raise(harness, 'srq-1', 'input.signature', signatureFrame())
    await sheetNamed('A signature to give')

    const pad = dialog().querySelector('[data-signature-pad]') as HTMLCanvasElement
    const event = new MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 2, bubbles: true })

    Object.defineProperties(event, { pointerId: { value: 1 }, pointerType: { value: 'mouse' } })
    pad.setPointerCapture = () => undefined
    fireEvent(pad, event)
    pointer(pad, 'pointermove', 300, 100)

    expect((button('Sign and send') as HTMLButtonElement).disabled).toBe(true)
  })
})
