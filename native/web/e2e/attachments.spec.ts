/**
 * Attachments in the composer, in a real browser, against the fake gateway
 * serving the built client.
 *
 * What it proves (plan W-19):
 *
 *  - **By the picker.** The attach button opens the browser's file dialog; a
 *    picked file is uploaded at once into the session's workspace, its chip
 *    turns ready, and the message that names it reaches the agent: the fake
 *    gateway's reply says it received the file, byte count and path. The sent
 *    bubble carries the file as a chip.
 *  - **By a drop.** Files dragged over the chat light up a visible target with
 *    the words "Drop file to attach"; dropped, a file and an image are staged;
 *    sent with no words, the file is uploaded and the image goes over the
 *    socket (`image.attach_bytes`), and the bubble carries both.
 *  - **Once (HERM-126).** Return pressed twice while the first send is still in
 *    flight sends one message and one upload, not two.
 *  - **Cancel.** A file still uploading can be cancelled; the gateway keeps
 *    nothing of it and the next upload of the same file is the only one stored.
 *  - **axe**, contrast included, with chips in the tray and the drop target open.
 *
 * Nothing waits for time to pass: the page through what it shows, the gateway
 * through its state.
 */
import type { Page } from '@playwright/test'

import { type App, expect, type Gateway, seriousViolations, test } from './fixtures'

const CSV = 'name,score\nada,10\ngrace,12\n'

const tray = (page: Page) => page.getByRole('list', { name: 'Attachments for the next message' })
const sendButton = (page: Page) => page.getByRole('button', { name: /^Send/u })
const userBubbles = (app: App) => app.transcript.locator('.hm-bubble[data-kind="user"]')

/** Pick files through the attach button, as a reader does with the browser's dialog. */
async function pick(page: Page, files: { name: string; mimeType: string; buffer: Buffer }[]): Promise<void> {
  const chooser = page.waitForEvent('filechooser')

  await page.getByRole('button', { name: 'Add attachment' }).click()
  await (await chooser).setFiles(files)
}

/** Drag files over the chat and let go, as the operating system's drag would. */
async function drop(page: Page, files: { name: string; type: string; text: string }[]): Promise<void> {
  const data = await page.evaluateHandle(list => {
    const transfer = new DataTransfer()

    for (const file of list) {
      transfer.items.add(new File([file.text], file.name, { type: file.type }))
    }

    return transfer
  }, files)

  await page.dispatchEvent('.hm-chat', 'dragenter', { dataTransfer: data })
  await page.dispatchEvent('.hm-chat', 'dragover', { dataTransfer: data })
  await expect(page.getByText('Drop file to attach')).toBeVisible()
  await page.dispatchEvent('.hm-chat', 'drop', { dataTransfer: data })
  await expect(page.getByText('Drop file to attach')).toHaveCount(0)
}

const submits = (gateway: Gateway): number =>
  gateway.fake.state.methodLog.filter(method => method === 'prompt.submit').length

