/**
 * Folders: the arrangement, the one-place invariant, the migration out of
 * dividers, and the moves.
 *
 * Ported from the Expo app's `__tests__/folders.test.ts`: the cases about
 * `store/folders.ts` itself, unchanged. The cases about the list's rows, a
 * closed folder's counts and where a drag lands test the Expo app's
 * `features/bots/folder-rows.ts` and `drag-order.ts`, which are the chat list's
 * (W-20b), not this module's.
 */
import { describe, expect, it } from 'vitest'

import {
  ACCENT_NAMES,
  addFolder,
  asAccentName,
  botsInOrder,
  folderOf,
  isSafeFolderId,
  moveBotTo,
  moveBotToFolder,
  moveFolderTo,
  normalise,
  readArrangement,
  reconcileBots,
  removeFolder,
  renameFolder,
  setFolderColour,
  type Arrangement
} from './folders'

/** Finance holds writer and bookkeeper; researcher and postman are loose. */
const sample = (): Arrangement =>
  normalise(
    [
      { kind: 'chat', name: 'researcher' },
      { kind: 'folder', id: 'f1' },
      { kind: 'chat', name: 'postman' }
    ],
    [{ id: 'f1', name: 'Finance', bots: ['writer', 'bookkeeper'] }]
  )

describe('a bot is in exactly one place', () => {
  it('keeps the first position and drops the duplicate', () => {
    const arrangement = normalise(
      [
        { kind: 'chat', name: 'writer' },
        { kind: 'folder', id: 'f1' },
        { kind: 'chat', name: 'writer' }
      ],
      [{ id: 'f1', name: 'Finance', bots: ['writer', 'researcher'] }]
    )

    // Loose first, because the top level is read before the folders are: a bot
    // that is both stays where the reader can see it.
    expect(arrangement.entries).toEqual([
      { kind: 'chat', name: 'writer' },
      { kind: 'folder', id: 'f1' }
    ])
    expect(arrangement.folders[0]?.bots).toEqual(['researcher'])
    expect(folderOf(arrangement, 'writer')).toBeNull()
  })

  it('never lets one bot sit in two folders', () => {
    const arrangement = normalise(
      [
        { kind: 'folder', id: 'f1' },
        { kind: 'folder', id: 'f2' }
      ],
      [
        { id: 'f1', name: 'A', bots: ['writer'] },
        { id: 'f2', name: 'B', bots: ['writer', 'researcher'] }
      ]
    )

    expect(arrangement.folders[0]?.bots).toEqual(['writer'])
    expect(arrangement.folders[1]?.bots).toEqual(['researcher'])
    expect(botsInOrder(arrangement)).toEqual(['writer', 'researcher'])
  })

  it('appends a folder nobody placed rather than losing the bots in it', () => {
    const arrangement = normalise([], [{ id: 'f1', name: 'Finance', bots: ['writer'] }])

    expect(arrangement.entries).toEqual([{ kind: 'folder', id: 'f1' }])
    expect(botsInOrder(arrangement)).toEqual(['writer'])
  })

  it('drops a folder id the top level names but nothing defines', () => {
    const arrangement = normalise([{ kind: 'folder', id: 'ghost' }], [])

    expect(arrangement.entries).toEqual([])
  })

  it('holds the invariant through every move', () => {
    let arrangement = sample()

    arrangement = moveBotTo(arrangement, 'researcher', 'f1', 0)
    arrangement = moveBotTo(arrangement, 'writer', null, 0)
    arrangement = moveBotToFolder(arrangement, 'postman', 'f1')

    const seen = new Set<string>()

    for (const name of botsInOrder(arrangement)) {
      expect(seen.has(name)).toBe(false)
      seen.add(name)
    }

    expect([...seen].sort()).toEqual(['bookkeeper', 'postman', 'researcher', 'writer'])
  })
})

describe('migrating the dividers away', () => {
  /** What ADR-0012 wrote: one flat list, headings inline. */
  const legacy = [
    { kind: 'chat', name: 'researcher' },
    { kind: 'divider', id: 'd1', name: 'Finance' },
    { kind: 'chat', name: 'writer' },
    { kind: 'chat', name: 'bookkeeper' },
    { kind: 'divider', id: 'd2', name: 'Personal' },
    { kind: 'chat', name: 'postman' }
  ]

  it('turns each divider into a folder holding the chats below it', () => {
    const arrangement = readArrangement(legacy, undefined)

    expect(arrangement.folders).toEqual([
      { id: 'd1', name: 'Finance', bots: ['writer', 'bookkeeper'] },
      { id: 'd2', name: 'Personal', bots: ['postman'] }
    ])
  })

  it('leaves the chats above the first divider loose', () => {
    const arrangement = readArrangement(legacy, undefined)

    expect(arrangement.entries).toEqual([
      { kind: 'chat', name: 'researcher' },
      { kind: 'folder', id: 'd1' },
      { kind: 'folder', id: 'd2' }
    ])
  })

  it('stops a folder where the next divider starts, not at the end of the list', () => {
    expect(readArrangement(legacy, undefined).folders[0]?.bots).not.toContain('postman')
  })

  it('keeps the reading order the divider list had', () => {
    expect(botsInOrder(readArrangement(legacy, undefined))).toEqual(['researcher', 'writer', 'bookkeeper', 'postman'])
  })

  it('reads the new shape without migrating anything', () => {
    const arrangement = readArrangement(
      [{ kind: 'folder', id: 'f1' }],
      [{ id: 'f1', name: 'Finance', colour: 'teal', bots: ['writer'] }]
    )

    expect(arrangement.folders[0]).toEqual({ id: 'f1', name: 'Finance', colour: 'teal', bots: ['writer'] })
  })

  it('survives a blob written by something else entirely', () => {
    expect(readArrangement(null, null)).toEqual({ entries: [], folders: [] })
    expect(readArrangement('nope', 7)).toEqual({ entries: [], folders: [] })
    expect(readArrangement([{ kind: 'chat' }, null, 3], [{ name: 'no id' }])).toEqual({ entries: [], folders: [] })
  })

  it('drops a colour this build does not have', () => {
    const arrangement = readArrangement([{ kind: 'folder', id: 'f1' }], [{ id: 'f1', name: 'X', colour: 'chartreuse' }])

    expect(arrangement.folders[0]).not.toHaveProperty('colour')
  })
})

