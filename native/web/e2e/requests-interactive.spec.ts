/**
 * The sheets for a form, a file request and a draft (`input.form`, `input.file`, `review.draft`), answered in a real
 * browser against the fake gateway serving the built client. The fake holds every answer to the contract
 * (`contract/requests/`: ranges, steps, currency decimals, datetimes with their offset and zone, where a file may live,
 * what a draft may contain), so an answer it takes is an answer the contract describes.
 *
 *  - **A form** is raised with fields of every kind the sheet draws, filled in with the keyboard and the browser's own
 *    inputs, and sent: the fake took exactly the values the contract describes (a number, an amount as a decimal
 *    string, a datetime with its offset and zone), and the transcript says it was answered.
 *  - **A refusal round trip.** The page checks a form before it sends it, so it cannot be made to send an invalid
 *    amount by typing; the test changes the answer on its way out (a client that and a gateway that disagree), the gateway
 *    refuses it with `4034 field:budget:format`, the sheet shows the reason next to the field in words, keeps
 *    everything that was typed and the same inputs, and the corrected answer is accepted.
 *  - **A file** picked in the browser is uploaded directly into the request's directory (flat, `<16 hex>-<name>`), and
 *    the answer quotes the path, the size and the SHA-256 of what the gateway received (`/__fake/files`). With
 *    `strip_metadata` a JPEG with EXIF and GPS data goes up without them (the bytes on the wire are read). A failed
 *    upload is said, and giving up is `4041 upload_failed`.
 *  - **A draft** is approved as it is, with changes, or rejected with a comment; the text is plain text, and a
 *    hidden character is shown by its code point and holds the approval back.
 *  - **Axe**, contrast included, in both colour schemes, on each sheet.
 */
import { createHash } from 'node:crypto'

import { BOT, expect, type Gateway, seriousViolations, test } from './fixtures'

interface View {
  id: string
  method: string
  open: boolean
  answer?: Record<string, unknown>
  refusals: string[]
  outcome?: string
  error?: { code?: number; message?: string; data?: { reason?: string } }
}

interface Upload {
  path: string
  name: string
  mime: string
  bytes: number
  sha256: string
}

const viewOf = async (gateway: Gateway, id: string): Promise<View> =>
  (await (await fetch(`${gateway.url}/__fake/request/${id}`)).json()) as View

const filesOf = async (gateway: Gateway): Promise<Upload[]> =>
  ((await (await fetch(`${gateway.url}/__fake/files`)).json()) as { files: Upload[] }).files

/** Raise a request the way the agent does, as soon as the page has advertised it (409 until then). */
async function raise(gateway: Gateway, method: string, params: Record<string, unknown> = {}): Promise<string> {
  let id = ''

  await expect
    .poll(
      async () => {
        const response = await fetch(`${gateway.url}/__fake/request`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ profile: BOT, method, params })
        })

        if (response.ok) {
          id = ((await response.json()) as { id: string }).id
        }

        return response.status
      },
      { timeout: 20_000 }
    )
    .toBe(200)

  return id
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex')

const DIR = '/home/ada/work/uploads/hermie/2026-10-04'

