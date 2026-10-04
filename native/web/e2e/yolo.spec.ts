/**
 * YOLO mode of a chat, in a real browser against the fake gateway serving the built client.
 *
 * What this proves, end to end: turning it on is a question first and a `config.set` only after
 * the answer yes (the gateway's log shows no write before it); the mark appears in the header from the
 * session's own report; the state lives on the gateway, so a reload finds the mark where it was
 * left; and turning it off is one press on that mark, from the keyboard too, with no question.
 */
import { expect, test } from './fixtures'

const writes = async (state: () => Promise<{ methodLog: unknown[] }>): Promise<number> =>
  (await state()).methodLog.filter(entry => entry === 'config.set').length

test('turns on after a question, shows in the header, survives a reload, and turns off with one press', async ({
  app,
  gateway,
  page
}) => {
  await app.open()
  await app.ready()

  const mark = page.getByRole('button', {
    name: 'YOLO mode is on: approval requests are skipped in this chat. Turn it off'
  })

  await expect(mark).toHaveCount(0)

  // On: the question comes first, and nothing has reached the gateway.
  const before = await writes(() => gateway.state())

  await page.getByRole('button', { name: 'Chat options' }).click()

  const row = page.getByRole('group', { name: 'This conversation' })
  const box = row.getByRole('checkbox', { name: 'YOLO mode' })

  await expect(box).not.toBeChecked()
  await box.click()
  await expect(row.getByText('Approval requests are skipped in this chat until you turn it off.')).toBeVisible()
  await expect(row.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await expect(box).not.toBeChecked()
  expect(await writes(() => gateway.state())).toBe(before)

  // Cancel changes nothing either.
  await row.getByRole('button', { name: 'Cancel' }).click()
  await expect(row.getByRole('button', { name: 'Turn on YOLO mode' })).toHaveCount(0)
  expect(await writes(() => gateway.state())).toBe(before)

  await box.click()
  await row.getByRole('button', { name: 'Turn on YOLO mode' }).click()

  // The mark and the switch both come from the session's report.
  await expect(mark).toBeVisible()
  await expect(mark).toHaveText('YOLO')
  await expect(box).toBeChecked()
  await expect.poll(() => writes(() => gateway.state())).toBe(before + 1)

  // The state is the gateway's: a fresh page finds it on.
  await page.reload()
  await app.ready()
  await expect(mark).toBeVisible()

  // Off: one press on the mark, from the keyboard, and no question.
  await mark.focus()
  await page.keyboard.press('Enter')
  await expect(mark).toHaveCount(0)
  await expect.poll(() => writes(() => gateway.state())).toBe(before + 2)

  await page.reload()
  await app.ready()
  await expect(mark).toHaveCount(0)
  await page.getByRole('button', { name: 'Chat options' }).click()
  await expect(page.getByRole('checkbox', { name: 'YOLO mode' })).not.toBeChecked()
})
