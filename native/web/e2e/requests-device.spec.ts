/**
 * The sheets that reach for the device (`input.signature`, `device.location`, `device.contact`, `device.scan` and a voice
 * note, `input.file` with `capture: audio`), answered in a real browser against the fake gateway serving the built
 * client. The fake holds every answer to the contract (`contract/requests/` sections 3, 5.1 and 8 to 12) and reports what
 * the AGENT is told (rounded, cleaned, hashed), so what is asserted here is what the gateway would have taken.
 *
 * The browser's own permission prompts cannot be answered by a test, so each API is given the way a person's browser
 * would give it:
 *
 *  - **Location**: the context's geolocation permission and position (Playwright's own), so `getCurrentPosition` is the
 *    real call with a mocked position.
 *  - **Contacts** and **the code scanner**: neither exists in a desktop browser the suite runs, so an init script stands in
 *    for `navigator.contacts` and `BarcodeDetector`. The scanner's camera is a canvas's stream, so the page really gets a
 *    `MediaStream`, plays it in a `<video>` and hands its frames to the detector.
 *  - **The voice note** is the browser's own `MediaRecorder` over a stream from the Web Audio API.
 *  - **The signature** is drawn with the mouse on the real pad: pointer events, a real canvas, the real PNG.
 *
 * What each proves: the sheet asks nothing of the browser until its own button is pressed; the answer is only what the
 * person chose (a location never more precise than chosen, a contact only what is ticked); an upload goes straight into
 * the request's directory; the SVG of a signature passes the gateway's allowlist exactly (the fake judges the file it
 * received); the transcript says what KIND of thing was shared and never what; a method this browser cannot do is never
 * advertised, so the gateway never sends it; and axe finds nothing serious on any of the sheets in both colour schemes.
 */
import { pngOrSvgProblem } from '@hermie/fake-gateway'

import { BOT, expect, type Gateway, type Page, seriousViolations, test } from './fixtures'

interface View {
  id: string
  method: string
  open: boolean
  answer?: Record<string, unknown>
  refusals: string[]
  outcome?: string
  reason?: string
  problem?: string
}

const viewOf = async (gateway: Gateway, id: string): Promise<View> =>
  (await (await fetch(`${gateway.url}/__fake/request/${id}`)).json()) as View

interface Upload {
  path: string
  name: string
  mime: string
  bytes: number
  sha256: string
}

const filesOf = async (gateway: Gateway): Promise<Upload[]> =>
  ((await (await fetch(`${gateway.url}/__fake/files`)).json()) as { files: Upload[] }).files

const bytesOf = async (gateway: Gateway, path: string): Promise<Buffer> => {
  const response = await fetch(`${gateway.url}/__fake/files/content?path=${encodeURIComponent(path)}`)

  expect(response.status).toBe(200)

  return Buffer.from(await response.arrayBuffer())
}