const FORM_FIELDS = [
  { id: 'name', kind: 'text', label: 'Name on the booking', required: true, max_length: 20 },
  { id: 'guests', kind: 'number', label: 'Guests', required: true, min: 1, max: 12, integer: true, default: 2 },
  { id: 'stay', kind: 'daterange', label: 'Stay', required: true, min: '2026-10-05', max: '2026-12-31' },
  { id: 'budget', kind: 'amount', label: 'Budget per night', currency: 'EUR', min: '0', max: '5000' },
  { id: 'call_at', kind: 'datetime', label: 'When may we call?', tz: 'Europe/Amsterdam' },
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

const FORM = { title: 'Hotel booking', summary: 'Fill this in and I will book the best match.', fields: FORM_FIELDS }

const UPLOAD = { dir: DIR, max_bytes: 5_242_880, max_total_bytes: 10_485_760, max_files: 3, strip_metadata: false }

const DRAFT = {
  kind: 'mail',
  title: 'Reply to Bram',
  summary: 'Approve or reject it.',
  subject: 'Re: lunch',
  recipients: ['bram@example.test'],
  text: 'Hi Bram,\n\nThursday works.\n\nAda',
  editable: true
}

test.describe('a form', () => {
  test('is filled in with the browser’s own inputs and sent as the contract’s values', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.form', FORM)
    const dialog = app.dialog

    await expect(dialog).toHaveAccessibleName('A form to fill in')
    await expect(dialog).toContainText('Fill this in and I will book the best match.')
    await expect(dialog).toContainText('Time zone: Europe/Amsterdam')
    await expect(dialog).toContainText('Amount in EUR, up to 2 decimals')

    await dialog.getByLabel('Name on the booking').fill('Ada Lovelace')
    await dialog.getByLabel('Guests').fill('4')
    await dialog.getByLabel('From').fill('2026-11-14')
    await dialog.getByLabel('To').fill('2026-11-16')
    await dialog.getByLabel('Budget per night').fill('1250.50')
    await dialog.getByLabel('When may we call?').fill('2026-10-07T14:30')
    await expect(dialog).toContainText('Sent as 2026-10-07T14:30+02:00[Europe/Amsterdam]')
    await dialog.getByLabel('Double').check()
    await dialog.getByLabel('Breakfast').check()
    await dialog.getByLabel('Parking').check()
    await dialog.getByRole('switch', { name: /Send me offers/u }).check()
    await dialog.getByLabel('Anything we should know?').fill('Arriving late.\nNo nuts, please.')
    await dialog.getByRole('button', { name: 'Send answers' }).click()

    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await viewOf(gateway, id)).answer)
      .toEqual({
        status: 'answered',
        values: {
          name: 'Ada Lovelace',
          guests: 4,
          stay: { start: '2026-11-14', end: '2026-11-16' },
          budget: '1250.50',
          call_at: '2026-10-07T14:30+02:00[Europe/Amsterdam]',
          room: 'double',
          extras: ['breakfast', 'parking'],
          newsletter: true,
          notes: 'Arriving late.\nNo nuts, please.'
        }
      })
    expect((await viewOf(gateway, id)).outcome).toBe('answered')

    // The transcript records that it was asked and how it ended, never what was answered.
    const record = app.transcript.locator('article[data-kind="request"]')

    await expect(record).toContainText('Hotel booking')
    await expect(record).toContainText('Answered')
    await expect(record).not.toContainText('Ada Lovelace')
  })

  test('is checked by the page first: the problem is named next to its field, and nothing is sent', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.form', FORM)
    const dialog = app.dialog

    await dialog.getByLabel('Name on the booking').fill('Ada Lovelace')
    await dialog.getByLabel('Budget per night').fill('1250.505')
    await dialog.getByRole('button', { name: 'Send answers' }).click()

    await expect(dialog).toContainText('Enter an amount in EUR with a point and at most 2 decimals')
    await expect(dialog.getByLabel('Budget per night')).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByText(/answers need attention/u)).toBeVisible()
    // The first field with a problem takes focus: the stay is required and empty.
    await expect(dialog.getByLabel('From')).toBeFocused()
    expect((await viewOf(gateway, id)).refusals).toEqual([])
    expect((await viewOf(gateway, id)).open).toBe(true)
  })

  test('shows the gateway’s refusal next to its field, keeps the sheet and what was typed, and takes the fix', async ({
    app,
    gateway,
    page
  }) => {
    // The answer leaves with an amount of three decimals: the page's own check would never send one, so this is the
    // case of a page and a gateway that disagree. Once.
    let tampered = false

    await page.routeWebSocket(/.*/u, ws => {
      const server = ws.connectToServer()

      server.onMessage(message => ws.send(message))
      ws.onMessage(message => {
        if (!tampered && typeof message === 'string' && message.includes('"request.answer"')) {
          const frame = JSON.parse(message) as { params?: { result?: { values?: Record<string, unknown> } } }

          if (frame.params?.result?.values?.budget !== undefined) {
            tampered = true
            frame.params.result.values.budget = '1250.505'
            server.send(`${JSON.stringify(frame)}${message.endsWith('\n') ? '\n' : ''}`)

            return
          }
        }

        server.send(message)
      })
    })
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.form', FORM)
    const dialog = app.dialog

    await dialog.getByLabel('Name on the booking').fill('Ada Lovelace')
    await dialog.getByLabel('From').fill('2026-11-14')
    await dialog.getByLabel('To').fill('2026-11-16')
    await dialog.getByLabel('Budget per night').fill('1250.50')

    const guests = await dialog.getByLabel('Guests').elementHandle()

    await dialog.getByRole('button', { name: 'Send answers' }).click()

    // The gateway's reason, as the contract gives it, and the sheet's words for it next to the field.
    await expect.poll(async () => (await viewOf(gateway, id)).refusals).toEqual(['field:budget:format'])
    await expect(dialog).toContainText('Enter an amount in EUR with a point and at most 2 decimals')
    await expect(dialog.getByLabel('Budget per night')).toHaveAttribute('aria-invalid', 'true')
    await expect(dialog.getByLabel('Budget per night')).toBeFocused()
    expect((await viewOf(gateway, id)).open).toBe(true)

    // The same sheet, the same inputs, everything still typed in.
    expect(await guests?.evaluate(element => element.isConnected)).toBe(true)
    await expect(dialog.getByLabel('Name on the booking')).toHaveValue('Ada Lovelace')
    await expect(dialog.getByLabel('Guests')).toHaveValue('2')
    await expect(dialog.getByLabel('From')).toHaveValue('2026-11-14')

    // Fixed, and accepted.
    await dialog.getByLabel('Budget per night').fill('1250.55')
    await expect(dialog.getByLabel('Budget per night')).not.toHaveAttribute('aria-invalid', 'true')
    await dialog.getByRole('button', { name: 'Send answers' }).click()

    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).outcome).toBe('answered')
    expect(((await viewOf(gateway, id)).answer?.values as Record<string, unknown>).budget).toBe('1250.55')
  })

  test('is skipped when the request is optional', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.form', FORM)

    await app.dialog.getByRole('button', { name: 'Skip' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).answer).toEqual({ status: 'skipped' })
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Skipped')
  })
})

