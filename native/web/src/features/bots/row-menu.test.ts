/**
 * What a chat row's menu offers and what each line does: the lines in the owner's order, the state a line
 * says (Pin or Unpin, a mute's deadline, the colour in force), what is left out where it means nothing, and
 * a choice carried out through the layout store's own actions with a sentence for the live region.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resetActiveLocale, setActiveLocale } from '../../i18n/active-locale'
import { type RowMenuModel, rowMenuItems, runRowAction } from './row-menu'

afterEach(() => {
  resetActiveLocale()
})

const NOW = 1_800_000_000

const model = (over: Partial<RowMenuModel> = {}): RowMenuModel => ({
  name: 'Writer',
  accent: 'default',
  archived: false,
  pinned: false,
  unread: true,
  mutedUntil: null,
  now: NOW,
  folderId: null,
  folders: [],
  ...over
})

const labels = (view: Parameters<typeof rowMenuItems>[0], over: Partial<RowMenuModel> = {}): string[] =>
  rowMenuItems(view, model(over)).map(item => item.label)

describe('the first list', () => {
  it('is Mark as read, Edit profile, Pin, Mute, Colour and Archive, in that order', () => {
    expect(labels('root')).toEqual(['Mark as read', 'Edit profile', 'Pin', 'Mute', 'Colour', 'Archive'])
  })

  it('offers Move to folder only where there are folders, between Mute and Colour', () => {
    expect(labels('root', { folders: [{ id: 'f1', name: 'Reading' }] })).toEqual([
      'Mark as read',
      'Edit profile',
      'Pin',
      'Mute',
      'Move to folder',
      'Colour',
      'Archive'
    ])
  })

  it('says Unpin and Unarchive for a chat that is pinned and archived, and leaves the folders to the archive’s Unarchive', () => {
    const items = rowMenuItems(
      'root',
      model({ pinned: true, archived: true, folders: [{ id: 'f1', name: 'Reading' }] })
    )

    expect(items.map(item => item.label)).toEqual([
      'Mark as read',
      'Edit profile',
      'Unpin',
      'Mute',
      'Colour',
      'Unarchive'
    ])
    expect(items.find(item => item.id === 'pin')?.action).toEqual({ kind: 'pin', pinned: false })
    expect(items.find(item => item.id === 'archive')?.action).toEqual({ kind: 'archive', archived: false })
  })

  it('keeps Mark as read, disabled, for a chat with nothing unread', () => {
    const read = rowMenuItems('root', model({ unread: false })).find(item => item.id === 'markRead')

    expect(read).toMatchObject({ label: 'Mark as read', disabled: true })
    expect(rowMenuItems('root', model()).find(item => item.id === 'markRead')?.disabled).toBeFalsy()
  })

  it('says a mute is on, and when it ends, with Unmute beside it, instead of the list of durations', () => {
    const forever = rowMenuItems('root', model({ mutedUntil: 0 }))

    expect(forever.slice(3, 5).map(item => [item.kind, item.label])).toEqual([
      ['caption', 'Muted'],
      ['action', 'Unmute']
    ])

    const until = rowMenuItems('root', model({ mutedUntil: NOW + 3600 }))
    const caption = until.find(item => item.kind === 'caption')

    expect(caption?.label).toMatch(/^Muted until \d{2}:\d{2}$/u)
    expect(until.find(item => item.id === 'unmute')?.action).toEqual({ kind: 'unmute' })
    expect(until.some(item => item.id === 'mute')).toBe(false)
  })

  it('shows Mute, Move to folder and Colour as lists, not as choices', () => {
    const items = rowMenuItems('root', model({ folders: [{ id: 'f1', name: 'Reading' }] }))

    expect(items.filter(item => item.kind === 'submenu').map(item => [item.id, item.view])).toEqual([
      ['mute', 'mute'],
      ['folder', 'folder'],
      ['colour', 'colour']
    ])
  })
})

describe('the lists', () => {
  it('Mute is a way back and the four durations', () => {
    expect(labels('mute')).toEqual(['Back', 'For 1 hour', 'For 8 hours', 'For 1 week', 'Until I turn it back on'])
    expect(rowMenuItems('mute', model()).at(-1)?.action).toEqual({ kind: 'mute', duration: 'forever' })
  })

  it('Colour is every colour, the one in force checked', () => {
    const items = rowMenuItems('colour', model({ accent: 'teal' }))

    expect(items[0]?.kind).toBe('back')
    expect(items.slice(1).map(item => item.kind)).toEqual(Array(11).fill('radio'))
    expect(items.filter(item => item.checked).map(item => item.label)).toEqual(['Teal'])
    expect(items.find(item => item.label === 'Violet')?.action).toEqual({ kind: 'accent', accent: 'violet' })
  })

  it('Move to folder is No folder and every folder, named as Settings names them, the chat’s own checked', () => {
    const items = rowMenuItems(
      'folder',
      model({
        folderId: 'f2',
        folders: [
          { id: 'f1', name: 'Reading' },
          { id: 'f2', name: '' }
        ]
      })
    )

    expect(items.map(item => item.label)).toEqual(['Back', 'No folder', 'Reading', 'Untitled folder'])
    expect(items.filter(item => item.checked).map(item => item.label)).toEqual(['Untitled folder'])
    expect(items[1]?.action).toEqual({ kind: 'folder', folderId: null })
    expect(items[2]?.action).toEqual({ kind: 'folder', folderId: 'f1' })
  })

  it('says Terug in Dutch, from the same lines', () => {
    // The labels are read when called, in the active language.
    setActiveLocale('nl')
    expect(rowMenuItems('mute', model())[0]?.label).toBe('Terug')
  })
})

describe('carrying a choice out', () => {
  function context() {
    const layout = {
      setPinned: vi.fn(),
      setMute: vi.fn(),
      moveToFolder: vi.fn(),
      setAccent: vi.fn(),
      setArchived: vi.fn()
    }
    const markRead = vi.fn()
    const editProfile = vi.fn()

    return {
      layout,
      markRead,
      editProfile,
      context: { layout, markRead, editProfile, now: NOW, folders: [{ id: 'f1', name: 'Reading' }] }
    }
  }

  it('pins and unpins through the layout store, and says which', () => {
    const { layout, context: ctx } = context()

    expect(runRowAction({ kind: 'pin', pinned: true }, 'writer', 'Writer', ctx)).toBe('Writer pinned.')
    expect(runRowAction({ kind: 'pin', pinned: false }, 'writer', 'Writer', ctx)).toBe('Writer unpinned.')
    expect(layout.setPinned.mock.calls).toEqual([
      ['writer', true],
      ['writer', false]
    ])
  })

  it('counts a mute from now, forever as 0, and ends one with null', () => {
    const { layout, context: ctx } = context()

    expect(runRowAction({ kind: 'mute', duration: '8h' }, 'writer', 'Writer', ctx)).toBe('Writer muted. For 8 hours.')
    runRowAction({ kind: 'mute', duration: 'forever' }, 'writer', 'Writer', ctx)
    expect(runRowAction({ kind: 'unmute' }, 'writer', 'Writer', ctx)).toBe('Writer unmuted.')
    expect(layout.setMute.mock.calls).toEqual([
      ['writer', NOW + 8 * 3600],
      ['writer', 0],
      ['writer', null]
    ])
  })

  it('moves to a folder and out of one, and names where it went', () => {
    const { layout, context: ctx } = context()

    expect(runRowAction({ kind: 'folder', folderId: 'f1' }, 'writer', 'Writer', ctx)).toBe('Writer is now in Reading.')
    expect(runRowAction({ kind: 'folder', folderId: null }, 'writer', 'Writer', ctx)).toBe(
      'Writer is now in No folder.'
    )
    expect(layout.moveToFolder.mock.calls).toEqual([
      ['writer', 'f1'],
      ['writer', null]
    ])
  })

  it('colours, archives and unarchives', () => {
    const { layout, context: ctx } = context()

    expect(runRowAction({ kind: 'accent', accent: 'teal' }, 'writer', 'Writer', ctx)).toBe(
      'Colour of Writer set to Teal.'
    )
    expect(runRowAction({ kind: 'archive', archived: true }, 'writer', 'Writer', ctx)).toMatch(/Writer/u)
    runRowAction({ kind: 'archive', archived: false }, 'writer', 'Writer', ctx)
    expect(layout.setAccent).toHaveBeenCalledWith('writer', 'teal')
    expect(layout.setArchived.mock.calls).toEqual([
      ['writer', true],
      ['writer', false]
    ])
  })

  it('hands Mark as read and Edit profile to the page, which owns the watermark and the route', () => {
    const { markRead, editProfile, context: ctx } = context()

    expect(runRowAction({ kind: 'markRead' }, 'writer', 'Writer', ctx)).toBe('Writer marked as read.')
    expect(runRowAction({ kind: 'editProfile' }, 'writer', 'Writer', ctx)).toBe('')
    expect(markRead).toHaveBeenCalledTimes(1)
    expect(editProfile).toHaveBeenCalledTimes(1)
  })
})
