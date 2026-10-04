/**
 * Settings, Chat list: every change goes through the layout store's own actions (so the `ui_meta` bridge
 * sends it), reordering works from the keyboard's buttons as well as by dragging a handle, a step hops
 * over archived chats it cannot see, the focus is where the reader left it, and what happened is said in
 * a polite status line.
 */
import { act, cleanup, createEvent, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { botsStore } from '../../state/bots'
import { layoutStore } from '../../state/layout'
import { uiMetaStatusStore } from '../../state/ui-meta-status'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { Arrangement } from './Arrangement'

const NOW = 1_790_000_000

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  seedRoster([aBot('researcher'), aBot('writer'), aBot('ops', { displayName: 'Ops desk' }), aBot('quiet')])
  layoutStore.getState().reconcile(['researcher', 'writer', 'ops', 'quiet'])
})

afterEach(() => {
  cleanup()
  resetActiveLocale()
})

/** The loose and foldered chats in the order the page draws them, by the bot name the row carries. */
const drawn = (list: HTMLElement = screen.getByRole('list', { name: 'Chats and folders' })): string[] =>
  [...list.querySelectorAll<HTMLElement>('li[data-bot], li[data-folder]')].map(
    item => item.dataset.bot ?? `[${item.dataset.folder}]`
  )

const row = (bot: string): HTMLElement => document.querySelector<HTMLElement>(`li[data-bot="${bot}"]`) as HTMLElement
const step = (label: string, name: string) => screen.getByRole('button', { name: `${label} ${name}` })
const status = () => screen.getByRole('status', { hidden: false })

function open(name: string): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: `Actions for ${name}` }))

  return screen.getByRole('group', { name: `Actions for ${name}` })
}

/** A folder's own button is named for the folder, as the catalogue words it. */
const openFolder = (name: string): HTMLElement => open(`the ${name} folder`)

describe('the Chat list page', () => {
  it('lists the chats in the arrangement’s order, by the name the reader would use', () => {
    render(<Arrangement />)

    expect(screen.getByRole('heading', { level: 2, name: 'Chat list' })).toBeTruthy()
    expect(drawn()).toEqual(['researcher', 'writer', 'ops', 'quiet'])
    expect(within(row('ops')).getByText('Ops desk')).toBeTruthy()
  })

  it('uses the name the reader gave a bot over the gateway’s', () => {
    layoutStore.getState().setLabel('writer', 'The Scribe')
    render(<Arrangement />)

    expect(within(row('writer')).getByText('The Scribe')).toBeTruthy()
  })

  it('says there is nothing to arrange when there are no chats', () => {
    botsStore.getState().reset()
    layoutStore.getState().reset()
    render(<Arrangement />)

    expect(screen.getByText('There are no chats to arrange yet.')).toBeTruthy()
    expect(screen.queryByRole('list', { name: 'Chats and folders' })).toBeNull()
  })

  it('lists a bot the roster has and the arrangement does not yet, and does not let it be moved', () => {
    seedRoster([aBot('researcher'), aBot('writer'), aBot('fresh')])
    layoutStore.getState().reset()
    layoutStore.getState().reconcile(['researcher', 'writer'])
    render(<Arrangement />)

    expect(drawn()).toEqual(['researcher', 'writer', 'fresh'])
    expect(step('Move up', 'Fresh').getAttribute('aria-disabled')).toBe('true')
    expect(step('Move down', 'Fresh').getAttribute('aria-disabled')).toBe('true')
  })

  it('says when the arrangement is only kept in this browser', () => {
    render(<Arrangement />)
    expect(document.querySelector('[data-sync]')).toBeNull()

    act(() => uiMetaStatusStore.getState().set('local'))
    expect(document.querySelector('[data-sync="local"]')?.textContent).toContain('kept in this browser only')
  })
})