test.describe('a file request', () => {
  test('uploads the file directly into the request’s directory and answers with its path, size and SHA-256', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.file', {
      title: 'Receipt',
      summary: 'Send me the parking receipt.',
      accept: 'document',
      multiple: true,
      upload: UPLOAD
    })
    const dialog = app.dialog
    const body = Buffer.from('parking: 4,50 EUR\n')

    await expect(dialog).toHaveAccessibleName('Files to upload')
    await expect(dialog).toContainText(DIR)
    await dialog
      .locator('[data-file-picker]')
      .setInputFiles({ name: 'receipt.txt', mimeType: 'text/plain', buffer: body })
    await expect(dialog.getByRole('list', { name: 'Files to upload' })).toContainText('receipt.txt')
    await dialog.getByRole('button', { name: 'Upload and send' }).click()

    await expect(dialog).toHaveCount(0)

    const [upload] = await filesOf(gateway)

    // Flat in the request's directory, with a 16 hex digit token and the file's name.
    expect(upload?.path).toMatch(new RegExp(`^${DIR}/[0-9a-f]{16}-receipt\\.txt$`, 'u'))
    expect(upload).toMatchObject({ name: 'receipt.txt', bytes: body.length, sha256: sha(body) })

    await expect
      .poll(async () => (await viewOf(gateway, id)).answer)
      .toEqual({
        status: 'answered',
        files: [{ path: upload?.path, name: 'receipt.txt', mime: 'text/plain', bytes: body.length, sha256: sha(body) }]
      })
    expect((await viewOf(gateway, id)).outcome).toBe('answered')
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('1 file sent')
  })

  test('takes several files, and holds them to the request’s limits before any upload', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    await raise(gateway, 'input.file', {
      accept: 'any',
      multiple: true,
      upload: { ...UPLOAD, max_bytes: 100, max_total_bytes: 150 }
    })

    const dialog = app.dialog

    await dialog.locator('[data-file-picker]').setInputFiles([
      { name: 'big.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(101, 1) },
      { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.alloc(90, 97) },
      { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.alloc(90, 98) }
    ])

    await expect(dialog.getByRole('alert')).toContainText('big.bin is larger than 100B and was not added.')
    await expect(dialog.getByRole('alert')).toContainText('Together the files may be at most 150B.')
    await expect(dialog.getByRole('list', { name: 'Files to upload' }).getByRole('listitem')).toHaveCount(1)
    expect(await filesOf(gateway)).toEqual([])
  })

  test('strips the metadata of a JPEG before it goes up, and previews it', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    // A real JPEG, with an EXIF segment that holds a GPS reading, inserted after its start marker.
    const base64 = await page.evaluate(async () => {
      const canvas = document.createElement('canvas')

      canvas.width = 64
      canvas.height = 48

      const context = canvas.getContext('2d') as CanvasRenderingContext2D

      context.fillStyle = '#cc3333'
      context.fillRect(0, 0, 64, 48)
      context.fillStyle = '#3399ff'
      context.fillRect(8, 8, 24, 24)

      const blob = await new Promise<Blob>(resolve =>
        canvas.toBlob(result => resolve(result as Blob), 'image/jpeg', 0.9)
      )
      const bytes = new Uint8Array(await blob.arrayBuffer())

      return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
    })
    const plain = Buffer.from(base64, 'base64')
    const payload = Buffer.from('Exif\0\0GPSLatitude=52.3702 GPSLongitude=4.8952 GPSMARKER-0451')
    const segment = Buffer.concat([
      Buffer.from([0xff, 0xe1, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]),
      payload
    ])
    const photo = Buffer.concat([plain.subarray(0, 2), segment, plain.subarray(2)])

    expect(photo.includes('GPSMARKER-0451')).toBe(true)

    const sent: Buffer[] = []

    await page.route('**/api/files/upload-stream', async route => {
      sent.push(route.request().postDataBuffer() ?? Buffer.alloc(0))
      await route.continue()
    })

    const id = await raise(gateway, 'input.file', {
      accept: 'image',
      capture: 'photo',
      multiple: false,
      upload: { ...UPLOAD, strip_metadata: true }
    })
    const dialog = app.dialog

    await expect(dialog).toContainText('Location and camera details are removed from pictures before they go.')
    await dialog
      .locator('[data-file-picker]')
      .setInputFiles({ name: 'receipt.jpg', mimeType: 'image/jpeg', buffer: photo })
    await expect(dialog.getByRole('img', { name: 'Preview of receipt.jpg' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Upload and send' }).click()

    await expect(dialog).toHaveCount(0)
    await expect.poll(async () => (await viewOf(gateway, id)).outcome).toBe('answered')

    const [upload] = await filesOf(gateway)

    expect(sent).toHaveLength(1)
    // What went over the wire is a JPEG without the segment, and what the answer quotes is that.
    expect(sent[0]?.includes('GPSMARKER-0451')).toBe(false)
    expect(sent[0]?.includes('Exif')).toBe(false)
    // A JPEG still: it starts with its marker and is not the file that was picked.
    expect(sent[0]?.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true)
    expect(upload?.sha256).not.toBe(sha(photo))

    const files = (await viewOf(gateway, id)).answer?.files as Upload[]

    expect(files).toEqual([
      { path: upload?.path, name: 'receipt.jpg', mime: 'image/jpeg', bytes: upload?.bytes, sha256: upload?.sha256 }
    ])
  })

  test('says a failed upload first, and giving up is 4041 upload_failed', async ({
    app,
    gateway,
    page,
    diagnostics
  }) => {
    diagnostics.allow(/Failed to load resource/u)
    await page.route('**/api/files/upload-stream', route => route.fulfill({ status: 500, body: 'no' }))
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.file', { accept: 'any', multiple: false, upload: UPLOAD })
    const dialog = app.dialog

    await dialog
      .locator('[data-file-picker]')
      .setInputFiles({ name: 'receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
    await dialog.getByRole('button', { name: 'Upload and send' }).click()

    await expect(dialog.getByRole('alert')).toContainText('receipt.txt could not be uploaded.')
    // Nothing was said to the bot yet.
    expect((await viewOf(gateway, id)).open).toBe(true)

    await dialog.getByRole('button', { name: 'Give up' }).click()

    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => {
        const view = await viewOf(gateway, id)

        return [view.outcome, view.error?.code, view.error?.message, view.error?.data?.reason]
      })
      .toEqual(['unavailable', 4041, 'cannot_show', 'upload_failed'])
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Could not be shown here')
  })

  test('is skipped when the request is optional', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'input.file', { upload: UPLOAD })

    await app.dialog.getByRole('button', { name: 'Skip' }).click()

    await expect.poll(async () => (await viewOf(gateway, id)).answer).toEqual({ status: 'skipped' })
  })
})

