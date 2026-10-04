/**
 * A chat row's menu, as the list wires it: the button on every row, the right click, the context-menu key
 * and Shift+F10, and what each line does through the layout store's own actions: Pin, Mute (and the list of
 * durations), Move to folder, Colour, Archive, Mark as read and Edit profile. Focus goes into the menu, and
 * back where it came from (or to the list's own stop, when the row left the list); a choice is said in a
 * polite status; the open menu passes axe.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { setLanguageChoice } from '../../i18n/locale'
import { createHashRouter } from '../../platform/hash-router'
import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { layoutStore } from '../../state/layout'
import { aBot, LONG_AGO, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatList } from './ChatList'

const NAMES = ['researcher', 'writer', 'ops']

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  connectionStore.getState().setStatus('ready', null)
  seedRoster(NAMES.map(name => aBot(name)))
  layoutStore.getState().reconcile(NAMES)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  resetActiveLocale()
})

const layout = () => layoutStore.getState()
const rowOf = (name: string): HTMLAnchorElement => document.querySelector<HTMLAnchorElement>(`a[data-bot="${name}"]`)!
const buttonOf = (name: string): HTMLElement => screen.getByRole('button', { name: `Actions for ${name}` })
const menu = (name: string): HTMLElement => screen.getByRole('menu', { name: `Actions for ${name}` })
const item = (name: string | RegExp): HTMLElement => within(screen.getByRole('menu')).getByRole('menuitem', { name })

const ready = (): Promise<void> =>
  waitFor(() => expect(document.querySelector('.hm-chat-list')?.getAttribute('data-row-menus')).toBe('ready'))

/** The list with its menu layer loaded (a chunk of its own: until it is, the buttons do nothing). */
async function mount() {
  const router = createHashRouter(null)

  render(<ChatList selectedBot={undefined} router={router} />)
  await ready()

  return router
}

/** Open a row's menu from its button and wait for the chunk. */
async function open(name: string): Promise<void> {
  fireEvent.click(buttonOf(name[0]!.toUpperCase() + name.slice(1)))
  await screen.findByRole('menu')
}

