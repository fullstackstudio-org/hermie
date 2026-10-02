/**
 * Folders: the arrangement, the migration out of dividers, and where a drop lands.
 *
 * A divider was a heading with nothing inside it. A folder is a container, and
 * almost every case here is about a consequence of that one difference: it can
 * be closed, so what is inside it has to be counted while nobody can see it; it
 * has an inside, so a row can be dropped INTO it rather than merely after it;
 * and a bot is in exactly one of them, so every move is a move OUT of somewhere
 * as well as into somewhere.
 *
 * The gesture itself cannot be exercised — a `PanResponder` needs a touch and
 * the boxes it reads come from a real layout pass — but the whole translation
 * from "the finger is here" to "this bot goes into that folder at that index"
 * is arithmetic, and it is all here.
 */
import {
  anchorBoxes,
  committedIndex,
  dragAnchors,
  folderCounts,
  folderRows,
  isSamePlace,
  type RowsInput
} from '../src/features/bots/folder-rows'
import { dropSlot } from '../src/features/bots/drag-order'
import {
  addFolder,
  botsInOrder,
  folderOf,
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
} from '../src/store/folders'
import { MUTE_FOREVER } from '../src/store/mute'

const NOW = 1_790_000_000

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

const rowsInput = (over: Partial<RowsInput> = {}): RowsInput => ({
  arrangement: sample(),
  archived: {},
  collapsed: {},
  mutes: {},
  now: NOW,
  countsFor: () => ({ unread: 0, needsInput: false }),
  ...over
})

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

describe('what a closed folder says', () => {
  const counts = (over: Partial<RowsInput> = {}) =>
    folderCounts(sample().folders[0]!, rowsInput({ countsFor: () => ({ unread: 3, needsInput: true }), ...over }))

  it('adds up the unread inside it', () => {
    expect(counts().unread).toBe(6)
    expect(counts().needsInput).toBe(true)
  })

  /**
   * The two numbers part company over mute, and the owner's rule is the split.
   *
   * Closing a folder hides rows that were each carrying their own badge, so an
   * unread count that skipped the muted ones would make collapsing a folder
   * DELETE information. The needs-input dot is a summons and does skip them.
   */
  it('counts a muted chat’s unread, because collapsing a folder must not hide it', () => {
    expect(counts({ mutes: { writer: MUTE_FOREVER } }).unread).toBe(6)
    expect(counts({ mutes: { writer: MUTE_FOREVER, bookkeeper: MUTE_FOREVER } }).unread).toBe(6)
  })

  it('leaves a muted chat out of the needs-input dot, which is a summons', () => {
    expect(counts({ mutes: { writer: MUTE_FOREVER, bookkeeper: NOW + 60 } }).needsInput).toBe(false)
    // One of the two still unmuted is still a bot waiting on this reader.
    expect(counts({ mutes: { writer: MUTE_FOREVER } }).needsInput).toBe(true)
  })

  it('summons again once a mute has lapsed', () => {
    expect(counts({ mutes: { writer: NOW - 1, bookkeeper: NOW - 1 } }).needsInput).toBe(true)
    expect(counts({ mutes: { writer: NOW - 1, bookkeeper: NOW - 1 } }).unread).toBe(6)
  })

  it('leaves an archived chat out too, because archiving already does that', () => {
    expect(counts({ archived: { writer: true } }).unread).toBe(3)
    expect(counts({ archived: { writer: true } }).size).toBe(1)
  })
})

describe('the rows a list draws', () => {
  it('draws a folder’s children only while it is open', () => {
    const open = folderRows(rowsInput()).map(row => row.key)
    const shut = folderRows(rowsInput({ collapsed: { f1: true } })).map(row => row.key)

    expect(open).toEqual(['bot:researcher', 'folder:f1', 'bot:writer', 'bot:bookkeeper', 'bot:postman'])
    expect(shut).toEqual(['bot:researcher', 'folder:f1', 'bot:postman'])
  })

  it('gives an open, empty folder a row of its own to drop into', () => {
    const rows = folderRows(rowsInput({ archived: { writer: true, bookkeeper: true } }))

    expect(rows.map(row => row.key)).toContain('folderEmpty:f1')
  })

  it('says which container each bot row is drawn in', () => {
    const rows = folderRows(rowsInput())

    expect(rows.find(row => row.key === 'bot:writer')).toMatchObject({ folderId: 'f1' })
    expect(rows.find(row => row.key === 'bot:researcher')).toMatchObject({ folderId: null })
  })
})