describe('reordering with the buttons', () => {
  it('moves a chat down and up through the store, and says where it went', () => {
    render(<Arrangement />)

    fireEvent.click(step('Move down', 'Researcher'))
    expect(drawn()).toEqual(['writer', 'researcher', 'ops', 'quiet'])
    expect(layoutStore.getState().entries.map(entry => (entry.kind === 'chat' ? entry.name : ''))).toEqual([
      'writer',
      'researcher',
      'ops',
      'quiet'
    ])
    expect(status().textContent).toBe('Researcher is now at position 2 of 4.')

    fireEvent.click(step('Move up', 'Researcher'))
    expect(drawn()).toEqual(['researcher', 'writer', 'ops', 'quiet'])
    expect(status().textContent).toBe('Researcher is now at position 1 of 4.')
  })

  it('keeps the focus on the button that was pressed, wherever the row went', () => {
    render(<Arrangement />)

    const down = step('Move down', 'Researcher')

    down.focus()
    fireEvent.click(down)

    expect(document.activeElement).toBe(step('Move down', 'Researcher'))
  })

  it('leaves the buttons at the ends in the tab order, marked as unavailable, and does nothing when pressed', () => {
    render(<Arrangement />)

    const up = step('Move up', 'Researcher')
    const last = step('Move down', 'Quiet')

    expect(up.getAttribute('aria-disabled')).toBe('true')
    expect((up as HTMLButtonElement).disabled).toBe(false)
    expect(last.getAttribute('aria-disabled')).toBe('true')
    expect(step('Move down', 'Researcher').getAttribute('aria-disabled')).toBe('false')

    fireEvent.click(up)
    fireEvent.click(last)
    expect(drawn()).toEqual(['researcher', 'writer', 'ops', 'quiet'])
  })

  it('steps over an archived chat it cannot see', () => {
    layoutStore.getState().setArchived('writer', true)
    render(<Arrangement />)

    expect(drawn()).toEqual(['researcher', 'ops', 'quiet'])

    fireEvent.click(step('Move down', 'Researcher'))

    // Researcher took Ops's place among the chats drawn; the archived one is still between them in the store.
    expect(drawn()).toEqual(['ops', 'researcher', 'quiet'])
    expect(status().textContent).toBe('Researcher is now at position 2 of 3.')
  })
})

