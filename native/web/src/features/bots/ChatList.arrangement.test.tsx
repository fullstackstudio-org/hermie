/**
 * The sidebar's list draws the chat arrangement the layout store holds (what Settings, Chat list edits):
 * its order, folders as groups with a header that opens and closes, an archive at the bottom that starts
 * closed, a chat's colour, a pin and a mute, a chat the arrangement has not placed yet, and a removed one
 * gone. Everything is read from the stores; the arrow keys cross the groups.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import axe from 'axe-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale } from '../../i18n/active-locale'
import { botsStore } from '../../state/bots'
import { connectionStore } from '../../state/connection'
import { layoutStore } from '../../state/layout'
import { aBot, resetShellStores, seedRoster } from '../../test-support/shell-stores'
import { ChatList } from './ChatList'

const NAMES = ['researcher', 'writer', 'ops', 'quiet']

beforeEach(() => {
  resetShellStores()
  document.documentElement.lang = 'en'
  document.title = 'Hermie'
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
/** Every row on the page, top to bottom. */
const drawn = (): string[] => [...document.querySelectorAll<HTMLElement>('a[data-bot]')].map(link => link.dataset.bot!)
const header = (name: string | RegExp): HTMLElement => screen.getByRole('button', { name })

/** `writer` in a folder called Reading, the others loose. */
function withFolder(): string {
  const id = layout().addFolder('Reading')

  layout().moveToFolder('writer', id)

  return id
}

describe('the order', () => {
  it('is the arrangement’s, not the roster’s', () => {
    layout().moveBy('researcher', 2)
    render(<ChatList selectedBot={undefined} />)

    expect(drawn()).toEqual(['writer', 'ops', 'researcher', 'quiet'])
  })

  it('follows a move made after it was drawn', () => {
    render(<ChatList selectedBot={undefined} />)
    expect(drawn()).toEqual(NAMES)

    act(() => layout().moveBy('quiet', -3))

    expect(drawn()).toEqual(['quiet', 'researcher', 'writer', 'ops'])
  })

  it('draws a chat the arrangement has not placed yet before the first folder, and never inside one', () => {
    withFolder()
    seedRoster([...NAMES, 'fresh'].map(name => aBot(name)))
    render(<ChatList selectedBot={undefined} />)

    // Loose chats, then the new one, then the folder with its chat.
    expect(drawn()).toEqual(['researcher', 'ops', 'quiet', 'fresh', 'writer'])
    expect(within(document.querySelector('[data-folder]')!).queryByRole('link', { name: /Fresh/u })).toBeNull()
  })

  it('drops a chat the roster no longer has', () => {
    seedRoster(['researcher', 'quiet'].map(name => aBot(name)))
    render(<ChatList selectedBot={undefined} />)

    expect(drawn()).toEqual(['researcher', 'quiet'])
  })
})

describe('folders', () => {
  it('are groups with a header, in their place, with their chats inside', () => {
    withFolder()
    render(<ChatList selectedBot={undefined} />)

    const group = document.querySelector<HTMLElement>('[data-folder]')!

    expect(within(group).getByRole('button', { name: 'Reading' }).getAttribute('aria-expanded')).toBe('true')
    expect(within(within(group).getByRole('list', { name: 'Reading' })).getAllByRole('link')).toHaveLength(1)
    expect(drawn()).toEqual(['researcher', 'ops', 'quiet', 'writer'])
  })

  it('close and open from their header, which says which with aria-expanded, and remember it', () => {
    withFolder()
    render(<ChatList selectedBot={undefined} />)

    fireEvent.click(header('Reading'))

    expect(header('Reading').getAttribute('aria-expanded')).toBe('false')
    expect(header('Reading').hasAttribute('aria-controls')).toBe(false)
    expect(rowOf('writer')).toBeNull()
    // The state is the store's (this device's), so a list drawn later finds the folder closed.
    expect(Object.keys(layout().collapsed)).toHaveLength(1)

    cleanup()
    render(<ChatList selectedBot={undefined} />)
    expect(rowOf('writer')).toBeNull()

    fireEvent.click(header('Reading'))
    expect(rowOf('writer')).not.toBeNull()
  })

  it('open with Right and close with Left when the header has the focus', () => {
    withFolder()
    render(<ChatList selectedBot={undefined} />)
    header('Reading').focus()

    fireEvent.keyDown(header('Reading'), { key: 'ArrowLeft' })
    expect(rowOf('writer')).toBeNull()

    fireEvent.keyDown(header('Reading'), { key: 'ArrowRight' })
    expect(rowOf('writer')).not.toBeNull()
  })

  it('take their colour as a dot on the header, and a name when they have none', () => {
    const id = layout().addFolder('')

    layout().moveToFolder('writer', id)
    layout().setFolderColour(id, 'teal')
    render(<ChatList selectedBot={undefined} />)

    expect(header('Untitled folder').querySelector('.hm-group__dot')?.getAttribute('data-accent')).toBe('teal')
  })

  it('are not drawn when every chat in them is archived', () => {
    withFolder()
    layout().setArchived('writer', true)
    render(<ChatList selectedBot={undefined} />)

    expect(screen.queryByRole('button', { name: 'Reading' })).toBeNull()
  })
})