test.describe('a draft to review', () => {
  test('is approved as it is', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.draft', DRAFT)
    const dialog = app.dialog

    await expect(dialog).toHaveAccessibleName('A mail to review')
    await expect(dialog.getByLabel('Draft')).toHaveValue(DRAFT.text)
    await expect(dialog).toContainText('Re: lunch')
    await expect(dialog).toContainText('bram@example.test')
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click()

    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await viewOf(gateway, id)).answer)
      .toMatchObject({ decision: 'approved', text: DRAFT.text })
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Approved')
  })

  test('is approved with changes, the original beside it, and the gateway knows it was edited', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.draft', DRAFT)
    const dialog = app.dialog

    await dialog.getByLabel('Draft').fill('Hi Bram,\n\nFriday works better.\n\nAda')
    await expect(dialog.getByText('The original from the bot')).toBeVisible()
    await expect(dialog).toContainText('Thursday works.')
    await dialog.getByRole('button', { name: 'Approve with changes' }).click()

    await expect(dialog).toHaveCount(0)
    await expect
      .poll(async () => (await viewOf(gateway, id)).answer)
      .toMatchObject({
        decision: 'approved',
        text: 'Hi Bram,\n\nFriday works better.\n\nAda',
        edited: true
      })
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Approved with changes')
  })

  test('is rejected with a comment', async ({ app, gateway }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.draft', DRAFT)

    await app.dialog.getByLabel('Reason for rejecting (optional)').fill('Too informal for Bram.')
    await app.dialog.getByRole('button', { name: 'Reject' }).click()

    await expect(app.dialog).toHaveCount(0)
    await expect
      .poll(async () => (await viewOf(gateway, id)).answer)
      .toEqual({
        decision: 'rejected',
        comment: 'Too informal for Bram.'
      })
    await expect(app.transcript.locator('article[data-kind="request"]')).toContainText('Rejected')
  })

  test('shows the text as characters, and holds the approval back for what cannot be seen', async ({
    app,
    gateway
  }) => {
    await app.open()
    await app.ready()

    const id = await raise(gateway, 'review.draft', {
      ...DRAFT,
      text: '# Title\n\n**bold** [link](https://evil.test)',
      editable: false
    })
    const dialog = app.dialog

    await expect(dialog.locator('[data-draft-text]')).toHaveText('# Title\n\n**bold** [link](https://evil.test)')
    await expect(dialog.getByRole('link')).toHaveCount(0)
    await dialog.getByRole('button', { name: 'Reject' }).click()
    await expect.poll(async () => (await viewOf(gateway, id)).outcome).toBe('answered')

    const second = await raise(gateway, 'review.draft', DRAFT)

    await expect(dialog.locator('[data-draft-editor]')).toBeVisible()
    await dialog.getByLabel('Draft').fill(`Pay ${String.fromCodePoint(0x202e)}txt.exe now`)
    await expect(dialog).toContainText('The text holds 1 character that you cannot see')
    await expect(dialog.getByText('Pay [U+202E]txt.exe now')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Approve with changes' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Remove them' }).click()
    await expect(dialog.getByLabel('Draft')).toHaveValue('Pay txt.exe now')
    await dialog.getByRole('button', { name: 'Approve with changes' }).click()

    await expect
      .poll(async () => (await viewOf(gateway, second)).answer)
      .toMatchObject({
        decision: 'approved',
        text: 'Pay txt.exe now',
        edited: true
      })
  })
})

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`axe in the ${scheme} scheme`, () => {
    test.beforeEach(async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme })
    })

    test('a form, a file request and a draft have no serious violation, contrast included', async ({
      app,
      gateway,
      page
    }) => {
      await app.open()
      await app.ready()

      await raise(gateway, 'input.form', { ...FORM, detail: 'Open invoices: 2026-041' })
      await expect(app.dialog).toHaveAccessibleName('A form to fill in')
      await expect(app.dialog.getByRole('button', { name: 'Send answers' })).toBeEnabled()
      expect(await seriousViolations(page, `form-${scheme}`)).toEqual([])

      await app.dialog.getByLabel('Budget per night').fill('1250.505')
      await app.dialog.getByRole('button', { name: 'Send answers' }).click()
      await expect(app.dialog).toContainText('answers need attention')
      expect(await seriousViolations(page, `form-problems-${scheme}`)).toEqual([])
      await app.dialog.getByRole('button', { name: 'Skip' }).click()
      await expect(app.dialog).toHaveCount(0)

      await raise(gateway, 'input.file', { accept: 'any', multiple: true, upload: UPLOAD })
      await expect(app.dialog).toHaveAccessibleName('Files to upload')
      await expect(app.dialog.getByRole('button', { name: 'Choose files' })).toBeEnabled()
      await app.dialog
        .locator('[data-file-picker]')
        .setInputFiles({ name: 'receipt.txt', mimeType: 'text/plain', buffer: Buffer.from('x') })
      await expect(app.dialog.getByRole('list', { name: 'Files to upload' })).toBeVisible()
      expect(await seriousViolations(page, `file-${scheme}`)).toEqual([])
      await app.dialog.getByRole('button', { name: 'Skip' }).click()
      await expect(app.dialog).toHaveCount(0)

      await raise(gateway, 'review.draft', DRAFT)
      await expect(app.dialog).toHaveAccessibleName('A mail to review')
      await expect(app.dialog.getByRole('button', { name: 'Reject' })).toBeEnabled()
      expect(await seriousViolations(page, `draft-${scheme}`)).toEqual([])
      await app.dialog.getByLabel('Draft').fill('changed')
      expect(await seriousViolations(page, `draft-changed-${scheme}`)).toEqual([])
    })
  })
}