describe('what a row offers', () => {
  it('keeps everything behind one button per row, until it is asked for', () => {
    render(<Arrangement />)

    const toggle = screen.getByRole('button', { name: 'Actions for Researcher' })

    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('group', { name: 'Actions for Researcher' })).toBeNull()

    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(toggle.getAttribute('aria-controls')).toBe(screen.getByRole('group', { name: 'Actions for Researcher' }).id)

    fireEvent.click(toggle)
    expect(screen.queryByRole('group', { name: 'Actions for Researcher' })).toBeNull()
  })

  it('gives a chat a colour, by name', () => {
    render(<Arrangement />)

    const panel = open('Writer')
    const colour = within(panel).getByRole('combobox', { name: 'Colour' }) as HTMLSelectElement

    expect(
      within(colour)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Default', 'Indigo', 'Violet', 'Magenta', 'Red', 'Orange', 'Teal', 'Green', 'Graphite', 'Slate', 'Lime'])

    fireEvent.change(colour, { target: { value: 'teal' } })

    expect(layoutStore.getState().accents.writer).toBe('teal')
    expect(row('writer').querySelector('.hm-swatch')?.getAttribute('data-accent')).toBe('teal')
  })

  it('mutes for a time, shows until when, and unmutes', () => {
    render(<Arrangement />)

    const select = within(open('Writer')).getByRole('combobox', { name: 'Mute' }) as HTMLSelectElement

    expect(select.value).toBe('off')
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['Off', 'For 1 hour', 'For 8 hours', 'For 1 week', 'Until I turn it back on'])

    fireEvent.change(select, { target: { value: '8h' } })

    const until = layoutStore.getState().mutes.writer

    expect(until).toBeGreaterThan(Math.floor(Date.now() / 1000) + 7 * 3600)
    expect(until).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 8 * 3600 + 1)
    expect(row('writer').querySelector('.hm-arr__badge')?.textContent).toMatch(/^Muted until /u)
    // The line the chat is muted by stays selected, as its own option.
    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)[1]
    ).toMatch(/^Muted until /u)

    fireEvent.change(select, { target: { value: 'off' } })
    expect(layoutStore.getState().mutes.writer).toBeUndefined()
    expect(row('writer').querySelector('.hm-arr__badge')).toBeNull()
  })

  it('mutes for good, which is a deadline that never comes', () => {
    render(<Arrangement />)

    fireEvent.change(within(open('Ops desk')).getByRole('combobox', { name: 'Mute' }), { target: { value: 'forever' } })

    expect(layoutStore.getState().mutes.ops).toBe(0)
    expect(row('ops').querySelector('.hm-arr__badge')?.textContent).toBe('Muted')
  })

  it('shows a mute that is already there, and does not count a lapsed one', () => {
    layoutStore.getState().setMute('writer', NOW)
    layoutStore.getState().setMute('quiet', 0)
    render(<Arrangement />)

    expect(row('writer').querySelector('.hm-arr__badge')).toBeNull()
    expect(row('quiet').querySelector('.hm-arr__badge')?.textContent).toBe('Muted')
  })

  it('archives a chat, moves it to the archive and says so, with the focus on the archive’s heading', () => {
    render(<Arrangement />)

    fireEvent.click(within(open('Writer')).getByRole('button', { name: 'Archive Writer' }))

    expect(layoutStore.getState().archived).toEqual({ writer: true })
    expect(drawn()).toEqual(['researcher', 'ops', 'quiet'])

    const archived = screen.getByRole('list', { name: 'Archived (1)' })

    expect(drawn(archived)).toEqual(['writer'])
    expect(status().textContent).toBe('Writer is archived.')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Archived (1)' }))
    // The panel that offered it is closed with the row it belonged to.
    expect(screen.queryByRole('group', { name: 'Actions for Writer' })).toBeNull()
  })

  it('offers an archived chat its colour, mute and the way back, and no moves', () => {
    layoutStore.getState().setArchived('writer', true)
    render(<Arrangement />)

    expect(screen.queryByRole('button', { name: /^Move (up|down) Writer/u })).toBeNull()

    const panel = open('Writer')

    expect(within(panel).getByRole('combobox', { name: 'Colour' })).toBeTruthy()
    expect(within(panel).getByRole('combobox', { name: 'Mute' })).toBeTruthy()
    expect(within(panel).queryByRole('combobox', { name: 'Move to folder' })).toBeNull()

    fireEvent.click(within(panel).getByRole('button', { name: 'Unarchive Writer' }))

    expect(layoutStore.getState().archived).toEqual({})
    expect(drawn()).toContain('writer')
    expect(screen.queryByRole('heading', { level: 3, name: /^Archived/u })).toBeNull()
    expect(status().textContent).toBe('Writer is out of the archive.')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Chats and folders' }))
  })
})