describe('opening it', () => {
  it('is a button on every row, named for the chat, that says it opens a menu', async () => {
    await mount()

    for (const name of ['Researcher', 'Writer', 'Ops']) {
      const button = buttonOf(name)

      expect(button.getAttribute('aria-haspopup')).toBe('menu')
      expect(button.getAttribute('aria-expanded')).toBe('false')
    }
  })

  it('opens from the button on the first line, with the focus in it, and the button says it is open', async () => {
    await mount()
    await open('writer')

    expect(menu('Writer')).toBeTruthy()
    expect(buttonOf('Writer').getAttribute('aria-expanded')).toBe('true')
    expect(document.activeElement).toBe(item('Mark as read'))
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map(line => line.textContent)
    ).toEqual(['Mark as read', 'Edit profile', 'Pin', 'Mute', 'Move to folder', 'Colour', 'Archive'])
  })

  it('opens on a right click, where the pointer is, and not the browser’s own menu', async () => {
    await mount()

    const proceeded = fireEvent.contextMenu(rowOf('writer'), { clientX: 120, clientY: 90 })

    await screen.findByRole('menu')

    expect(proceeded).toBe(false)
    expect(menu('Writer')).toBeTruthy()
  })

  it('leaves the browser’s own menu to a right click with Shift', async () => {
    await mount()

    const proceeded = fireEvent.contextMenu(rowOf('writer'), { shiftKey: true })

    expect(proceeded).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens from the keyboard with the context-menu key and with Shift+F10, once', async () => {
    await mount()
    rowOf('writer').focus()
    fireEvent.keyDown(rowOf('writer'), { key: 'ContextMenu' })
    // The browser may send its own contextmenu event after the key: the same request, not a second one.
    fireEvent.contextMenu(rowOf('writer'))
    await screen.findByRole('menu')
    expect(screen.getAllByRole('menu')).toHaveLength(1)

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(rowOf('writer'))

    fireEvent.keyDown(rowOf('ops'), { key: 'F10', shiftKey: true })
    await screen.findByRole('menu', { name: 'Actions for Ops' })
  })

  it('reaches the row’s button with Right from the row, and comes back with Left', async () => {
    await mount()
    rowOf('writer').focus()

    fireEvent.keyDown(rowOf('writer'), { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttonOf('Writer'))

    fireEvent.keyDown(buttonOf('Writer'), { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(rowOf('writer'))
  })

  it('keeps the buttons out of the tab order: the list is one tab stop', async () => {
    await mount()

    for (const name of ['Researcher', 'Writer', 'Ops']) {
      expect(buttonOf(name).getAttribute('tabindex')).toBe('-1')
    }
  })

  it('closes with the same button, and opens another row’s from its button', async () => {
    await mount()
    await open('writer')
    fireEvent.click(buttonOf('Writer'))
    expect(screen.queryByRole('menu')).toBeNull()

    await open('writer')
    fireEvent.click(buttonOf('Ops'))
    await screen.findByRole('menu', { name: 'Actions for Ops' })
    expect(screen.getAllByRole('menu')).toHaveLength(1)
  })

  it('closes on a press anywhere else', async () => {
    await mount()
    await open('writer')

    fireEvent.pointerDown(document.body)

    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('moving in it', () => {
  it('walks the lines with the arrows, around, and with Home and End', async () => {
    await mount()
    await open('writer')

    fireEvent.keyDown(item('Mark as read'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item('Edit profile'))
    fireEvent.keyDown(item('Edit profile'), { key: 'ArrowUp' })
    fireEvent.keyDown(item('Mark as read'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(item('Archive'))
    fireEvent.keyDown(item('Archive'), { key: 'Home' })
    expect(document.activeElement).toBe(item('Mark as read'))
    fireEvent.keyDown(item('Mark as read'), { key: 'End' })
    expect(document.activeElement).toBe(item('Archive'))
  })

  it('closes with Escape and with Tab and puts the focus back on the button it came from', async () => {
    await mount()
    await open('writer')
    fireEvent.keyDown(item('Mark as read'), { key: 'Escape' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(buttonOf('Writer'))

    await open('writer')
    fireEvent.keyDown(item('Mark as read'), { key: 'Tab' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(buttonOf('Writer'))
  })

  it('does not hand the list’s own arrow keys on: the rows do not move under an open menu', async () => {
    await mount()
    rowOf('researcher').focus()
    await open('writer')

    fireEvent.keyDown(item('Mark as read'), { key: 'ArrowDown' })

    expect(document.activeElement).toBe(item('Edit profile'))
  })
})

describe('what the lines do, through the layout store', () => {
  it('pins, and says so; and the same line then unpins', async () => {
    await mount()
    await open('writer')
    fireEvent.click(item('Pin'))

    expect(layout().pinned.writer).toBe(true)
    expect(screen.queryByRole('menu')).toBeNull()
    expect(rowOf('writer').getAttribute('data-pinned')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Writer pinned.')
    expect(document.activeElement).toBe(buttonOf('Writer'))

    await open('writer')
    fireEvent.click(item('Unpin'))
    expect(layout().pinned.writer).toBeUndefined()
  })

  it('mutes from a list of durations, with a way back, and says when it ends', async () => {
    await mount()
    await open('writer')
    fireEvent.click(item('Mute'))

    // The list takes the place of the first view, under a Back line, with the focus on its first line.
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map(line => line.textContent)
    ).toEqual(['Back', 'For 1 hour', 'For 8 hours', 'For 1 week', 'Until I turn it back on'])
    expect(document.activeElement).toBe(item('Back'))

    fireEvent.keyDown(item('Back'), { key: 'Escape' })
    expect(screen.getByRole('menu')).toBeTruthy()
    // Back to the first view, on the line it came from.
    expect(document.activeElement).toBe(item('Mute'))

    fireEvent.keyDown(item('Mute'), { key: 'ArrowRight' })
    fireEvent.click(item('For 1 hour'))

    const until = layout().mutes.writer!
    const now = Math.floor(Date.now() / 1000)

    expect(until).toBeGreaterThan(now + 3500)
    expect(until).toBeLessThanOrEqual(now + 3601)
    expect(rowOf('writer').getAttribute('data-muted')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Writer muted. For 1 hour.')

    // A muted chat says so in the menu instead, and Unmute is the way out.
    await open('writer')
    expect(within(screen.getByRole('menu')).getByText(/^Muted until/u)).toBeTruthy()
    fireEvent.click(item('Unmute'))
    expect(layout().mutes.writer).toBeUndefined()
  })

  it('mutes for good with 0, the way Settings does', async () => {
    await mount()
    await open('writer')
    fireEvent.click(item('Mute'))
    fireEvent.click(item('Until I turn it back on'))

    expect(layout().mutes.writer).toBe(0)
  })

  it('colours from a list that checks the colour in force', async () => {
    await mount()
    layout().setAccent('writer', 'teal')
    await open('writer')
    fireEvent.click(item('Colour'))

    const teal = within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Teal' })

    expect(teal.getAttribute('aria-checked')).toBe('true')
    expect(within(screen.getByRole('menu')).getAllByRole('menuitemradio')).toHaveLength(11)

    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Violet' }))

    expect(layout().accents.writer).toBe('violet')
    expect(rowOf('writer').getAttribute('data-accent')).toBe('violet')
  })

  it('moves to a folder and out of it again, from a list of the folders', async () => {
    const id = layout().addFolder('Reading')

    await mount()
    await open('writer')
    fireEvent.click(item('Move to folder'))
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitemradio')
        .map(line => line.textContent)
    ).toEqual(['No folder', 'Reading'])
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Reading' }))

    expect(layout().folders.find(folder => folder.id === id)?.bots).toEqual(['writer'])
    expect(screen.getByRole('status').textContent).toBe('Writer is now in Reading.')

    await open('writer')
    fireEvent.click(item('Move to folder'))
    expect(
      within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'Reading' }).getAttribute('aria-checked')
    ).toBe('true')
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: 'No folder' }))

    expect(layout().folders.find(folder => folder.id === id)?.bots).toEqual([])
  })

  it('has a folder line with no folders yet, which offers only No folder and New folder…', async () => {
    await mount()
    await open('writer')
    fireEvent.click(item('Move to folder'))

    expect(
      Array.from(screen.getByRole('menu').querySelectorAll('[role="menuitem"], [role="menuitemradio"]')).map(
        line => line.textContent
      )
    ).toEqual(['Back', 'No folder', 'New folder…'])
  })

  describe('New folder…', () => {
    const openForm = async (name = 'writer'): Promise<HTMLInputElement> => {
      await open(name)
      fireEvent.click(item('Move to folder'))
      fireEvent.click(item('New folder…'))

      return (await screen.findByRole('textbox', { name: 'Folder name' })) as HTMLInputElement
    }

    it('opens a small form in the menu’s own box, with the focus in the name field, and no list of lines', async () => {
      await mount()

      const field = await openForm()

      expect(screen.getByRole('dialog', { name: 'New folder' })).toBeTruthy()
      expect(screen.queryByRole('menu')).toBeNull()
      expect(document.activeElement).toBe(field)
      expect(field.maxLength).toBe(64)
      expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    })

    it('makes a folder holding this chat on Return, says so, and closes', async () => {
      await mount()

      const field = await openForm()

      fireEvent.change(field, { target: { value: '  Reading  ' } })
      fireEvent.keyDown(field, { key: 'Enter' })

      const made = layout().folders.find(folder => folder.name === 'Reading')

      expect(made?.bots).toEqual(['writer'])
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getByRole('status').textContent).toBe('Writer is now in the new folder Reading.')
      // Where every other chat was, it still is.
      expect(layout().folders).toHaveLength(1)
    })

    it('makes it from the Create button too, and an empty name is the unnamed folder, as it is in Settings', async () => {
      await mount()
      await openForm()
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))

      expect(layout().folders).toHaveLength(1)
      expect(layout().folders[0]).toMatchObject({ name: '', bots: ['writer'] })
      expect(screen.getByRole('status').textContent).toBe('Writer is now in the new folder Untitled folder.')
    })

    it('goes back to the folder list on Cancel and on Escape, with the focus on the line that opened it, and makes nothing', async () => {
      await mount()

      const field = await openForm()

      fireEvent.change(field, { target: { value: 'Draft' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(document.activeElement).toBe(item('New folder…'))
      expect(layout().folders).toEqual([])

      fireEvent.click(item('New folder…'))
      fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })
      expect(screen.getByRole('menu')).toBeTruthy()
      expect(document.activeElement).toBe(item('New folder…'))
      expect(layout().folders).toEqual([])
    })

    it('starts empty each time it is opened, not with the last name typed', async () => {
      await mount()

      const field = await openForm()

      fireEvent.change(field, { target: { value: 'Typed' } })
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      fireEvent.click(item('New folder…'))

      expect(((await screen.findByRole('textbox', { name: 'Folder name' })) as HTMLInputElement).value).toBe('')
    })

    it('closes with a press elsewhere, making nothing', async () => {
      await mount()
      await openForm()

      fireEvent.pointerDown(document.body)

      expect(screen.queryByRole('dialog')).toBeNull()
      expect(layout().folders).toEqual([])
    })

    it('keeps the folders that were there, and puts the chat in the new one at the end', async () => {
      layout().addFolder('Work')
      await mount()

      const field = await openForm('ops')

      fireEvent.change(field, { target: { value: 'Later' } })
      fireEvent.keyDown(field, { key: 'Enter' })

      expect(layout().folders.map(folder => [folder.name, folder.bots])).toEqual([
        ['Work', []],
        ['Later', ['ops']]
      ])
    })

    it('says its words in Dutch', async () => {
      await setLanguageChoice('nl')
      await mount()
      fireEvent.click(screen.getByRole('button', { name: 'Acties voor Writer' }))
      await screen.findByRole('menu')
      fireEvent.click(item('Verplaats naar map'))
      fireEvent.click(item('Nieuwe map…'))

      expect(await screen.findByRole('dialog', { name: 'Nieuwe map' })).toBeTruthy()
      expect(screen.getByRole('button', { name: 'Maken' })).toBeTruthy()
    })

    it('passes axe with the form open', async () => {
      await mount()
      await openForm()

      const result = await axe.run(document.documentElement, {
        rules: {
          'color-contrast': { enabled: false },
          'document-title': { enabled: false },
          'html-has-lang': { enabled: false },
          region: { enabled: false },
          'landmark-one-main': { enabled: false },
          'page-has-heading-one': { enabled: false }
        }
      })

      expect(
        result.violations.map(violation => `${violation.id}: ${violation.nodes.map(node => node.html.slice(0, 100))}`)
      ).toEqual([])
    })
  })

  it('archives, and the focus goes to the list’s own stop when the row has left it', async () => {
    await mount()
    await open('writer')
    fireEvent.click(item('Archive'))

    expect(layout().archived.writer).toBe(true)
    expect(rowOf('writer')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Writer is archived.')
    // The row the button belonged to is gone: focus is not lost to the page.
    expect(document.activeElement).toBe(document.querySelector('a[data-bot][tabindex="0"]'))
  })

  it('marks a chat read: the unread mark goes, and the line is off for a chat that has nothing unread', async () => {
    resetShellStores()
    connectionStore.getState().setStatus('ready', null)
    seedRoster(
      NAMES.map(name => aBot(name)),
      { read: false }
    )
    layoutStore.getState().reconcile(NAMES)
    await mount()
    expect(rowOf('writer').getAttribute('data-unread')).toBe('true')

    await open('writer')
    expect(item('Mark as read').getAttribute('aria-disabled')).toBeNull()
    fireEvent.click(item('Mark as read'))

    expect(botsStore.getState().lastSeen.writer).toBeGreaterThanOrEqual(LONG_AGO)
    expect(rowOf('writer').getAttribute('data-unread')).toBe('false')
    expect(rowOf('researcher').getAttribute('data-unread')).toBe('true')
    expect(screen.getByRole('status').textContent).toBe('Writer marked as read.')

    await open('writer')
    expect(item('Mark as read').getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(item('Mark as read'))
    // A line that cannot be chosen does nothing, and the menu stays.
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('opens the bot’s profile from Edit profile, and does not take the focus back from it', async () => {
    const router = await mount()

    await open('writer')
    fireEvent.click(item('Edit profile'))

    expect(router.current()).toBe('#/chat/writer/profile')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('names a chat by what the reader calls it', async () => {
    layout().setLabel('writer', 'The Scribe')
    await mount()

    fireEvent.click(buttonOf('The Scribe'))
    await screen.findByRole('menu', { name: 'Actions for The Scribe' })
  })
})

describe('in another language and for a screen reader', () => {
  it('says its lines in Dutch', async () => {
    await setLanguageChoice('nl')
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Acties voor Writer' }))
    await screen.findByRole('menu')

    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map(line => line.textContent)
    ).toEqual([
      'Markeren als gelezen',
      'Profiel bewerken',
      'Vastzetten',
      'Dempen',
      'Verplaats naar map',
      'Kleur',
      'Archiveren'
    ])
  })

  it('passes axe with the menu open, in a list and a view of choices', async () => {
    await mount()
    await open('writer')

    const check = async (): Promise<string[]> => {
      // The list is drawn alone here, not in the app's frame: the rules about the page (a title, landmarks) are the
      // shell's (`features/shell/shell.axe.test.tsx`), and contrast is measured from the theme.
      const result = await axe.run(document.documentElement, {
        rules: {
          'color-contrast': { enabled: false },
          'document-title': { enabled: false },
          region: { enabled: false }
        }
      })

      return result.violations.map(
        violation =>
          `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.html.slice(0, 160)).join(' | ')})`
      )
    }

    expect(await check()).toEqual([])
    fireEvent.click(item('Colour'))
    await waitFor(() => expect(screen.getAllByRole('menuitemradio').length).toBe(11))
    expect(await check()).toEqual([])
    act(() => undefined)
  })
})
