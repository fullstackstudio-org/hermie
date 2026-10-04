/**
 * The arithmetic behind Settings, Chat list: what is listed, how far a step goes over chats that are not
 * drawn, where a drop lands and whether it changes anything, and where a row is after a move.
 */
import { describe, expect, it } from 'vitest'

import type { Arrangement } from '../../state/folders'
import { moveBotTo, moveFolderTo } from '../../state/folders'
import { dropOf, folderStepOffset, looseChats, placementOf, stepOffset, viewOf } from './arrangement-model'

/** a, [Work: b, c, d], e, [Play: f], g */
const arrangement: Arrangement = {
  entries: [
    { kind: 'chat', name: 'a' },
    { kind: 'folder', id: 'work' },
    { kind: 'chat', name: 'e' },
    { kind: 'folder', id: 'play' },
    { kind: 'chat', name: 'g' }
  ],
  folders: [
    { id: 'work', name: 'Work', bots: ['b', 'c', 'd'] },
    { id: 'play', name: 'Play', colour: 'teal', bots: ['f'] }
  ]
}

const names = (items: readonly { kind: string; name?: string; id?: string }[]): string[] =>
  items.map(item => (item.kind === 'folder' ? `[${item.id}]` : (item.name ?? '')))

describe('viewOf', () => {
  it('lists the top level in order, with each folder’s chats inside it', () => {
    const view = viewOf(arrangement, {}, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])

    expect(names(view.entries)).toEqual(['a', '[work]', 'e', '[play]', 'g'])
    expect(view.entries.flatMap(entry => (entry.kind === 'folder' ? [entry.chats] : []))).toEqual([
      ['b', 'c', 'd'],
      ['f']
    ])
    expect(view.archived).toEqual([])
  })

  it('sets the archived chats apart, wherever they were', () => {
    const view = viewOf(arrangement, { c: true, g: true }, [])

    expect(names(view.entries)).toEqual(['a', '[work]', 'e', '[play]'])
    expect(view.entries.flatMap(entry => (entry.kind === 'folder' ? [entry.chats] : []))).toEqual([['b', 'd'], ['f']])
    expect(view.archived).toEqual(['c', 'g'])
  })

  it('shows a bot of the roster the arrangement has not placed yet, loose, after what is there', () => {
    const view = viewOf({ entries: [{ kind: 'chat', name: 'a' }], folders: [] }, {}, ['a', 'z'])

    expect(names(view.entries)).toEqual(['a', 'z'])
  })

  it('puts it where the native apps do, at the end of the loose run before the first folder', () => {
    const view = viewOf(arrangement, {}, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'y', 'z'])

    expect(names(view.entries)).toEqual(['a', 'y', 'z', '[work]', 'e', '[play]', 'g'])
  })

  it('lists nothing for an empty arrangement and an empty roster', () => {
    expect(viewOf({ entries: [], folders: [] }, {}, [])).toEqual({ entries: [], archived: [] })
  })
})

describe('stepOffset', () => {
  const hidden = (name: string) => name === 'c'

  it('steps one place to the next chat that is drawn', () => {
    expect(stepOffset(['b', 'c', 'd'], () => false, 'b', 1)).toBe(1)
    expect(stepOffset(['b', 'c', 'd'], () => false, 'd', -1)).toBe(-1)
  })

  it('steps over an archived chat it cannot see', () => {
    expect(stepOffset(['b', 'c', 'd'], hidden, 'b', 1)).toBe(2)
    expect(stepOffset(['b', 'c', 'd'], hidden, 'd', -1)).toBe(-2)
  })

  it('does not step past the end, or when only archived chats are that way, or for a chat it does not know', () => {
    expect(stepOffset(['b', 'c', 'd'], hidden, 'd', 1)).toBe(0)
    expect(stepOffset(['b', 'c', 'd'], hidden, 'b', -1)).toBe(0)
    expect(stepOffset(['b', 'c'], hidden, 'b', 1)).toBe(0)
    expect(stepOffset(['b', 'c'], hidden, 'x', 1)).toBe(0)
  })

  it('reads the loose chats of the top level as `moveBy` does, folders left out', () => {
    expect(looseChats(arrangement)).toEqual(['a', 'e', 'g'])
  })
})

describe('folderStepOffset', () => {
  it('counts every top-level entry, loose chats included, as `moveFolderBy` does', () => {
    expect(folderStepOffset(arrangement, {}, 'work', 1)).toBe(1)
    expect(folderStepOffset(arrangement, {}, 'work', -1)).toBe(-1)
    expect(folderStepOffset(arrangement, {}, 'play', 1)).toBe(1)
  })

  it('steps over an archived loose chat that is not drawn, and stops where nothing is drawn that way', () => {
    expect(folderStepOffset(arrangement, { e: true }, 'work', 1)).toBe(2)
    expect(folderStepOffset(arrangement, { a: true }, 'work', -1)).toBe(0)
    expect(folderStepOffset(arrangement, {}, 'nothing', 1)).toBe(0)
  })
})