describe('moving between containers', () => {
  it('takes a bot out of its folder on the way to the top level', () => {
    const arrangement = moveBotTo(sample(), 'writer', null, 0)

    expect(folderOf(arrangement, 'writer')).toBeNull()
    expect(arrangement.folders[0]?.bots).toEqual(['bookkeeper'])
    expect(arrangement.entries[0]).toEqual({ kind: 'chat', name: 'writer' })
  })

  it('takes a loose bot into a folder at the index asked for', () => {
    const arrangement = moveBotTo(sample(), 'researcher', 'f1', 1)

    expect(arrangement.folders[0]?.bots).toEqual(['writer', 'researcher', 'bookkeeper'])
    expect(arrangement.entries.some(entry => entry.kind === 'chat' && entry.name === 'researcher')).toBe(false)
  })

  it('refuses a folder that does not exist rather than losing the bot', () => {
    const arrangement = sample()

    expect(moveBotTo(arrangement, 'researcher', 'nope', 0)).toBe(arrangement)
  })

  it('moves a folder itself without disturbing what is in it', () => {
    const arrangement = moveFolderTo(sample(), 'f1', 0)

    expect(arrangement.entries[0]).toEqual({ kind: 'folder', id: 'f1' })
    expect(arrangement.folders[0]?.bots).toEqual(['writer', 'bookkeeper'])
  })

  it('gives a deleted folder’s chats back at the folder’s own position', () => {
    const arrangement = removeFolder(sample(), 'f1')

    // Where the folder stood, in their own order — not appended to the end,
    // which would make deleting a container a reordering as well.
    expect(arrangement.entries).toEqual([
      { kind: 'chat', name: 'researcher' },
      { kind: 'chat', name: 'writer' },
      { kind: 'chat', name: 'bookkeeper' },
      { kind: 'chat', name: 'postman' }
    ])
    expect(arrangement.folders).toEqual([])
  })

  it('renames and recolours without touching the contents', () => {
    let arrangement = renameFolder(sample(), 'f1', 'Money')

    arrangement = setFolderColour(arrangement, 'f1', 'teal')

    expect(arrangement.folders[0]).toEqual({ id: 'f1', name: 'Money', colour: 'teal', bots: ['writer', 'bookkeeper'] })
    // Default is the absence of a choice rather than a ninth colour.
    expect(setFolderColour(arrangement, 'f1', 'default').folders[0]).not.toHaveProperty('colour')
  })
})

describe('folding the roster in', () => {
  it('lands a new bot before the first folder, not inside the last one', () => {
    const arrangement = reconcileBots(sample(), ['researcher', 'writer', 'bookkeeper', 'postman', 'newcomer'])

    expect(arrangement.entries).toEqual([
      { kind: 'chat', name: 'researcher' },
      { kind: 'chat', name: 'newcomer' },
      { kind: 'folder', id: 'f1' },
      { kind: 'chat', name: 'postman' }
    ])
  })

  it('drops a bot the gateway no longer has, from inside a folder too', () => {
    const arrangement = reconcileBots(sample(), ['researcher', 'bookkeeper', 'postman'])

    expect(arrangement.folders[0]?.bots).toEqual(['bookkeeper'])
    expect(botsInOrder(arrangement)).toEqual(['researcher', 'bookkeeper', 'postman'])
  })

  it('keeps an empty folder, so there is something to move a chat back into', () => {
    const arrangement = reconcileBots(sample(), ['researcher', 'postman'])

    expect(arrangement.folders[0]).toEqual({ id: 'f1', name: 'Finance', bots: [] })
  })
})

describe('adding a folder', () => {
  it('appends an empty one at the end of the top level', () => {
    const arrangement = addFolder(sample(), 'Personal', 'f2')

    expect(arrangement.entries.at(-1)).toEqual({ kind: 'folder', id: 'f2' })
    expect(arrangement.folders[1]).toEqual({ id: 'f2', name: 'Personal', bots: [] })
  })

  it('mints ids that do not collide', () => {
    const first = addFolder(sample(), 'A')
    const second = addFolder(first, 'B')

    expect(new Set(second.folders.map(folder => folder.id)).size).toBe(second.folders.length)
  })
})

describe('the colour names', () => {
  it('are the Expo app’s eleven, so a colour picked on a phone reads back here', () => {
    expect(ACCENT_NAMES).toEqual([
      'default',
      'indigo',
      'violet',
      'magenta',
      'red',
      'orange',
      'teal',
      'green',
      'graphite',
      'slate',
      'lime'
    ])
  })

  it('reads a name defensively', () => {
    expect(asAccentName('teal')).toBe('teal')
    expect(asAccentName('tartan')).toBeUndefined()
    expect(asAccentName(7)).toBeUndefined()
  })
})

describe('folder ids', () => {
  it('accepts the ids this module mints and refuses anything that reads as a path', () => {
    expect(isSafeFolderId(addFolder(sample(), 'A').folders[1]!.id)).toBe(true)
    expect(isSafeFolderId('../etc')).toBe(false)
    expect(isSafeFolderId('')).toBe(false)
  })
})