describe('the archive', () => {
  it('is a group at the bottom, closed until it is opened, and says how many are in it', () => {
    layout().setArchived('researcher', true)
    layout().setArchived('ops', true)
    render(<ChatList selectedBot={undefined} />)

    expect(drawn()).toEqual(['writer', 'quiet'])

    const archive = header('Archived (2)')

    expect(archive.getAttribute('aria-expanded')).toBe('false')
    // Last in the page, under the list.
    expect(
      document.querySelector('[data-group="archived"]')!.compareDocumentPosition(rowOf('quiet')) &
        Node.DOCUMENT_POSITION_PRECEDING
    ).toBeTruthy()

    fireEvent.click(archive)

    expect(archive.getAttribute('aria-expanded')).toBe('true')
    expect(drawn()).toEqual(['writer', 'quiet', 'researcher', 'ops'])
    expect(within(screen.getByRole('list', { name: 'Archived (2)' })).getAllByRole('link')).toHaveLength(2)
  })

  it('is not there when nothing is archived, and goes when the last chat leaves it', () => {
    layout().setArchived('ops', true)
    render(<ChatList selectedBot={undefined} />)
    expect(screen.getByRole('button', { name: 'Archived (1)' })).toBeTruthy()

    act(() => layout().setArchived('ops', false))

    expect(screen.queryByRole('button', { name: /^Archived/u })).toBeNull()
    expect(drawn()).toEqual(NAMES)
  })

  it('moves a chat there as soon as it is archived', () => {
    render(<ChatList selectedBot={undefined} />)

    act(() => layout().setArchived('writer', true))

    expect(drawn()).toEqual(['researcher', 'ops', 'quiet'])
    expect(header('Archived (1)')).toBeTruthy()
  })
})

describe('what a row says of the arrangement', () => {
  it('carries the colour the reader gave the chat, and nothing when there is none', () => {
    layout().setAccent('writer', 'teal')
    render(<ChatList selectedBot={undefined} />)

    expect(rowOf('writer').getAttribute('data-accent')).toBe('teal')
    expect(rowOf('researcher').hasAttribute('data-accent')).toBe(false)

    act(() => layout().setAccent('writer', 'default'))

    expect(rowOf('writer').hasAttribute('data-accent')).toBe(false)
  })

  it('marks a muted chat, in its name as well as by a shape', () => {
    layout().setMute('writer', 0)
    render(<ChatList selectedBot={undefined} />)

    expect(rowOf('writer').getAttribute('data-muted')).toBe('true')
    expect(rowOf('writer').querySelector('.hm-row__marks svg')).not.toBeNull()
    expect(rowOf('writer').textContent).toContain('Muted')
    expect(rowOf('researcher').querySelector('.hm-row__marks')).toBeNull()
  })

  it('stops marking a mute when its deadline passes, with nobody touching the page', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-04T10:00:00Z'))
    layout().setMute('writer', Math.floor(Date.now() / 1000) + 60)
    render(<ChatList selectedBot={undefined} />)
    expect(rowOf('writer').getAttribute('data-muted')).toBe('true')

    act(() => {
      vi.advanceTimersByTime(61_000)
    })

    expect(rowOf('writer').hasAttribute('data-muted')).toBe(false)
  })

  it('does not mark a mute that has already lapsed', () => {
    layout().setMute('writer', Math.floor(Date.now() / 1000) - 5)
    render(<ChatList selectedBot={undefined} />)

    expect(rowOf('writer').hasAttribute('data-muted')).toBe(false)
  })

  it('lifts a pinned chat to the top and marks it', () => {
    layout().setPinned('ops', true)
    render(<ChatList selectedBot={undefined} />)

    expect(drawn()).toEqual(['ops', 'researcher', 'writer', 'quiet'])
    expect(rowOf('ops').textContent).toContain('Pinned')
  })

  it('leaves unread and presence as they were', () => {
    botsStore.getState().reset()
    seedRoster(
      NAMES.map(name => aBot(name)),
      { read: false }
    )
    layout().reconcile(NAMES)
    layout().setAccent('writer', 'red')
    layout().setMute('writer', 0)
    render(<ChatList selectedBot={undefined} />)

    expect(rowOf('writer').getAttribute('data-unread')).toBe('true')
    expect(rowOf('writer').textContent).toMatch(/Online|Offline|Idle|Ready|Away/u)
  })
})

