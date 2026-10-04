/**
 * A chat row's menu and a bot's profile page, in a real browser against the fake gateway serving the built
 * client.
 *
 *  - **The row menu.** A button on every row (and a right click, and Shift+F10 on the focused row) opens a menu
 *    with Mark as read, Edit profile, Pin, Mute, Move to folder, Colour and Archive; each does what Settings,
 *    Chat list does, through the same store, and survives a reload; the keyboard walks it and gives the focus back.
 *  - **The profile page.** Reached from the menu, the chat's header and the bot's name above the chat. The
 *    description waits for Save and is the gateway's afterwards; the picture is prepared in the page and
 *    written with `profiles.set_asset` (and taken away again); the name and colour are the reader's own; the
 *    capability switches write at once (`profiles.configure`), and the gateway's question after an MCP change
 *    is put to the person; a gateway that refuses writes leaves the page read-only.
 *  - **Accessibility** with axe, with the menu open and the page drawn.
 *
 * Names here are the fake gateway's own bots (`researcher`, `writer`), test data and nothing else.
 */
import { deflateSync } from 'node:zlib'

import type { Page } from '@playwright/test'

import { BOT, expect, seriousViolations, test } from './fixtures'

const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Chats' })
const row = (page: Page, bot: string) => sidebar(page).locator(`a[data-bot="${bot}"]`)
const rowButton = (page: Page, name: string) => sidebar(page).getByRole('button', { name: `Actions for ${name}` })
const menu = (page: Page, name: string) => page.getByRole('menu', { name: `Actions for ${name}` })

/** Open the list with its roster read. */
async function openList(app: { open(hash?: string): Promise<void> }, page: Page, hash = '#/'): Promise<void> {
  await app.open(hash)
  await expect(row(page, 'writer')).toBeVisible()
  // The menus' layer is a chunk of its own: until it has arrived the buttons do nothing.
  await expect(sidebar(page).locator('.hm-chat-list')).toHaveAttribute('data-row-menus', 'ready')
}

async function openMenu(page: Page, name: string): Promise<void> {
  await rowButton(page, name).click()
  await expect(menu(page, name)).toBeVisible()
}