describe('dropOf', () => {
  it('puts a chat before or after another in the same folder, read without the moving row', () => {
    // b over d, lower half: after d, i.e. index 2 of [c, d].
    expect(dropOf(arrangement, { kind: 'chat', name: 'b' }, { kind: 'chat', name: 'd', after: true })).toEqual({
      kind: 'chat',
      name: 'b',
      folderId: 'work',
      index: 2
    })
    // d over b, upper half: before b, i.e. index 0.
    expect(dropOf(arrangement, { kind: 'chat', name: 'd' }, { kind: 'chat', name: 'b', after: false })).toEqual({
      kind: 'chat',
      name: 'd',
      folderId: 'work',
      index: 0
    })
  })

  it('puts a chat at the top level among loose chats and folders, counting both', () => {
    // b (in Work) over g, upper half: before g, among [a, work, e, play, g].
    expect(dropOf(arrangement, { kind: 'chat', name: 'b' }, { kind: 'chat', name: 'g', after: false })).toEqual({
      kind: 'chat',
      name: 'b',
      folderId: null,
      index: 4
    })
  })

  it('puts a chat dropped on a folder’s own row at the end of that folder', () => {
    expect(dropOf(arrangement, { kind: 'chat', name: 'a' }, { kind: 'folder', id: 'work', after: false })).toEqual({
      kind: 'chat',
      name: 'a',
      folderId: 'work',
      index: 3
    })
  })

  it('moves a folder among the top level, and reads a chat inside a folder as that folder', () => {
    expect(dropOf(arrangement, { kind: 'folder', id: 'work' }, { kind: 'chat', name: 'g', after: true })).toEqual({
      kind: 'folder',
      id: 'work',
      index: 4
    })
    // Over f, which is in Play: next to Play. Work out of the list: [a, e, play, g], before play is 2.
    expect(dropOf(arrangement, { kind: 'folder', id: 'work' }, { kind: 'chat', name: 'f', after: false })).toEqual({
      kind: 'folder',
      id: 'work',
      index: 2
    })
  })

  it('says nothing for a drop that changes nothing', () => {
    // a over e, upper half... a is first; before e is where a already is relative to e? [a, work, e]: after work, before e.
    expect(dropOf(arrangement, { kind: 'chat', name: 'a' }, { kind: 'chat', name: 'a', after: true })).toBeNull()
    expect(dropOf(arrangement, { kind: 'chat', name: 'b' }, { kind: 'chat', name: 'c', after: false })).toBeNull()
    expect(dropOf(arrangement, { kind: 'chat', name: 'c' }, { kind: 'chat', name: 'b', after: true })).toBeNull()
    expect(dropOf(arrangement, { kind: 'folder', id: 'work' }, { kind: 'folder', id: 'work', after: true })).toBeNull()
    expect(dropOf(arrangement, { kind: 'folder', id: 'work' }, { kind: 'chat', name: 'c', after: true })).toBeNull()
  })

  it('says nothing for a target that is not there', () => {
    expect(dropOf(arrangement, { kind: 'chat', name: 'a' }, { kind: 'folder', id: 'gone', after: false })).toBeNull()
    expect(dropOf(arrangement, { kind: 'chat', name: 'a' }, { kind: 'chat', name: 'nobody', after: false })).toBeNull()
    expect(
      dropOf(arrangement, { kind: 'folder', id: 'work' }, { kind: 'chat', name: 'nobody', after: false })
    ).toBeNull()
  })

  it('lands exactly where the store’s own move puts it', () => {
    const drop = dropOf(arrangement, { kind: 'chat', name: 'b' }, { kind: 'chat', name: 'd', after: true })

    expect(
      drop?.kind === 'chat' && moveBotTo(arrangement, drop.name, drop.folderId, drop.index).folders[0]?.bots
    ).toEqual(['c', 'd', 'b'])

    const folder = dropOf(arrangement, { kind: 'folder', id: 'work' }, { kind: 'chat', name: 'g', after: true })

    expect(
      folder?.kind === 'folder' && moveFolderTo(arrangement, folder.id, folder.index).entries.map(entry => entry.kind)
    ).toEqual(['chat', 'chat', 'folder', 'chat', 'folder'])
  })
})

describe('placementOf', () => {
  it('counts a chat in a folder among that folder’s drawn chats', () => {
    expect(placementOf(arrangement, {}, { kind: 'chat', name: 'c' })).toEqual({ folderId: 'work', index: 2, count: 3 })
    expect(placementOf(arrangement, { b: true }, { kind: 'chat', name: 'c' })).toEqual({
      folderId: 'work',
      index: 1,
      count: 2
    })
  })

  it('counts a loose chat and a folder among the drawn top-level entries', () => {
    expect(placementOf(arrangement, {}, { kind: 'chat', name: 'e' })).toEqual({ folderId: null, index: 3, count: 5 })
    expect(placementOf(arrangement, { a: true }, { kind: 'folder', id: 'play' })).toEqual({
      folderId: null,
      index: 3,
      count: 4
    })
  })

  it('says null for a row that is not there', () => {
    expect(placementOf(arrangement, {}, { kind: 'chat', name: 'nobody' })).toBeNull()
    expect(placementOf(arrangement, {}, { kind: 'folder', id: 'nothing' })).toBeNull()
  })
})