test.describe('attachments in the composer', () => {
  test('attaches by the picker, sends, and the agent reads the file', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await pick(page, [{ name: 'scores.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) }])

    const chip = tray(page).getByRole('listitem')

    await expect(chip).toContainText('scores.csv')
    await expect(sendButton(page)).toBeEnabled()
    await expect(sendButton(page)).toHaveAccessibleName('Send message with 1 attachment')

    const [stored] = [...gateway.fake.state.uploadedFiles.values()]

    expect(stored?.path).toMatch(
      /^\/root\/projects\/researcher\/uploads\/hermie\/\d{4}-\d{2}-\d{2}\/[a-z0-9]{8}-scores\.csv$/u
    )
    expect(stored?.bytes).toBe(CSV.length)

    await app.field.fill('what is in it?')
    await app.field.press('Enter')

    await expect(tray(page)).toHaveCount(0)
    await expect(userBubbles(app).last()).toContainText('what is in it?')
    await expect(userBubbles(app).last().getByRole('list', { name: 'Attachments' })).toContainText(/scores\.csv/u)
    await expect(app.transcript).toContainText(`I received scores.csv (${CSV.length} bytes) at ${stored?.path}.`)
  })

  test('attaches a file and an image by a drop, and sends them with no words', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    await drop(page, [
      { name: 'notes.txt', type: 'text/plain', text: 'remember the milk' },
      { name: 'shot.png', type: 'image/png', text: '\u0089PNG\r\n\u001a\n' }
    ])

    await expect(tray(page).getByRole('listitem')).toHaveCount(2)
    await expect(sendButton(page)).toHaveAccessibleName('Send message with 2 attachments')
    await expect(sendButton(page)).toBeEnabled()

    // Nothing typed: the attachments are the message.
    await app.field.press('Enter')

    await expect(tray(page)).toHaveCount(0)

    const files = userBubbles(app).last().getByRole('list', { name: 'Attachments' })

    await expect(files.getByRole('listitem')).toHaveCount(2)
    await expect(files).toContainText(/notes\.txt/u)
    await expect(files).toContainText('shot.png')
    await expect(app.transcript).toContainText('I received notes.txt (17 bytes)')
    expect(gateway.fake.state.attachedImages.map(image => image.filename)).toEqual(['shot.png'])
  })

  test('sends once when Return is pressed twice while the first send is in flight (HERM-126)', async ({
    app,
    gateway,
    page
  }) => {
    await app.open()
    await app.ready()

    const before = await userBubbles(app).count()

    await pick(page, [{ name: 'once.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV) }])
    await expect(sendButton(page)).toBeEnabled()

    await app.field.focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')

    await expect(app.transcript).toContainText('I received once.csv')
    await expect(app.transcript).not.toHaveAttribute('aria-busy', 'true', { timeout: 20_000 })

    expect(submits(gateway)).toBe(1)
    expect(gateway.fake.state.uploadedFiles.size).toBe(1)
    await expect(userBubbles(app)).toHaveCount(before + 1)
    await expect(tray(page)).toHaveCount(0)
  })
})

test.describe('cancelling an upload', () => {
  // Long enough to act on the chip while its upload is still out.
  test.use({ gatewayOptions: { uploadDelayMs: 1500 } })

  test('takes a cancelled upload away and the gateway keeps nothing of it', async ({ app, gateway, page }) => {
    await app.open()
    await app.ready()

    const file = { name: 'big.log', mimeType: 'text/plain', buffer: Buffer.from('x'.repeat(4096)) }

    await pick(page, [file])
    await expect(tray(page)).toContainText('Uploading…')
    await expect(sendButton(page)).toBeDisabled()
    await expect(page.getByText('Send is available once every attachment is ready or removed.')).toBeVisible()

    // The tray and the drop target, through axe in the browser: contrast included.
    await page.dispatchEvent('.hm-chat', 'dragenter', {
      dataTransfer: await page.evaluateHandle(() => {
        const transfer = new DataTransfer()

        transfer.items.add(new File(['a'], 'a.txt', { type: 'text/plain' }))

        return transfer
      })
    })
    await expect(page.getByText('Drop file to attach')).toBeVisible()
    expect(await seriousViolations(page, 'attachments')).toEqual([])
    await page.dispatchEvent('.hm-chat', 'dragend')

    await page.getByRole('button', { name: 'Cancel the upload of big.log' }).click()
    await expect(tray(page)).toHaveCount(0)
    await expect(sendButton(page)).toBeDisabled()

    // The same file again: it is held as long as the first was, so by the time it is ready the first one's
    // answer has long been decided. Only the second may be stored.
    await pick(page, [file])
    await expect(tray(page)).not.toContainText('Uploading…', { timeout: 15_000 })
    await expect(sendButton(page)).toBeEnabled()

    expect(gateway.fake.state.uploadedFiles.size).toBe(1)
  })
})