/** A real PNG, `width` by `height`, solid colour: what a person would pick, made without a file on disk. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n

    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }

    return c >>> 0
  })
  const crc = (data: Buffer): number => {
    let c = 0xffffffff

    for (const byte of data) {
      c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8)
    }

    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(body.length + 8)

    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)

    return out
  }
  const header = Buffer.alloc(13)

  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // RGB

  const rowBytes = 1 + width * 3
  const raw = Buffer.alloc(rowBytes * height)

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * rowBytes + 1 + x * 3

      raw[at] = (x * 255) / width
      raw[at + 1] = 90
      raw[at + 2] = (y * 255) / height
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

test.describe('The row menu', () => {
  test('pins, mutes and colours a chat from its button, and keeps it through a reload', async ({ app, page }) => {
    await openList(app, page)

    await openMenu(page, 'Writer')
    await expect(page.getByRole('menuitem').first()).toBeFocused()
    await expect(page.getByRole('menuitem')).toHaveText([
      'Mark as read',
      'Edit profile',
      'Pin',
      'Mute',
      'Move to folder',
      'Colour',
      'Archive'
    ])

    await page.getByRole('menuitem', { name: 'Pin' }).click()
    await expect(menu(page, 'Writer')).toHaveCount(0)
    await expect(row(page, 'writer')).toHaveAttribute('data-pinned', 'true')
    await expect(page.getByRole('status').filter({ hasText: 'Writer pinned.' })).toHaveCount(1)
    await expect(rowButton(page, 'Writer')).toBeFocused()
    // Pinned chats lead the list.
    await expect.poll(() => sidebar(page).locator('a[data-bot]').first().getAttribute('data-bot')).toBe('writer')

    await openMenu(page, 'Researcher')
    await page.getByRole('menuitem', { name: 'Mute' }).click()
    await expect(page.getByRole('menuitem', { name: 'Back', exact: true })).toBeFocused()
    await page.getByRole('menuitem', { name: 'For 1 hour' }).click()
    await expect(row(page, 'researcher')).toHaveAttribute('data-muted', 'true')

    await openMenu(page, 'Researcher')
    await expect(page.getByText(/^Muted until \d\d:\d\d$/u)).toBeVisible()
    await page.getByRole('menuitem', { name: 'Colour' }).click()
    await page.getByRole('menuitemradio', { name: 'Teal' }).click()
    await expect(row(page, 'researcher')).toHaveAttribute('data-accent', 'teal')

    // The store is the one Settings, Chat list changes: it is kept, and follows the person.
    await page.reload()
    await expect(row(page, 'writer')).toHaveAttribute('data-pinned', 'true')
    await expect(row(page, 'researcher')).toHaveAttribute('data-muted', 'true')
    await expect(row(page, 'researcher')).toHaveAttribute('data-accent', 'teal')

    await openMenu(page, 'Researcher')
    await page.getByRole('menuitem', { name: 'Unmute' }).click()
    await expect(row(page, 'researcher')).not.toHaveAttribute('data-muted', 'true')
  })

  test('is reached with the keyboard alone: Shift+F10 on the row, the arrows, Return, Escape', async ({
    app,
    page
  }) => {
    await openList(app, page)

    await row(page, 'writer').focus()
    await page.keyboard.press('Shift+F10')
    await expect(menu(page, 'Writer')).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Mark as read' })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(menu(page, 'Writer')).toHaveCount(0)
    await expect(row(page, 'writer')).toBeFocused()

    // Right goes to the row's own button, Return opens its menu.
    await page.keyboard.press('ArrowRight')
    await expect(rowButton(page, 'Writer')).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu(page, 'Writer')).toBeVisible()

    // Down to Pin and Return: pinned, and the focus is back on the button.
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menuitem', { name: 'Pin' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(row(page, 'writer')).toHaveAttribute('data-pinned', 'true')
    await expect(rowButton(page, 'Writer')).toBeFocused()

    // A list: Right opens it, Left goes back to the line it came from.
    await page.keyboard.press('Enter')
    await page.keyboard.press('End')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByRole('menuitem', { name: 'Colour' })).toBeFocused()
    await page.keyboard.press('ArrowRight')
    // A list of choices starts on the one in force.
    await expect(page.getByRole('menuitemradio', { name: 'Default' })).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByRole('menuitem', { name: 'Colour' })).toBeFocused()
    // Escape in a list goes back to the first one; in the first one it closes.
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menuitem', { name: 'Colour' })).toBeFocused()
    await expect(menu(page, 'Writer')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu(page, 'Writer')).toHaveCount(0)
  })

  test('opens on a right click', async ({ app, page }) => {
    await openList(app, page)

    await row(page, 'writer').click({ button: 'right' })

    await expect(menu(page, 'Writer')).toBeVisible()
  })

  test('marks a chat read', async ({ app, page }) => {
    await openList(app, page)
    await expect(row(page, 'writer')).toHaveAttribute('data-unread', 'true')

    await openMenu(page, 'Writer')
    await page.getByRole('menuitem', { name: 'Mark as read' }).click()

    await expect(row(page, 'writer')).toHaveAttribute('data-unread', 'false')

    await openMenu(page, 'Writer')
    await expect(page.getByRole('menuitem', { name: 'Mark as read' })).toHaveAttribute('aria-disabled', 'true')
  })

  test('archives a chat and moves one into a folder made in Settings', async ({ app, page }) => {
    await app.open('#/settings/chat-list')
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Reading')
    await page.keyboard.press('Enter')
    await expect(page.getByRole('status').filter({ hasText: 'Folder Reading created.' })).toBeVisible()
    await page.evaluate(() => {
      location.hash = '#/'
    })
    await expect(row(page, 'writer')).toBeVisible()

    await openMenu(page, 'Writer')
    await page.getByRole('menuitem', { name: 'Move to folder' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'No folder' })).toHaveAttribute('aria-checked', 'true')
    await page.getByRole('menuitemradio', { name: 'Reading' }).click()
    await expect(sidebar(page).getByRole('list', { name: 'Reading' }).locator('a[data-bot="writer"]')).toBeVisible()

    await openMenu(page, 'Researcher')
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await expect(row(page, 'researcher')).toHaveCount(0)
    await expect(sidebar(page).getByRole('button', { name: 'Archived (1)' })).toBeVisible()
    // The row left, and the focus did not go with it.
    await expect.poll(() => page.evaluate(() => document.activeElement?.tagName)).not.toBe('BODY')
  })

  test('has no violations with the menu open, in a list and a view of choices', async ({ app, page }) => {
    await openList(app, page)
    await openMenu(page, 'Writer')
    expect(await seriousViolations(page, 'row-menu')).toEqual([])

    await page.getByRole('menuitem', { name: 'Colour' }).click()
    await expect(page.getByRole('menuitemradio', { name: 'Violet' })).toBeVisible()
    expect(await seriousViolations(page, 'row-menu-colour')).toEqual([])
  })
})

test.describe('The profile page', () => {
  test('opens from the menu, from the chat’s header and from the bot’s name, and leads back to the chat', async ({
    app,
    page
  }) => {
    await openList(app, page, `#/chat/${BOT}`)
    await app.ready()

    await openMenu(page, 'Writer')
    await page.getByRole('menuitem', { name: 'Edit profile' }).click()
    await expect(page).toHaveURL(/#\/chat\/writer\/profile$/u)
    await expect(page.getByRole('heading', { level: 1, name: "Edit Writer's profile" })).toBeFocused()

    await page.getByRole('link', { name: 'Back to chat' }).click()
    await expect(page).toHaveURL(/#\/chat\/writer$/u)

    await page.getByRole('link', { name: 'Profile', exact: true }).click()
    await expect(page).toHaveURL(/#\/chat\/writer\/profile$/u)

    await page.getByRole('link', { name: 'Back to chat' }).click()
    await page.getByRole('heading', { level: 1, name: 'Writer' }).click()
    await expect(page).toHaveURL(/#\/chat\/writer\/profile$/u)
  })

  test('saves the description on the gateway, and shows the gateway’s own facts', async ({ app, gateway, page }) => {
    await app.open(`#/chat/${BOT}/profile`)

    const field = page.getByRole('textbox', { name: 'Description' })

    await expect(field).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
    await field.fill('  Reads slowly and carefully.  ')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByRole('status').filter({ hasText: 'Description saved.' })).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0)
    expect(gateway.fake.state.profiles.find(profile => profile.name === BOT)?.description).toBe(
      'Reads slowly and carefully.'
    )

    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveValue('Reads slowly and carefully.')

    const facts = page.getByRole('region', { name: 'About this bot' })

    await expect(page.getByText('Profile name').locator('..')).toContainText(BOT)
    await expect(facts.getByText('Model', { exact: true })).toBeVisible()
    await expect(facts.getByText('Gateway', { exact: true })).toBeVisible()
  })

  test('names the bot and colours it for this reader, and the list follows', async ({ app, page }) => {
    await app.open(`#/chat/${BOT}/profile`)

    const name = page.getByRole('textbox', { name: /Display name/u })

    await name.fill('The Scribe')
    await name.press('Enter')
    await expect(sidebar(page).locator(`a[data-bot="${BOT}"]`)).toContainText('The Scribe')

    await page.getByRole('radio', { name: 'Violet' }).check()
    await expect(row(page, BOT)).toHaveAttribute('data-accent', 'violet')

    await page.reload()
    await expect(row(page, BOT)).toContainText('The Scribe')
    await expect(page.getByRole('radio', { name: 'Violet' })).toBeChecked()

    // Emptied, it is the bot's own name again.
    await page.getByRole('textbox', { name: /Display name/u }).fill('')
    await page.getByRole('textbox', { name: /Display name/u }).press('Enter')
    await expect(row(page, BOT)).toContainText('Researcher')
  })

  test('changes the picture: prepared in the page, written on the gateway, shown in the list, and taken away again', async ({
    app,
    gateway,
    page
  }) => {
    await app.open(`#/chat/${BOT}/profile`)

    const picture = page.locator('.hm-profile__avatar img')
    const assets = () => [...gateway.fake.state.profileAssets.keys()]

    await expect(picture).toHaveCount(0)
    await page
      .getByTestId('profile-photo-input')
      .setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: png(96, 48) })

    await expect(page.getByRole('status').filter({ hasText: 'Photo changed.' })).toHaveCount(1)
    await expect(picture).toBeVisible()
    expect(assets()).toContain(`${BOT}:avatar`)

    const stored = gateway.fake.state.profileAssets.get(`${BOT}:avatar`)!

    // A JPEG the page drew itself: the original's bytes (and whatever metadata they carried) are not what went.
    expect(stored.mime).toBe('image/jpeg')
    expect(stored.bytes.length).toBeLessThan(2_000_000)

    // The list reads the roster again and draws it.
    await expect(row(page, BOT).locator('img')).toBeVisible()
    await expect(page.getByRole('button', { name: /Change photo/u })).toBeVisible()

    await page.getByRole('button', { name: /Remove photo/u }).click()
    await expect(page.getByRole('status').filter({ hasText: 'Photo removed.' })).toHaveCount(1)
    await expect(picture).toHaveCount(0)
    expect(assets()).not.toContain(`${BOT}:avatar`)
    expect(gateway.fake.state.profiles.find(profile => profile.name === BOT)?.has_avatar).toBe(false)
    await expect(row(page, BOT).locator('img')).toHaveCount(0)
  })

  test('says a file that is not a picture is not one, and sends nothing', async ({ app, gateway, page }) => {
    await app.open(`#/chat/${BOT}/profile`)
    await page
      .getByTestId('profile-photo-input')
      .setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('this is not an image') })

    await expect(page.getByRole('alert')).toContainText('That photo could not be uploaded.')
    expect(gateway.fake.state.profileAssets.size).toBe(0)
  })

  test('switches skills, toolsets and MCP servers on and off, each written at once', async ({ app, gateway, page }) => {
    await app.open(`#/chat/${BOT}/profile`)

    const capabilities = () => gateway.fake.state.profileCapabilities.get(BOT)

    await expect(page.getByRole('checkbox', { name: 'docx' })).toBeChecked()
    await page.getByRole('checkbox', { name: 'docx' }).uncheck()
    await expect.poll(() => capabilities()?.disabledSkills.has('docx')).toBe(true)

    await page.getByRole('checkbox', { name: 'docx' }).check()
    await expect.poll(() => capabilities()?.disabledSkills.has('docx')).toBe(false)

    // A toolset: the first switch pins the whole list.
    const terminal = page.getByRole('checkbox', { name: 'Terminal' })
    const before = await terminal.isChecked()

    await terminal.setChecked(!before)
    await expect.poll(() => capabilities()?.pinnedToolsets?.has('terminal')).toBe(!before)
    await expect(page.getByRole('button', { name: 'Use the gateway’s defaults' })).toBeVisible()

    await page.getByRole('button', { name: 'Use the gateway’s defaults' }).click()
    await expect.poll(() => capabilities()?.pinnedToolsets).toBeNull()
    await expect(page.getByRole('button', { name: 'Use the gateway’s defaults' })).toHaveCount(0)

    // An MCP server: the gateway asks whether to reload running chats, in the app's words.
    const server = gateway.fake.state.mcpServers[0]!.name
    const box = page.getByRole('checkbox', { name: server, exact: true })
    const was = await box.isChecked()

    await box.setChecked(!was)
    await expect.poll(() => capabilities()?.disabledMcpServers.has(server)).toBe(was)

    const prompt = page.getByRole('group', { name: 'Apply to running chats?' })

    await expect(prompt).toBeVisible()
    await expect(prompt.getByRole('button', { name: 'Reload now' })).toBeFocused()
    await prompt.getByRole('button', { name: 'Reload now' }).click()
    await expect(page.getByText('MCP servers reloaded.')).toBeVisible()
    expect(gateway.fake.state.mcpReloads).toBe(1)
  })

  test('is read-only on a gateway that refuses the write, and the name and colour still work', async ({
    app,
    gateway,
    page
  }) => {
    await app.open(`#/chat/${BOT}/profile`)
    await expect(page.getByRole('checkbox', { name: 'docx' })).toBeEnabled()

    const denied = await fetch(`${gateway.url}/__fake/deny`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ methods: ['profiles.configure'], code: 4030, message: 'Read-only account.' })
    })

    expect(denied.ok).toBe(true)

    await page.getByRole('textbox', { name: 'Description' }).fill('Not allowed')
    await page.getByRole('button', { name: 'Save' }).click()

    await expect(page.getByRole('alert')).toContainText('The gateway refused the change: Read-only account.')
    await expect(page.getByText(/may look at this bot and not change it/u)).toBeVisible()
    await expect(page.getByRole('checkbox', { name: 'docx' })).toBeDisabled()
    await expect(page.getByRole('textbox', { name: 'Description' })).toHaveJSProperty('readOnly', true)
    await expect(page.getByRole('button', { name: /Choose a photo|Change photo/u })).toBeDisabled()

    await page.getByRole('radio', { name: 'Red' }).check()
    await expect(row(page, BOT)).toHaveAttribute('data-accent', 'red')
  })

  test('has no violations, with every section drawn', async ({ app, page }) => {
    await app.open(`#/chat/${BOT}/profile`)
    await expect(page.getByRole('checkbox', { name: 'docx' })).toBeVisible()

    expect(await seriousViolations(page, 'profile')).toEqual([])
  })
})