describe('the keyboard', () => {
  it('moves between rows across a folder and the archive with the arrows, Home and End', () => {
    withFolder()
    layout().setArchived('quiet', true)
    render(<ChatList selectedBot={undefined} />)
    fireEvent.click(header('Archived (1)'))
    // researcher, ops (loose); writer (folder); quiet (archived)
    expect(drawn()).toEqual(['researcher', 'ops', 'writer', 'quiet'])

    rowOf('ops').focus()
    fireEvent.keyDown(rowOf('ops'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowOf('writer'))

    fireEvent.keyDown(rowOf('writer'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowOf('quiet'))

    fireEvent.keyDown(rowOf('quiet'), { key: 'Home' })
    expect(document.activeElement).toBe(rowOf('researcher'))

    fireEvent.keyDown(rowOf('researcher'), { key: 'End' })
    expect(document.activeElement).toBe(rowOf('quiet'))

    fireEvent.keyDown(rowOf('quiet'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rowOf('writer'))
  })

  it('steps from a header to the row after it and the row before it', () => {
    withFolder()
    render(<ChatList selectedBot={undefined} />)
    header('Reading').focus()

    fireEvent.keyDown(header('Reading'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(rowOf('writer'))

    header('Reading').focus()
    fireEvent.keyDown(header('Reading'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(rowOf('quiet'))
  })

  it('keeps the rows one tab stop, on the open chat even when it is in a folder', () => {
    withFolder()
    render(<ChatList selectedBot="writer" />)

    const stops = [...document.querySelectorAll<HTMLElement>('a[data-bot]')].filter(link => link.tabIndex === 0)

    expect(stops.map(link => link.dataset.bot)).toEqual(['writer'])
  })

  it('moves the tab stop to a row that is on the page when the focused one closes with its folder', () => {
    withFolder()
    render(<ChatList selectedBot={undefined} />)
    act(() => rowOf('writer').focus())
    expect(rowOf('writer').tabIndex).toBe(0)

    fireEvent.click(header('Reading'))

    const stops = [...document.querySelectorAll<HTMLElement>('a[data-bot]')].filter(link => link.tabIndex === 0)

    expect(stops.map(link => link.dataset.bot)).toEqual(['researcher'])
  })
})

describe('a search', () => {
  it('shows its matches in their groups, closed ones and the archive opened, with headers that only name them', () => {
    const id = withFolder()

    layout().setFolderOpen(id, false)
    layout().setArchived('quiet', true)
    render(<ChatList selectedBot={undefined} />)
    expect(drawn()).toEqual(['researcher', 'ops'])

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'i' } })

    // writer (in the closed folder) and quiet (archived) match, and neither is hidden.
    expect(drawn()).toEqual(['writer', 'quiet'])
    expect(screen.queryByRole('button', { name: 'Reading' })).toBeNull()
    expect(screen.getByText('Reading')).toBeTruthy()
    expect(screen.getByText('Archived (1)')).toBeTruthy()

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })

    expect(drawn()).toEqual(['researcher', 'ops'])
    expect(header('Reading').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('accessibility', () => {
  async function violations(): Promise<string[]> {
    const result = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } }
    })

    return result.violations.map(
      violation =>
        `${violation.id}: ${violation.help} (${violation.nodes.map(node => node.target.join(' ')).join(', ')})`
    )
  }

  it('has no violation with folders, the archive, colours, marks and a search', async () => {
    const id = withFolder()

    layout().setFolderColour(id, 'violet')
    layout().setAccent('ops', 'teal')
    layout().setMute('quiet', 0)
    layout().setPinned('ops', true)
    layout().setArchived('researcher', true)
    render(
      <main>
        <h1>Hermie</h1>
        <h2>Chats</h2>
        <ChatList selectedBot="writer" />
      </main>
    )

    expect(await violations()).toEqual([])

    fireEvent.click(header('Archived (1)'))
    expect(await violations()).toEqual([])

    fireEvent.click(header('Reading'))
    expect(await violations()).toEqual([])

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'e' } })
    expect(await violations()).toEqual([])
  })
})
