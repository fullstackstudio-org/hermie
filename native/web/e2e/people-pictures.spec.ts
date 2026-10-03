/**
 * The pictures of the people in a shared chat, in a real browser, against the fake gateway serving the
 * built client.
 *
 *  - **A colleague's turn** has their picture beside the bubble, fetched through the gateway's
 *    authenticated route by the id the row carries; a colleague the gateway holds no picture of keeps
 *    the initial circle; a picture is asked for once.
 *  - **The reader's own** picture is in the sidebar's foot, where their name is.
 *  - **Both are decoration**: the name is beside them in text, and no image is announced.
 */
import { deflateSync, crc32 } from 'node:zlib'

import { BOT, expect, test } from './fixtures'

/** A square PNG of one colour, so the page has something it can tell apart without a fixture file. */
function solidPng(red: number, green: number, blue: number, size = 32): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const head = Buffer.alloc(8)

    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')

    const crc = Buffer.alloc(4)

    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])) >>> 0, 0)

    return Buffer.concat([head, data, crc])
  }
  const header = Buffer.alloc(13)

  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 2

  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.from(Array.from({ length: size }, () => [red, green, blue]).flat())
  ])
  const raw = Buffer.concat(Array.from({ length: size }, () => row))

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ]).toString('base64')
}

const DANA = 'authentik:dana'
const LEE = 'authentik:lee'

test.describe('the people’s pictures', () => {
  test.use({
    gatewayOptions: {
      perMessageAuthor: true,
      accounts: [
        {
          username: 'tester',
          password: 'hunter2',
          userId: 'sam-sub',
          displayName: 'Sam',
          picture: solidPng(40, 120, 220)
        }
      ],
      pictures: { [DANA]: solidPng(220, 60, 60) }
    }
  })

  test.beforeEach(async ({ gateway }) => {
    await gateway.inject({
      user: 'Does this look right to you?',
      assistant: 'Yes.',
      author: { id: DANA, name: 'Dana' }
    })
    await gateway.inject({
      user: 'Same question from me.',
      assistant: 'Still yes.',
      author: { id: DANA, name: 'Dana' }
    })
    await gateway.inject({ user: 'And from over here.', assistant: 'Also yes.', author: { id: LEE, name: 'Lee' } })
  })

  test('draws a colleague’s picture beside their turn, the initial where there is none, and asks once per person', async ({
    app,
    diagnostics,
    gateway,
    page
  }) => {
    // The browser itself logs the 404 for a person the gateway holds no picture of; the page handles it.
    diagnostics.allow(/404/u)
    await app.open(`#/chat/${BOT}`)

    const dana = app.transcript.locator('.hm-msg[data-side="other"]', { hasText: 'Does this look right to you?' })
    const lee = app.transcript.locator('.hm-msg[data-side="other"]', { hasText: 'And from over here.' })

    await expect(dana.locator('.hm-msg__row .hm-avatar__picture')).toBeVisible()
    await expect(dana.locator('.hm-msg__sender')).toHaveText('Dana')
    // The gateway holds none for Lee: the initial stays, and nothing breaks.
    await expect(lee.locator('.hm-msg__row .hm-avatar')).toHaveText('L')
    await expect(lee.locator('img.hm-avatar__picture')).toHaveCount(0)

    const asked = gateway.fake.state.pictureRequests

    // Dana is on two rows and asked for once; Lee is a 404 and asked for once; the reader's own is in the footer.
    expect(asked.filter(id => id === DANA)).toHaveLength(1)
    expect(asked.filter(id => id === LEE)).toHaveLength(1)

    // The picture is the one the gateway served, drawn from bytes: no address of the identity provider anywhere.
    const source = await dana.locator('.hm-avatar__picture').first().getAttribute('src')

    expect(source?.startsWith('data:image/png;base64,')).toBe(true)

    // Decoration: the name is beside it in text, so no image is announced.
    await expect(dana.getByRole('img')).toHaveCount(0)
    await expect(page.getByRole('log').getByRole('img')).toHaveCount(0)
  })

  test('shows the reader’s own picture before their name in the sidebar', async ({
    app,
    diagnostics,
    gateway,
    page
  }) => {
    diagnostics.allow(/404/u)
    await app.open(`#/chat/${BOT}`)

    const person = page.locator('.hm-sidebar__person')

    await expect(person.locator('.hm-avatar__picture')).toBeVisible()
    await expect(person).toContainText('Sam')
    expect(gateway.fake.state.pictureRequests).toContain('self-hosted:sam-sub')
  })
})