/** One attempt to raise a request: its HTTP status and, when it was raised, its id. */
async function tryRaise(
  gateway: Gateway,
  method: string,
  params: Record<string, unknown> = {}
): Promise<{ status: number; id: string }> {
  const response = await fetch(`${gateway.url}/__fake/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profile: BOT, method, params })
  })

  return { status: response.status, id: response.ok ? ((await response.json()) as { id: string }).id : '' }
}

/** Raise a request the way the agent does, as soon as the page has advertised it (409 until then). */
async function raise(gateway: Gateway, method: string, params: Record<string, unknown> = {}): Promise<string> {
  let id = ''

  await expect
    .poll(
      async () => {
        const attempt = await tryRaise(gateway, method, params)

        id = attempt.id

        return attempt.status
      },
      { timeout: 20_000 }
    )
    .toBe(200)

  return id
}

const DIR = '/home/ada/work/uploads/hermie/2026-10-04'

/** What a browser with a contact picker, a barcode detector and a camera has, as a page's own init script stands it up. */
const DEVICE_STUBS = (): void => {
  const w = window as unknown as Record<string, unknown>
  const picks: unknown[] = []

  w.__hermie = { picks, scans: 0, cameraStops: 0 }

  // The Contact Picker: Bram has everything; what the page asked for is recorded.
  Object.defineProperty(navigator, 'contacts', {
    configurable: true,
    value: {
      getProperties: async () => ['name', 'tel', 'email', 'address', 'icon'],
      select: async (properties: string[], options: unknown) => {
        picks.push({ properties, options })

        return [
          {
            name: ['Bram de Vries'],
            tel: ['+31 6 12345678', '+31 20 5551234'],
            email: ['bram@example.com'],
            address: [
              { addressLine: ['Keizersgracht 12'], postalCode: '1015 CS', city: 'Amsterdam', country: 'Netherlands' }
            ]
          }
        ]
      }
    }
  })
  w.ContactsManager = function ContactsManager() {}

  // The barcode detector: it reads a QR code from whatever picture it is given (the canvas's stream below).
  w.BarcodeDetector = class {
    static async getSupportedFormats(): Promise<string[]> {
      return ['qr_code', 'ean_13', 'ean_8', 'code_128', 'pdf417', 'data_matrix', 'aztec']
    }

    async detect(): Promise<{ rawValue: string; format: string }[]> {
      ;(w.__hermie as { scans: number }).scans += 1

      return [{ rawValue: 'WIFI:T:WPA;S:Home 5G;P:correct horse;;', format: 'qr_code' }]
    }
  }

  // The camera: the real `getUserMedia` of a browser with no camera fails; this one hands back a canvas's stream,
  // and the audio stream the voice note records.
  const real = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices)

  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async (constraints: { video?: unknown; audio?: unknown }) => {
        if (constraints.video) {
          const canvas = document.createElement('canvas')

          canvas.width = 160
          canvas.height = 120
          canvas.getContext('2d')?.fillRect(0, 0, 160, 120)

          const stream = canvas.captureStream(5)

          for (const track of stream.getTracks()) {
            const stop = track.stop.bind(track)

            track.stop = () => {
              ;(w.__hermie as { cameraStops: number }).cameraStops += 1
              stop()
            }
          }

          return stream
        }

        // On a CI runner Firefox's Web Audio does not start (no audio device: the stream below never arrived and the
        // sheet waited for its microphone), so Firefox gets its own fake microphone (`firefoxUserPrefs` in
        // `playwright.config.ts`); the other browsers record a stream made here.
        if (/Firefox/u.test(navigator.userAgent) && real) {
          return real(constraints as MediaStreamConstraints)
        }

        const context = new AudioContext()
        const source = context.createOscillator()
        const destination = context.createMediaStreamDestination()

        source.connect(destination)
        source.start()
        await context.resume().catch(() => undefined)

        return destination.stream
      },
      real
    }
  })
}

/** A browser with none of the device APIs: what a page on a desktop or a plain-http gateway really has. */
const NO_DEVICE_APIS = (): void => {
  const w = window as unknown as Record<string, unknown>

  Object.defineProperty(navigator, 'geolocation', { configurable: true, value: undefined })
  Object.defineProperty(navigator, 'contacts', { configurable: true, value: undefined })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })
  delete w.BarcodeDetector
  delete w.ContactsManager
  delete w.MediaRecorder
}

test.describe('the location', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['geolocation'])
    await context.setGeolocation({ latitude: 52.373123, longitude: 4.892201, accuracy: 8.46 })
  })

  test('asks the browser only after Share, and shares an approximate location rounded, as the bot asked', async ({
    app,
    gateway,
    page
  }) => {
    await page.addInitScript(() => {
      const real = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation)
      const asked: PositionOptions[] = []

      ;(window as unknown as Record<string, unknown>).__asked = asked
      navigator.geolocation.getCurrentPosition = (ok, fail, options) => {
        asked.push({ ...options })
        real(ok, fail, options)
      }
    })
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'device.location', { precision: 'approximate' })

    await expect(app.dialog).toHaveAccessibleName('Your location, once')
    await expect(app.dialog).toContainText('The bot asked for your approximate location only.')
    await expect(app.dialog.locator('[data-precision="precise"]')).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __asked: unknown[] }).__asked.length)).toBe(0)

    await app.dialog.getByRole('button', { name: 'Share location' }).click()
    await expect(app.dialog).toHaveCount(0)

    expect(await page.evaluate(() => (window as unknown as { __asked: PositionOptions[] }).__asked)).toEqual([
      expect.objectContaining({ enableHighAccuracy: false })
    ])

    const view = await viewOf(gateway, id)

    expect(view.outcome).toBe('answered')
    expect(view.answer).toMatchObject({ precision: 'approximate', lat: 52.37, lon: 4.89 })
    expect(Number(view.answer?.accuracy_m)).toBeGreaterThanOrEqual(1000)
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Approximate location shared')
    // The transcript says how exact, never where.
    await expect(app.transcript).not.toContainText('52.37')
  })

  test('shares a precise location when it was asked for, and less when the person lowers it first', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()

    const precise = await raise(gateway, 'device.location', { precision: 'precise' })

    await expect(app.dialog).toHaveAccessibleName('Your location, once')
    await app.dialog.getByRole('button', { name: 'Share location' }).click()
    await expect(app.dialog).toHaveCount(0)

    expect((await viewOf(gateway, precise)).answer).toMatchObject({
      precision: 'precise',
      lat: 52.373123,
      lon: 4.892201
    })

    const lowered = await raise(gateway, 'device.location', { precision: 'precise' })

    await expect(app.dialog).toHaveAccessibleName('Your location, once')
    await app.dialog.getByRole('radio', { name: /Approximate/u }).check()
    await app.dialog.getByRole('button', { name: 'Share location' }).click()
    await expect(app.dialog).toHaveCount(0)

    const view = await viewOf(gateway, lowered)

    expect(view.answer).toMatchObject({ precision: 'approximate', lat: 52.37, lon: 4.89 })
    expect(page.url()).toContain(gateway.url)
  })

  test('tells the bot when the browser says no: 4041 permission_denied, not a made-up skip', async ({
    app,
    browserName,
    context,
    gateway,
    page
  }) => {
    await context.clearPermissions()

    if (browserName === 'firefox') {
      // Firefox, with nobody to answer its prompt, leaves the request pending instead of refusing it. This is the
      // person pressing Block: the page is told what a refusal tells it.
      await page.addInitScript(() => {
        navigator.geolocation.getCurrentPosition = (_ok, fail) => {
          setTimeout(
            () =>
              fail?.({
                code: 1,
                message: 'User denied Geolocation',
                PERMISSION_DENIED: 1,
                POSITION_UNAVAILABLE: 2,
                TIMEOUT: 3
              }),
            0
          )
        }
      })
    }

    await app.open()
    await app.ready()

    const id = await raise(gateway, 'device.location', { precision: 'approximate' })

    await expect(app.dialog).toHaveAccessibleName('Your location, once')
    await app.dialog.getByRole('button', { name: 'Share location' }).click()
    await expect(app.dialog).toHaveCount(0)

    const view = await viewOf(gateway, id)

    expect(view.outcome).toBe('unavailable')
    expect(view.reason).toBe('permission_denied')
  })
})

test.describe('a contact', () => {
  test('opens the picker for the fields asked for on a press, shows them, and sends only what is ticked', async ({
    app,
    gateway,
    page
  }) => {
    await page.addInitScript(DEVICE_STUBS)
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'device.contact', { fields: ['name', 'phones', 'emails'] })

    await expect(app.dialog).toHaveAccessibleName('A contact to share')
    expect(await page.evaluate(() => (window as unknown as { __hermie: { picks: unknown[] } }).__hermie.picks)).toEqual(
      []
    )

    await app.dialog.getByRole('button', { name: 'Choose a contact' }).click()
    await expect(app.dialog.getByRole('checkbox')).toHaveCount(3)
    expect(await page.evaluate(() => (window as unknown as { __hermie: { picks: unknown[] } }).__hermie.picks)).toEqual(
      [{ properties: ['name', 'tel', 'email'], options: { multiple: false } }]
    )
    // The address was not asked for: it is not even shown.
    await expect(app.dialog).not.toContainText('Keizersgracht')

    await app.dialog.getByRole('checkbox', { name: 'email addresses' }).uncheck()
    await app.dialog.getByRole('button', { name: 'Send contact' }).click()
    await expect(app.dialog).toHaveCount(0)

    const view = await viewOf(gateway, id)

    expect(view.outcome).toBe('answered')
    expect(view.answer).toMatchObject({
      contact: { name: 'Bram de Vries', phones: ['+31 6 12345678', '+31 20 5551234'] }
    })
    expect(Object.keys((view.answer as { contact: object }).contact)).toEqual(['name', 'phones'])
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText(
      'Contact shared: name and phone numbers'
    )
    await expect(app.transcript).not.toContainText('Bram')
  })
})

test.describe('a code to scan', () => {
  test('starts the camera only after Start, shows what the code says, and sends it only on a press', async ({
    app,
    gateway,
    page
  }) => {
    await page.addInitScript(DEVICE_STUBS)
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'device.scan', { formats: ['qr', 'ean13'] })

    await expect(app.dialog).toHaveAccessibleName('A code to scan')
    await expect(app.dialog).toContainText('The bot is looking for: QR code and EAN-13.')
    await expect(app.dialog.locator('video')).toHaveCount(0)

    await app.dialog.getByRole('button', { name: 'Start the camera' }).click()
    await expect(app.dialog.locator('[data-scan-value]')).toHaveText('WIFI:T:WPA;S:Home 5G;P:correct horse;;')
    // Read, shown, not opened: no link, nothing sent yet, and the camera let go the moment it was read.
    await expect(app.dialog.locator('a')).toHaveCount(0)
    expect((await viewOf(gateway, id)).answer).toBeUndefined()
    expect(
      await page.evaluate(() => (window as unknown as { __hermie: { cameraStops: number } }).__hermie.cameraStops)
    ).toBeGreaterThan(0)

    await app.dialog.getByRole('button', { name: 'Send this code' }).click()
    await expect(app.dialog).toHaveCount(0)

    const view = await viewOf(gateway, id)

    expect(view.outcome).toBe('answered')
    expect(view.answer).toMatchObject({ symbology: 'qr', value: 'WIFI:T:WPA;S:Home 5G;P:correct horse;;' })
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Code sent (QR code)')
    await expect(app.transcript).not.toContainText('correct horse')
  })
})

test.describe('a voice note', () => {
  test('records on Record, plays back, and uploads and sends only on Send: audio with no codecs in its type, no transcript', async ({
    app,
    gateway,
    page
  }) => {
    await page.addInitScript(DEVICE_STUBS)
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.file', {
      accept: 'audio',
      capture: 'audio',
      multiple: false,
      upload: { dir: DIR, max_bytes: 5_242_880, max_total_bytes: 5_242_880, max_files: 1, strip_metadata: false }
    })

    await expect(app.dialog).toHaveAccessibleName('A voice note to record')
    expect(await filesOf(gateway)).toEqual([])

    await app.dialog.getByRole('button', { name: 'Record' }).click()
    await expect(app.dialog.getByRole('button', { name: 'Stop' })).toBeEnabled()
    await page.waitForTimeout(600)
    await app.dialog.getByRole('button', { name: 'Stop' }).click()
    await expect(app.dialog.locator('[data-voice-player]')).toBeVisible()
    // Nothing went anywhere while the person was listening.
    expect(await filesOf(gateway)).toEqual([])
    expect((await viewOf(gateway, id)).answer).toBeUndefined()

    await app.dialog.getByRole('button', { name: 'Send recording' }).click()
    await expect(app.dialog).toHaveCount(0)

    const [file] = await filesOf(gateway)

    expect(file?.path).toMatch(new RegExp(`^${DIR}/[0-9a-f]{16}-voice-note\\.[a-z0-9]+$`, 'u'))
    expect(file?.mime).toMatch(/^audio\/[a-z0-9.+-]+$/u)
    expect(file?.mime).not.toContain(';')
    expect(file?.bytes).toBeGreaterThan(0)

    const view = await viewOf(gateway, id)

    expect(view.outcome).toBe('answered')
    expect(view.answer).not.toHaveProperty('text')
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Voice note sent')
  })
})

/** The types of a PNG's chunks, in order: 4 ASCII letters after each chunk's length (the file's own framing). */
function pngChunkTypes(png: Buffer): string[] {
  const types: string[] = []
  let at = 8

  while (at + 8 <= png.length) {
    types.push(png.toString('latin1', at + 4, at + 8))
    // Length, type, data, CRC.
    at += 12 + png.readUInt32BE(at)
  }

  expect(at).toBe(png.length)

  return types
}

test.describe('a signature', () => {
  /** A stroke across the pad with the mouse: pointer events on the real canvas. */
  async function sign(page: Page): Promise<void> {
    const pad = page.locator('[data-signature-pad]')

    // The sheet takes no press for a moment after it appears (the tap guard): a stray click cannot draw either.
    await expect(page.getByRole('dialog').getByRole('button', { name: "Don't share" })).toBeEnabled()

    const box = await pad.boundingBox()

    if (!box) {
      throw new Error('no pad')
    }

    await page.mouse.move(box.x + 30, box.y + box.height * 0.7)
    await page.mouse.down()

    for (let step = 1; step <= 16; step += 1) {
      await page.mouse.move(box.x + 30 + step * 20, box.y + box.height * (0.7 - Math.sin(step / 2) * 0.35))
    }

    await page.mouse.up()
  }

  test('draws on the pad, uploads a PNG and an SVG into the request’s directory, and the gateway takes both', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()

    const statement = 'I have read the rental agreement dated 3 October 2026 and agree to its terms.'
    const id = await raise(gateway, 'input.signature', { statement, signer_name: 'Ada Lovelace' })

    await expect(app.dialog).toHaveAccessibleName('A signature to give')
    await expect(app.dialog.locator('[data-signature-statement]')).toHaveText(statement)
    await expect(app.dialog.getByRole('button', { name: 'Sign and send' })).toBeDisabled()

    await sign(page)
    await expect(app.dialog.getByRole('button', { name: 'Sign and send' })).toBeEnabled()
    await app.dialog.getByRole('button', { name: 'Sign and send' }).click()
    await expect(app.dialog).toHaveCount(0)

    const files = await filesOf(gateway)

    expect(files.map(file => file.name).sort()).toEqual(['signature.png', 'signature.svg'])

    for (const file of files) {
      expect(file.path).toMatch(/\/[0-9a-f]{16}-signature\.(png|svg)$/u)
      expect(file.path.startsWith(`${DIR.slice(0, DIR.lastIndexOf('/'))}`)).toBe(true)
      // What the gateway checks after the request settled: the PNG's signature, the SVG against its allowlist.
      expect(pngOrSvgProblem(file.mime, await bytesOf(gateway, file.path)), file.name).toBeNull()
    }

    const png = await bytesOf(gateway, files.find(file => file.mime === 'image/png')?.path ?? '')
    const svg = (await bytesOf(gateway, files.find(file => file.mime === 'image/svg+xml')?.path ?? '')).toString('utf8')

    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47])

    // Nothing but the picture goes up: no text and no EXIF, nothing a browser's encoder could add about the device or
    // the person.
    const chunks = pngChunkTypes(png)

    expect(chunks[0]).toBe('IHDR')
    expect(chunks.at(-1)).toBe('IEND')
    expect(chunks).toContain('IDAT')

    for (const metadata of ['tEXt', 'iTXt', 'zTXt', 'eXIf']) {
      expect(chunks, metadata).not.toContain(metadata)
    }
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/u)
    expect(svg).toContain('<path d="M')

    const view = await viewOf(gateway, id)

    // Accepted, and the files were judged and passed (a bad file would make it `unavailable (bad_upload)`).
    expect(view.outcome).toBe('answered')
    expect(view.problem).toBeUndefined()
    expect(view.answer).toMatchObject({ signed: true })
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Signed')
  })

  test('clears the pad, and a cleared pad is not a signature', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()
    await raise(gateway, 'input.signature', {})
    await expect(app.dialog).toHaveAccessibleName('A signature to give')
    await sign(page)
    await expect(app.dialog.getByRole('button', { name: 'Sign and send' })).toBeEnabled()
    await app.dialog.getByRole('button', { name: 'Clear' }).click()
    await expect(app.dialog.getByRole('button', { name: 'Sign and send' })).toBeDisabled()
  })
})

test.describe('what this browser cannot do', () => {
  test('is never advertised, so the gateway never sends it: location, contact, code, a calendar', async ({
    app,
    gateway,
    page
  }) => {
    await page.addInitScript(NO_DEVICE_APIS)
    await app.open()
    await app.ready()

    // The advert has settled once a form (which every browser can show) can be raised; the rest then have no taker.
    const form = await raise(gateway, 'input.form', {})

    await expect(app.dialog).toHaveAccessibleName('A form to fill in')
    expect(form).not.toBe('')

    for (const method of ['device.location', 'device.contact', 'device.scan', 'device.calendar']) {
      expect(
        (await tryRaise(gateway, method, method === 'device.calendar' ? { kind: 'event', item: { title: 'x' } } : {}))
          .status,
        method
      ).toBe(409)
    }

    // A signature needs only a canvas and pointer events, which this browser has; a voice note falls back to a file picker.
    const voice = await raise(gateway, 'input.file', {
      accept: 'audio',
      capture: 'audio',
      upload: { dir: DIR, max_bytes: 1_000_000, max_total_bytes: 1_000_000, max_files: 1 }
    })

    expect(voice).not.toBe('')
  })

  test('a voice note is a file picker where the browser cannot record', async ({ app, gateway, page }) => {
    await page.addInitScript(NO_DEVICE_APIS)
    await app.open()
    await app.ready()
    await raise(gateway, 'input.file', {
      accept: 'audio',
      capture: 'audio',
      upload: { dir: DIR, max_bytes: 1_000_000, max_total_bytes: 1_000_000, max_files: 1, strip_metadata: false }
    })
    await expect(app.dialog).toHaveAccessibleName('Files to upload')
    await expect(app.dialog.getByRole('button', { name: 'Record' })).toHaveCount(0)
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe in the ${scheme} scheme`, () => {
    test.beforeEach(async ({ page, context }) => {
      await page.emulateMedia({ colorScheme: scheme })
      await context.grantPermissions(['geolocation'])
      await context.setGeolocation({ latitude: 52.373123, longitude: 4.892201, accuracy: 8.46 })
    })

    test('the signature, location, contact, scan and voice sheets have no serious violation, contrast included', async ({
      app,
      gateway,
      page
    }) => {
      await page.addInitScript(DEVICE_STUBS)
      await app.open()
      await app.ready()

      const skip = async (): Promise<void> => {
        await app.dialog.getByRole('button', { name: 'Skip' }).click()
        await expect(app.dialog).toHaveCount(0)
      }

      await raise(gateway, 'input.signature', {})
      await expect(app.dialog).toHaveAccessibleName('A signature to give')
      expect(await seriousViolations(page, `signature-${scheme}`)).toEqual([])
      await page.locator('[data-signature-pad]').scrollIntoViewIfNeeded()

      const box = await page.locator('[data-signature-pad]').boundingBox()

      if (box) {
        await page.mouse.move(box.x + 20, box.y + 40)
        await page.mouse.down()
        await page.mouse.move(box.x + 200, box.y + 90)
        await page.mouse.up()
      }

      expect(await seriousViolations(page, `signature-drawn-${scheme}`)).toEqual([])
      await skip()

      await raise(gateway, 'device.location', { precision: 'precise' })
      await expect(app.dialog).toHaveAccessibleName('Your location, once')
      expect(await seriousViolations(page, `location-${scheme}`)).toEqual([])
      await skip()

      await raise(gateway, 'device.contact', { fields: ['name', 'phones', 'birthday'] })
      await expect(app.dialog).toHaveAccessibleName('A contact to share')
      await app.dialog.getByRole('button', { name: 'Choose a contact' }).click()
      await expect(app.dialog.getByRole('checkbox').first()).toBeVisible()
      expect(await seriousViolations(page, `contact-${scheme}`)).toEqual([])
      await skip()

      await raise(gateway, 'device.scan', {})
      await expect(app.dialog).toHaveAccessibleName('A code to scan')
      expect(await seriousViolations(page, `scan-${scheme}`)).toEqual([])
      await app.dialog.getByRole('button', { name: 'Start the camera' }).click()
      await expect(app.dialog.locator('[data-scan-value]')).toBeVisible()
      expect(await seriousViolations(page, `scan-found-${scheme}`)).toEqual([])
      await skip()

      await raise(gateway, 'input.file', {
        accept: 'audio',
        capture: 'audio',
        upload: { dir: DIR, max_bytes: 5_242_880, max_total_bytes: 5_242_880, max_files: 1, strip_metadata: false }
      })
      await expect(app.dialog).toHaveAccessibleName('A voice note to record')
      expect(await seriousViolations(page, `voice-${scheme}`)).toEqual([])
      await app.dialog.getByRole('button', { name: 'Record' }).click()
      await expect(app.dialog.getByRole('button', { name: 'Stop' })).toBeEnabled()
      await page.waitForTimeout(400)
      await app.dialog.getByRole('button', { name: 'Stop' }).click()
      await expect(app.dialog.locator('[data-voice-player]')).toBeVisible()
      expect(await seriousViolations(page, `voice-recorded-${scheme}`)).toEqual([])
    })
  })
}