describe('folders', () => {
  const newFolder = (name: string) => {
    const group = screen.getByRole('group', { name: 'New folder' })

    fireEvent.change(within(group).getByRole('textbox', { name: 'Folder name' }), { target: { value: name } })
    fireEvent.click(within(group).getByRole('button', { name: 'New folder' }))
  }

  it('makes one, empty, at the end, and says so', () => {
    render(<Arrangement />)
    newFolder('  Work  ')

    expect(layoutStore.getState().folders.map(folder => folder.name)).toEqual(['Work'])
    expect(drawn()).toEqual(['researcher', 'writer', 'ops', 'quiet', `[${layoutStore.getState().folders[0]?.id}]`])
    expect(screen.getByText('No chats in this folder')).toBeTruthy()
    expect(status().textContent).toBe('Folder Work created.')
    expect((screen.getByRole('textbox', { name: 'Folder name' }) as HTMLInputElement).value).toBe('')
  })

  it('makes one on Enter in the name field, and calls an unnamed one untitled', () => {
    render(<Arrangement />)

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Folder name' }), { key: 'Enter' })

    expect(layoutStore.getState().folders).toHaveLength(1)
    expect(status().textContent).toBe('Folder Untitled folder created.')
  })

  it('moves a chat into a folder from its own panel, and out again', () => {
    render(<Arrangement />)
    newFolder('Work')

    const folder = layoutStore.getState().folders[0]!.id
    const select = within(open('Writer')).getByRole('combobox', { name: 'Move to folder' }) as HTMLSelectElement

    expect(
      within(select)
        .getAllByRole('option')
        .map(option => option.textContent)
    ).toEqual(['No folder', 'Work'])

    fireEvent.change(select, { target: { value: folder } })

    expect(layoutStore.getState().folders[0]?.bots).toEqual(['writer'])
    expect(drawn()).toEqual(['researcher', 'ops', 'quiet', `[${folder}]`, 'writer'])
    expect(
      within(document.querySelector(`li[data-folder="${folder}"]`) as HTMLElement)
        .getByRole('list', { name: 'Chats in Work' })
        .querySelector('li')?.dataset.bot
    ).toBe('writer')
    expect(status().textContent).toBe('Writer is now in Work.')

    fireEvent.change(
      within(screen.getByRole('group', { name: 'Actions for Writer' })).getByRole('combobox', {
        name: 'Move to folder'
      }),
      { target: { value: '' } }
    )

    expect(layoutStore.getState().folders[0]?.bots).toEqual([])
    expect(status().textContent).toBe('Writer is now in No folder.')
  })

  it('moves among the chats of a folder, and not out of it', () => {
    render(<Arrangement />)
    newFolder('Work')

    const folder = layoutStore.getState().folders[0]!.id

    layoutStore.getState().moveToFolder('writer', folder)
    layoutStore.getState().moveToFolder('ops', folder)
    render(<></>)
    cleanup()
    render(<Arrangement />)

    expect(step('Move up', 'Writer').getAttribute('aria-disabled')).toBe('true')
    expect(step('Move down', 'Ops desk').getAttribute('aria-disabled')).toBe('true')

    fireEvent.click(step('Move down', 'Writer'))

    expect(layoutStore.getState().folders[0]?.bots).toEqual(['ops', 'writer'])
    expect(status().textContent).toBe('Writer is now at position 2 of 2.')
  })

  it('moves a folder among the top level, and names, colours and deletes it from its panel', () => {
    render(<Arrangement />)
    newFolder('Work')

    const folder = layoutStore.getState().folders[0]!.id

    fireEvent.click(step('Move up', 'Work'))
    expect(layoutStore.getState().entries.map(entry => (entry.kind === 'folder' ? 'folder' : entry.name))).toEqual([
      'researcher',
      'writer',
      'ops',
      'folder',
      'quiet'
    ])
    expect(status().textContent).toBe('Work is now at position 4 of 5.')

    const panel = openFolder('Work')
    const name = within(panel).getByRole('textbox', { name: 'Folder name' }) as HTMLInputElement

    expect(panel.getAttribute('aria-label')).toBe('Actions for the Work folder')
    fireEvent.change(name, { target: { value: 'Projects' } })
    // Not written until the reader is done typing: a rename is one write, not one per key.
    expect(layoutStore.getState().folders[0]?.name).toBe('Work')
    fireEvent.blur(name)
    expect(layoutStore.getState().folders[0]?.name).toBe('Projects')

    fireEvent.change(within(panel).getByRole('combobox', { name: 'Folder colour' }), { target: { value: 'violet' } })
    expect(layoutStore.getState().folders[0]?.colour).toBe('violet')

    layoutStore.getState().moveToFolder('writer', folder)
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Actions for the Projects folder' })).getByRole('button', {
        name: 'Delete folder Projects'
      })
    )

    expect(layoutStore.getState().folders).toEqual([])
    expect(drawn()).toContain('writer')
    expect(status().textContent).toBe('Folder Projects deleted. Its chats are back in the list.')
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 3, name: 'Chats and folders' }))
  })

  it('commits a rename on Enter', () => {
    render(<Arrangement />)
    newFolder('Work')

    const name = within(openFolder('Work')).getByRole('textbox', { name: 'Folder name' })

    fireEvent.change(name, { target: { value: 'Play' } })
    fireEvent.keyDown(name, { key: 'Enter' })

    expect(layoutStore.getState().folders[0]?.name).toBe('Play')
  })

  it('draws a folder’s chats under it, without the archived ones', () => {
    render(<Arrangement />)
    newFolder('Work')

    const folder = layoutStore.getState().folders[0]!.id

    layoutStore.getState().moveToFolder('writer', folder)
    layoutStore.getState().moveToFolder('ops', folder)
    layoutStore.getState().setArchived('ops', true)
    cleanup()
    render(<Arrangement />)

    const members = screen.getByRole('list', { name: 'Chats in Work' })

    expect(drawn(members)).toEqual(['writer'])
    expect(drawn(screen.getByRole('list', { name: 'Archived (1)' }))).toEqual(['ops'])
  })
})