describe('where a drop lands', () => {
  const anchors = () => dragAnchors(rowsInput())

  it('offers a position above each row and one INSIDE each folder', () => {
    expect(anchors()).toEqual([
      { key: 'bot:researcher', target: { folderId: null, index: 0 } },
      { key: 'folder:f1', target: { folderId: null, index: 1 } },
      { key: 'folderIn:f1', target: { folderId: 'f1', index: 0 } },
      { key: 'bot:writer', target: { folderId: 'f1', index: 0 } },
      { key: 'bot:bookkeeper', target: { folderId: 'f1', index: 1 } },
      { key: 'bot:postman', target: { folderId: null, index: 2 } }
    ])
  })

  it('keeps the inside-the-folder position when the folder is closed', () => {
    // The case a drop line between children cannot reach, and the whole reason
    // the folder's own row carries a second anchor.
    expect(dragAnchors(rowsInput({ collapsed: { f1: true } }))).toEqual([
      { key: 'bot:researcher', target: { folderId: null, index: 0 } },
      { key: 'folder:f1', target: { folderId: null, index: 1 } },
      { key: 'folderIn:f1', target: { folderId: 'f1', index: 0 } },
      { key: 'bot:postman', target: { folderId: null, index: 2 } }
    ])
  })

  it('counts an archived chat’s position, even though its row is elsewhere', () => {
    // It keeps its place in the arrangement while being drawn in the drawer, so
    // counting only the visible rows would slide every drop below it by one.
    const list = dragAnchors(rowsInput({ archived: { writer: true } }))

    expect(list.find(anchor => anchor.key === 'bot:bookkeeper')?.target).toEqual({ folderId: 'f1', index: 1 })
  })

  it('reads the bottom half of a folder’s header as "into this folder"', () => {
    const list = anchors()
    const measured = {
      'bot:researcher': { y: 0, height: 40 },
      'folder:f1': { y: 40, height: 40 },
      'bot:writer': { y: 80, height: 40 },
      'bot:bookkeeper': { y: 120, height: 40 },
      'bot:postman': { y: 160, height: 40 }
    }
    const boxes = anchorBoxes(list, measured)
    const targetAt = (pointerY: number) => list[dropSlot(list, boxes, pointerY)]?.target

    // Above the header's midpoint: before the folder, at the top level.
    expect(targetAt(50)).toEqual({ folderId: null, index: 1 })
    // Below it: inside.
    expect(targetAt(65)).toEqual({ folderId: 'f1', index: 0 })
    // Past the header entirely: before its first child, still inside.
    expect(targetAt(90)).toEqual({ folderId: 'f1', index: 0 })
  })

  it('reads past the last row as the end of the top level', () => {
    const list = anchors()

    expect(list[dropSlot(list, {}, 9_999)]).toBeUndefined()
  })
})

describe('committing a drop', () => {
  it('writes nothing for a drop on either side of where the row already is', () => {
    const arrangement = sample()

    expect(isSamePlace(arrangement, 'writer', { folderId: 'f1', index: 0 })).toBe(true)
    expect(isSamePlace(arrangement, 'writer', { folderId: 'f1', index: 1 })).toBe(true)
    expect(isSamePlace(arrangement, 'writer', { folderId: 'f1', index: 2 })).toBe(false)
  })

  it('reads the same index in another container as a real move', () => {
    // Index 0 of the top level and index 0 of Finance are different places, so
    // "same index" alone is not a no-op.
    expect(isSamePlace(sample(), 'writer', { folderId: null, index: 0 })).toBe(false)
  })

  it('corrects for the row it is about to remove, within one container', () => {
    const arrangement = sample()

    // Dropping bookkeeper above nothing — index 2 of a two-long folder — is
    // index 1 once it has been taken out.
    expect(committedIndex(arrangement, 'bookkeeper', { folderId: 'f1', index: 2 })).toBe(1)
    // Moving up needs no correction.
    expect(committedIndex(arrangement, 'bookkeeper', { folderId: 'f1', index: 0 })).toBe(0)
  })

  it('does not correct a move into a container the row is not in', () => {
    expect(committedIndex(sample(), 'researcher', { folderId: 'f1', index: 2 })).toBe(2)
  })

  it('puts a chat where the drop said, end to end', () => {
    const arrangement = sample()
    const target = { folderId: 'f1' as string | null, index: 2 }

    expect(
      moveBotTo(arrangement, 'researcher', target.folderId, committedIndex(arrangement, 'researcher', target))
        .folders[0]?.bots
    ).toEqual(['writer', 'bookkeeper', 'researcher'])
  })

  it('takes a chat out of the last folder by dropping past the end', () => {
    const arrangement = sample()
    const target = { folderId: null, index: arrangement.entries.length }

    expect(
      folderOf(
        moveBotTo(arrangement, 'writer', target.folderId, committedIndex(arrangement, 'writer', target)),
        'writer'
      )
    ).toBeNull()
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