describe('dragging a handle', () => {
  /** Give a row a box, as jsdom has none: 100px tall, `top` from the top of the page. */
  const box = (element: Element, top: number) =>
    Object.defineProperty(element, 'getBoundingClientRect', {
      value: () => ({
        top,
        height: 100,
        bottom: top + 100,
        left: 0,
        right: 100,
        width: 100,
        x: 0,
        y: top,
        toJSON: () => ({})
      })
    })

  const transfer = () => ({
    effectAllowed: '',
    dropEffect: '',
    setData: () => undefined,
    setDragImage: () => undefined
  })

  /** jsdom builds a drag event without pointer coordinates: the position is put on it by hand. */
  const dragAt = (type: 'dragOver' | 'drop', target: Element, clientY: number): Event => {
    const event = createEvent[type](target, { dataTransfer: transfer() })

    Object.defineProperty(event, 'clientY', { value: clientY })
    fireEvent(target, event)

    return event
  }

  const grip = (bot: string) => row(bot).querySelector('.hm-arr__grip') as HTMLElement
  const rowOf = (bot: string) => row(bot).querySelector('.hm-arr__row') as HTMLElement

  it('has a handle that is draggable and hidden from assistive technology, whose job the buttons do', () => {
    render(<Arrangement />)

    expect(grip('writer').getAttribute('draggable')).toBe('true')
    expect(grip('writer').getAttribute('aria-hidden')).toBe('true')
    expect(
      screen.getByText(/Drag a row by its handle to reorder it, or use its Move up and Move down buttons\./u)
    ).toBeTruthy()
  })

  it('drops a chat below another when the pointer is in its lower half, and above it in the upper', () => {
    render(<Arrangement />)
    box(rowOf('ops'), 100)

    fireEvent.dragStart(grip('researcher'), { dataTransfer: transfer() })
    expect(row('researcher').getAttribute('data-dragging')).toBe('true')

    dragAt('dragOver', rowOf('ops'), 180)
    expect(rowOf('ops').getAttribute('data-mark')).toBe('after')

    dragAt('dragOver', rowOf('ops'), 120)
    expect(rowOf('ops').getAttribute('data-mark')).toBe('before')

    dragAt('dragOver', rowOf('ops'), 180)
    const drop = dragAt('drop', rowOf('ops'), 180)

    expect(drop.defaultPrevented).toBe(true)
    expect(drawn()).toEqual(['writer', 'ops', 'researcher', 'quiet'])
    expect(row('researcher').getAttribute('data-dragging')).toBeNull()
    expect(rowOf('ops').getAttribute('data-mark')).toBeNull()
    expect(status().textContent).toBe('Researcher is now at position 3 of 4.')
  })

  it('goes above the row it is dropped on when the pointer is in its upper half', () => {
    render(<Arrangement />)
    box(rowOf('ops'), 100)

    fireEvent.dragStart(grip('quiet'), { dataTransfer: transfer() })
    dragAt('drop', rowOf('ops'), 110)

    expect(drawn()).toEqual(['researcher', 'writer', 'quiet', 'ops'])
  })

  it('draws no drop line, and takes no drop, where it would change nothing', () => {
    render(<Arrangement />)
    box(rowOf('writer'), 100)

    fireEvent.dragStart(grip('researcher'), { dataTransfer: transfer() })

    // Before Writer is where Researcher already is.
    const over = dragAt('dragOver', rowOf('writer'), 120)

    expect(over.defaultPrevented).toBe(false)
    expect(rowOf('writer').getAttribute('data-mark')).toBeNull()

    dragAt('drop', rowOf('writer'), 120)
    expect(drawn()).toEqual(['researcher', 'writer', 'ops', 'quiet'])
  })

  it('lets go cleanly when the drag ends elsewhere, and ignores a drop that is not of this page’s making', () => {
    render(<Arrangement />)

    fireEvent.dragStart(grip('researcher'), { dataTransfer: transfer() })
    fireEvent.dragEnd(grip('researcher'), { dataTransfer: transfer() })
    expect(row('researcher').getAttribute('data-dragging')).toBeNull()

    // A file dragged in from the desktop is no row.
    const drop = createEvent.drop(rowOf('writer'), { dataTransfer: transfer() })

    fireEvent(rowOf('writer'), drop)
    expect(drop.defaultPrevented).toBe(false)
    expect(drawn()).toEqual(['researcher', 'writer', 'ops', 'quiet'])
  })

  it('drops a chat on a folder to put it at the end of it', () => {
    render(<Arrangement />)

    const group = screen.getByRole('group', { name: 'New folder' })

    fireEvent.change(within(group).getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Work' } })
    fireEvent.click(within(group).getByRole('button', { name: 'New folder' }))

    const folder = layoutStore.getState().folders[0]!.id
    const header = document.querySelector(`li[data-folder="${folder}"] > .hm-arr__row`) as HTMLElement

    box(header, 400)
    fireEvent.dragStart(grip('writer'), { dataTransfer: transfer() })
    dragAt('dragOver', header, 450)
    dragAt('drop', header, 450)

    expect(layoutStore.getState().folders[0]?.bots).toEqual(['writer'])
    expect(status().textContent).toBe('Writer is now in Work.')
  })

  it('moves a folder by its handle among the top level', () => {
    render(<Arrangement />)

    const group = screen.getByRole('group', { name: 'New folder' })

    fireEvent.change(within(group).getByRole('textbox', { name: 'Folder name' }), { target: { value: 'Work' } })
    fireEvent.click(within(group).getByRole('button', { name: 'New folder' }))

    const folder = layoutStore.getState().folders[0]!.id
    const folderGrip = document.querySelector(`li[data-folder="${folder}"] > .hm-arr__row .hm-arr__grip`) as HTMLElement

    box(rowOf('researcher'), 0)
    fireEvent.dragStart(folderGrip, { dataTransfer: transfer() })
    dragAt('dragOver', rowOf('researcher'), 10)
    dragAt('drop', rowOf('researcher'), 10)

    expect(layoutStore.getState().entries[0]).toEqual({ kind: 'folder', id: folder })
    expect(status().textContent).toBe('Work is now at position 1 of 5.')
  })
})
