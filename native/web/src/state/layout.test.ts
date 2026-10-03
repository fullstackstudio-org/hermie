/**
 * The list's arrangement: order, folders, archive, colour.
 *
 * The arrangement's own arithmetic lives in `state/folders.ts` and is tested in
 * `folders.test.ts`. What is here is what the STORE adds to it: a lifetime, a
 * disk, and the open/closed set that never leaves the device.
 *
 * Ported from the Expo app's `__tests__/chat-layout-store.test.ts`. The jest
 * module mock of the disk is a memory-only key-value store per case, and the
 * cases about a gateway key are about the one store this page has: "a
 * different gateway" became "a different person" (`forgetPerson`), because
 * that is what forgets an arrangement here.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { createKeyValueStore, type WebKeyValueStore } from '../platform/key-value-store'
import { botsInOrder } from './folders'
import {
  archivedOf,
  botLabel,
  CHAT_LAYOUT_KEY,
  chatAccent,
  chatMuted,
  chatPinned,
  createLayoutStore,
  currentConversation,
  currentTargetOf,
  foldersOf,
  myChat,
  resolveSidebarCollapsed
} from './layout'

let layout = createLayoutStore()
let disk: WebKeyValueStore = createKeyValueStore({ namespace: 'test', storage: null })

const store = () => layout.getState()
/** The rows in reading order, with a folder's contents indented under it. */
const order = () => botsInOrder({ entries: store().entries, folders: store().folders })

/** The top level, with folders shown by name, so a case can say where one sits. */
const top = () =>
  store().entries.map(entry =>
    entry.kind === 'chat' ? entry.name : `#${store().folders.find(f => f.id === entry.id)?.name ?? '?'}`
  )

const arrangement = () => ({ entries: store().entries, folders: store().folders })

/** Writes are queued, so a test that reads the disk has to let the queue drain. */
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  layout = createLayoutStore()
  disk = createKeyValueStore({ namespace: 'test', storage: null })
})

describe('reconciling the arrangement with the roster', () => {
  it('builds the first arrangement from the roster order', () => {
    store().reconcile(['researcher', 'writer', 'bookkeeper'])

    expect(order()).toEqual(['researcher', 'writer', 'bookkeeper'])
  })

  it('lands a new bot before the first folder, not inside the last one', () => {
    store().reconcile(['researcher', 'writer'])
    store().addFolder('Finance')
    store().moveToFolder('writer', foldersOf(arrangement())[0]!.id)

    store().reconcile(['researcher', 'writer', 'postman'])

    // Inside the folder would bury it in a group it was never put in; the very
    // top would push it in front of whatever is being read.
    expect(top()).toEqual(['researcher', 'postman', '#Finance'])
    expect(order()).toEqual(['researcher', 'postman', 'writer'])
  })

  it('drops a bot the gateway no longer has, and keeps everything around it', () => {
    store().reconcile(['researcher', 'writer', 'postman'])
    store().addFolder('Work')
    store().moveToFolder('postman', foldersOf(arrangement())[0]!.id)

    store().reconcile(['researcher', 'postman'])

    expect(top()).toEqual(['researcher', '#Work'])
    expect(store().folders[0]?.bots).toEqual(['postman'])
  })

  it('does not rewrite the arrangement when nothing changed', () => {
    store().reconcile(['researcher', 'writer'])
    const before = store().entries

    store().reconcile(['researcher', 'writer'])

    // Same identity, so a list re-rendering on every roster poll is impossible.
    expect(store().entries).toBe(before)
  })
})

describe('moving rows', () => {
  beforeEach(() => store().reconcile(['researcher', 'writer', 'bookkeeper']))

  it('moves one position at a time', () => {
    store().moveBy('bookkeeper', -1)

    expect(order()).toEqual(['researcher', 'bookkeeper', 'writer'])
  })

  it('stops at the ends rather than wrapping', () => {
    store().moveBy('researcher', -5)
    expect(order()).toEqual(['researcher', 'writer', 'bookkeeper'])

    store().moveBy('bookkeeper', 9)
    expect(order()).toEqual(['researcher', 'writer', 'bookkeeper'])
  })

  /**
   * Up and down stay INSIDE the container, which is the one thing that changed
   * when the headings became folders.
   *
   * With dividers, stepping past a heading was how a bot changed section — one
   * flat array made "past the heading" and "past another chat" the same move. A
   * folder is a container: down means the next row inside it, and running off
   * the end into the next folder is not a step anybody asked for. Changing
   * folders now says which folder out loud.
   */
  it('does not walk a chat out of its folder', () => {
    const id = store().addFolder('Finance')

    store().moveToFolder('writer', id)
    store().moveToFolder('bookkeeper', id)

    store().moveBy('bookkeeper', 5)

    expect(store().folders[0]?.bots).toEqual(['writer', 'bookkeeper'])
    expect(top()).toEqual(['researcher', '#Finance'])
  })

  it('reorders within a folder', () => {
    const id = store().addFolder('Finance')

    store().moveToFolder('writer', id)
    store().moveToFolder('bookkeeper', id)

    store().moveBy('bookkeeper', -1)

    expect(store().folders[0]?.bots).toEqual(['bookkeeper', 'writer'])
  })

  it('moves to the end of a folder in one step', () => {
    const id = store().addFolder('Finance')

    store().moveToFolder('researcher', id)
    store().moveToFolder('writer', id)

    expect(top()).toEqual(['bookkeeper', '#Finance'])
    expect(store().folders[0]?.bots).toEqual(['researcher', 'writer'])
  })

  it('moves back out to the loose top level', () => {
    const id = store().addFolder('Finance')

    store().moveToFolder('researcher', id)
    store().moveToFolder('researcher', null)

    expect(store().folders[0]?.bots).toEqual([])
    expect(top()).toEqual(['writer', 'bookkeeper', 'researcher', '#Finance'])
  })

  it('ignores a move for a bot that is not in the arrangement', () => {
    const before = store().entries

    store().moveBy('nobody', 1)
    store().moveToFolder('nobody', null)

    // The same rows in the same order. `moveToFolder` normalises, so the array
    // identity is not the thing to assert; what it must not do is invent a row.
    expect(store().entries).toEqual(before)
  })
})

describe('folders', () => {
  beforeEach(() => store().reconcile(['researcher', 'writer']))

  it('renames in place', () => {
    const id = store().addFolder('Finace')

    store().renameFolder(id, 'Finance')

    expect(foldersOf(arrangement())).toEqual([{ id, name: 'Finance' }])
  })

  /**
   * Deleting a folder must never take rows with it. Its chats come back to the
   * top level at the folder's own position, which is the only outcome that
   * never loses a chat and never quietly reorders the list as well.
   */
  it('deletes the folder and keeps its chats where it stood', () => {
    const id = store().addFolder('Finance')

    store().moveToFolder('writer', id)
    store().removeFolder(id)

    expect(top()).toEqual(['researcher', 'writer'])
    expect(store().folders).toEqual([])
  })

  it('keeps an empty folder, so there is something to move a chat into', () => {
    store().addFolder('Finance')

    expect(store().folders[0]).toMatchObject({ bots: [], name: 'Finance' })
  })

  it('makes a new folder around the chat it was asked from', () => {
    const id = store().addFolderAround('writer', 'Money')

    expect(store().folders.find(folder => folder.id === id)?.bots).toEqual(['writer'])
    expect(top()).toEqual(['researcher', '#Money'])
  })

  /**
   * A folder moves a step at a time too, for the readers a grip does not serve.
   *
   * A step counts every top-level entry — folders and loose chats alike —
   * because that is what "up" means to somebody looking at the rows.
   */
  describe('moving a folder a step at a time', () => {
    it('steps up past a loose chat', () => {
      const id = store().addFolder('Finance')

      expect(top()).toEqual(['researcher', 'writer', '#Finance'])

      store().moveFolderBy(id, -1)
      expect(top()).toEqual(['researcher', '#Finance', 'writer'])

      store().moveFolderBy(id, -1)
      expect(top()).toEqual(['#Finance', 'researcher', 'writer'])
    })

    it('steps back down again, which is the index correction', () => {
      const id = store().addFolder('Finance')

      store().moveFolderBy(id, -2)
      expect(top()).toEqual(['#Finance', 'researcher', 'writer'])

      store().moveFolderBy(id, 1)
      expect(top()).toEqual(['researcher', '#Finance', 'writer'])

      store().moveFolderBy(id, 1)
      expect(top()).toEqual(['researcher', 'writer', '#Finance'])
    })

    it('stops at the ends rather than wrapping', () => {
      const id = store().addFolder('Finance')

      store().moveFolderBy(id, 9)
      expect(top()).toEqual(['researcher', 'writer', '#Finance'])

      store().moveFolderBy(id, -9)
      expect(top()).toEqual(['#Finance', 'researcher', 'writer'])
    })

    it('does nothing for a folder that is not there, and for no offset', () => {
      const id = store().addFolder('Finance')

      store().moveFolderBy('nothing', -1)
      store().moveFolderBy(id, 0)

      expect(top()).toEqual(['researcher', 'writer', '#Finance'])
    })
  })
})

describe('open and closed, on this device only', () => {
  beforeEach(() => store().reconcile(['researcher', 'writer']))

  it('starts open, because a folder nobody has closed has nothing to hide', () => {
    const id = store().addFolder('Finance')

    expect(store().collapsed[id]).toBeUndefined()
  })

  it('remembers a folder the reader closed', () => {
    const id = store().addFolder('Finance')

    store().setFolderOpen(id, false)
    expect(store().collapsed[id]).toBe(true)

    store().setFolderOpen(id, true)
    expect(store().collapsed[id]).toBeUndefined()
  })

  it('survives a reload of the same gateway', async () => {
    await store().load(disk)
    store().reconcile(['researcher', 'writer'])

    const id = store().addFolder('Finance')

    store().setFolderOpen(id, false)
    await settle()

    store().reset()
    await store().load(disk)

    expect(store().collapsed[id]).toBe(true)
  })

  it('forgets a folder that has been deleted', () => {
    const id = store().addFolder('Finance')

    store().setFolderOpen(id, false)
    store().removeFolder(id)

    expect(store().collapsed[id]).toBeUndefined()
  })
})

describe('archiving', () => {
  beforeEach(() => store().reconcile(['researcher', 'writer']))

  it('pulls a bot into the drawer without losing its place', () => {
    store().setArchived('writer', true)

    expect(archivedOf(arrangement(), store().archived)).toEqual(['writer'])

    store().setArchived('writer', false)

    // Back exactly where it was, because archiving never moved the entry.
    expect(order()).toEqual(['researcher', 'writer'])
    expect(archivedOf(arrangement(), store().archived)).toEqual([])
  })
})

describe('per-chat colour', () => {
  it('stores a colour and treats Default as the absence of one', () => {
    store().setAccent('writer', 'teal')
    expect(store().accents).toEqual({ writer: 'teal' })

    store().setAccent('writer', 'default')
    expect(store().accents).toEqual({})
  })
})

/**
 * The name a reader gives a bot.
 *
 * It lives here rather than on the bot's `ui_meta` section because no call a
 * client has writes a profile's `display_name` — see `features/bot-rename`. So it
 * is this reader's name, beside their colours and their folders, and the rules
 * are the colour's rules: an empty one is the absence of a name, and it is read
 * back defensively because it arrives from disk and from a gateway.
 */
describe('the name this reader gave a bot', () => {
  it('stores a name and treats an empty one as the absence of one', () => {
    store().setLabel('writer', 'De Schrijver')
    expect(store().labels).toEqual({ writer: 'De Schrijver' })

    store().setLabel('writer', '  ')
    expect(store().labels).toEqual({})
  })

  it('trims what it stores, so two names that look the same are the same', () => {
    store().setLabel('writer', '  De Schrijver  ')

    expect(store().labels.writer).toBe('De Schrijver')
  })

  it('reads a gateway’s copy defensively, and absent is not empty', () => {
    store().setLabel('writer', 'De Schrijver')

    // A build that predates the field says nothing about names; taking that as
    // "nobody has named anything" would un-name every bot on the gateway.
    store().applyRemote({})
    expect(store().labels).toEqual({ writer: 'De Schrijver' })

    store().applyRemote({ labels: { writer: 'Writer', researcher: 42 as unknown as string, '': 'x' } })
    expect(store().labels).toEqual({ writer: 'Writer' })
  })

  it('reads it back off the disk it was written to', async () => {
    await store().load(disk)
    store().setLabel('writer', 'De Schrijver')
    await settle()

    store().reset()
    await store().load(disk)

    expect(store().labels.writer).toBe('De Schrijver')
  })
})

describe('persistence, keyed by gateway', () => {
  it('starts empty for a gateway it has never seen', async () => {
    await store().load(disk)

    expect(store().entries).toEqual([])
    expect(store().loaded).toBe(true)
  })

  it('reads back what it wrote', async () => {
    await store().load(disk)
    store().reconcile(['researcher', 'writer'])
    store().setAccent('writer', 'violet')
    store().setArchived('researcher', true)
    await settle()

    store().reset()
    await store().load(disk)

    expect(order()).toEqual(['researcher', 'writer'])
    expect(store().accents).toEqual({ writer: 'violet' })
    expect(store().archived).toEqual({ researcher: true })
  })

  /**
   * A different person on this browser starts from nothing: the arrangement is
   * one person's. Their bots' archive and colours stay, because those are about
   * the bots (they ride on each bot's own section, not on the person's key).
   */
  it('forgets one person’s arrangement and keeps what is about the bots', async () => {
    await store().load(disk)
    store().reconcile(['researcher', 'writer'])
    store().addFolder('Finance')
    store().setPinned('writer', true)
    store().setLabel('writer', 'De Schrijver')
    store().setMute('writer', 0)
    store().setCurrent('researcher', 'sess-ideas')
    store().setAccent('researcher', 'red')
    store().setArchived('writer', true)

    store().forgetPerson()
    await settle()

    expect(store().entries).toEqual([])
    expect(store().folders).toEqual([])
    expect(store().pinned).toEqual({})
    expect(store().labels).toEqual({})
    expect(store().mutes).toEqual({})
    expect(store().current).toEqual({})
    expect(store().myChats).toEqual({})
    expect(store().accents).toEqual({ researcher: 'red' })
    expect(store().archived).toEqual({ writer: true })

    store().reset()
    await store().load(disk)

    expect(store().entries).toEqual([])
    expect(store().accents).toEqual({ researcher: 'red' })
  })

  it('survives a blob an older build wrote, rather than throwing on it', async () => {
    disk.setSync(
      CHAT_LAYOUT_KEY,
      JSON.stringify({
        entries: [
          { kind: 'chat', name: 'writer' },
          // Junk an older build might have left: a duplicate, a nameless
          // divider, and something that is neither.
          { kind: 'chat', name: 'writer' },
          { kind: 'divider', name: 'no id' },
          { kind: 'mystery' },
          null
        ],
        archived: ['writer', 7],
        accents: { writer: 'teal', researcher: 'chartreuse' }
      })
    )

    await store().load(disk)

    expect(order()).toEqual(['writer'])
    expect(store().archived).toEqual({ writer: true })
    // An unknown colour is dropped rather than carried into the theme.
    expect(store().accents).toEqual({ writer: 'teal' })
  })

  it('writes nothing before a store is known', async () => {
    store().reconcile(['researcher'])
    await settle()

    expect(disk.getSync(CHAT_LAYOUT_KEY)).toBeNull()
  })

  it('is stored under an identity-bound key, so a sign-out forgets it', async () => {
    await store().load(disk)
    store().reconcile(['researcher'])
    await settle()

    expect(disk.clearIdentityBound()).toContain(CHAT_LAYOUT_KEY)
  })
})

/**
 * The colour picked in the options sheet is the colour the list shows.
 *
 * There is one store behind both pickers (ADR-0012), which is what makes the
 * retint live: the header ring, the selected row and the outgoing bubble all
 * read `accents[bot]` through `useChatAccent`, so a write here reaches every one
 * of them on the next render without anything being told to refresh.
 */
describe('one accent, read by every surface', () => {
  beforeEach(() => store().reset())

  it('is the same value whichever picker wrote it', () => {
    store().setAccent('researcher', 'teal')

    expect(store().accents.researcher).toBe('teal')

    // The row menu setting it back is the same call on the same key.
    store().setAccent('researcher', 'magenta')

    expect(store().accents.researcher).toBe('magenta')
  })

  it('stores Default as the absence of a choice rather than as a ninth colour', () => {
    store().setAccent('researcher', 'teal')
    store().setAccent('researcher', 'default')

    expect(store().accents).toEqual({})
  })

  it('does not touch any other chat', () => {
    store().setAccent('researcher', 'teal')
    store().setAccent('writer', 'orange')

    expect(store().accents).toEqual({ researcher: 'teal', writer: 'orange' })
  })
})

/**
 * Which conversation each bot is on (sub-chats).
 *
 * `current` is the new map; `myChats` stays beside it as the projection older
 * builds read. What the store adds is the invariant between the two — every bot
 * with a `current` is in `myChats`, and a bot in `myChats` without one is a
 * legacy entry — kept whichever half was written, and by whom.
 */
describe('the conversation each bot is on', () => {
  it('remembers an own chat by id and projects it into myChats', () => {
    store().setCurrent('researcher', 'sess-ideas')

    expect(store().current).toEqual({ researcher: 'sess-ideas' })
    expect(store().myChats).toEqual({ researcher: true })
    expect(currentTargetOf(store(), 'researcher')).toBe('sess-ideas')
  })

  it('removes the entry and its projection on the group chat', () => {
    store().setCurrent('researcher', 'sess-ideas')
    store().setCurrent('researcher', null)

    expect(store().current).toEqual({})
    expect(store().myChats).toEqual({})
    expect(currentTargetOf(store(), 'researcher')).toBeUndefined()
  })

  it('reads a legacy entry as the bare-lead chat until something resolves it', () => {
    store().setMyChat('researcher', true)

    expect(currentTargetOf(store(), 'researcher')).toBeNull()

    store().setCurrent('researcher', 'sess-legacy', { chore: true })

    expect(currentTargetOf(store(), 'researcher')).toBe('sess-legacy')
  })

  it('counts a correction as a chore and a pick as nothing of the kind', () => {
    const before = store().chores

    store().setCurrent('researcher', 'sess-picked')

    expect(store().chores).toBe(before)

    store().setCurrent('researcher', null, { chore: true })

    expect(store().chores).toBe(before + 1)
  })

  it('treats the switch back to "shared" as the group chat, forgetting the id too', () => {
    store().setCurrent('researcher', 'sess-ideas')
    store().setMyChat('researcher', false)

    expect(store().current).toEqual({})
    expect(store().myChats).toEqual({})
  })

  it('keeps the map when a gateway copy says nothing about it', () => {
    store().setCurrent('writer', 'sess-drafts')
    store().applyRemote({ myChats: ['researcher'] })

    expect(store().current).toEqual({ writer: 'sess-drafts' })
    // The older build's list is taken, and the writer is put back into it.
    expect(store().myChats).toEqual({ researcher: true, writer: true })
  })

  it('replaces the map when a gateway copy carries one, empty included', () => {
    store().setCurrent('writer', 'sess-drafts')
    store().applyRemote({ current: { researcher: 'sess-ideas' }, myChats: ['researcher'] })

    expect(store().current).toEqual({ researcher: 'sess-ideas' })
    expect(store().myChats).toEqual({ researcher: true })

    store().applyRemote({ current: {}, myChats: [] })

    expect(store().current).toEqual({})
    expect(store().myChats).toEqual({})
  })

  it('does not turn a bot moved back to its group chat into a legacy entry', () => {
    store().setMyChat('bookkeeper', true)
    store().setCurrent('writer', 'sess-drafts')
    // A `current` with no `myChats` beside it: the writer is on its group chat
    // now, and the bookkeeper's legacy entry is untouched.
    store().applyRemote({ current: {} })

    expect(store().current).toEqual({})
    expect(store().myChats).toEqual({ bookkeeper: true })
  })

  it('reads a gateway copy defensively', () => {
    const wire = { researcher: 'sess-ideas', writer: '', '': 'sess-x', bookkeeper: 7 } as unknown

    store().applyRemote({ current: wire as Record<string, string> })

    expect(store().current).toEqual({ researcher: 'sess-ideas' })
  })

  it('survives a reload, and an older blob with no map reads as empty', async () => {
    await store().load(disk)
    store().setCurrent('researcher', 'sess-ideas')
    store().setMyChat('writer', true)
    await settle()

    store().reset()
    await store().load(disk)

    expect(store().current).toEqual({ researcher: 'sess-ideas' })
    expect(store().myChats).toEqual({ researcher: true, writer: true })

    disk.setSync(CHAT_LAYOUT_KEY, JSON.stringify({ entries: [], archived: [], accents: {}, myChats: ['writer'] }))
    store().reset()
    await store().load(disk)

    expect(store().current).toEqual({})
    expect(currentTargetOf(store(), 'writer')).toBeNull()
  })

  it('restores the projection from disk even when a blob lost it', async () => {
    disk.setSync(
      CHAT_LAYOUT_KEY,
      JSON.stringify({ entries: [], archived: [], accents: {}, current: { writer: 'sess-drafts' } })
    )

    await store().load(disk)

    expect(store().myChats).toEqual({ writer: true })
  })
})

describe('the conversation column, on this device only', () => {
  it('starts with no choice and remembers Hide across a reload', async () => {
    await store().load(disk)

    expect(store().conversationsCollapsed).toBeUndefined()

    store().setConversationsCollapsed(true)
    await settle()
    store().reset()
    await store().load(disk)

    expect(store().conversationsCollapsed).toBe(true)
  })

  it('is never replaced by a gateway copy', () => {
    // A patch carrying the field anyway, as a confused writer might send it.
    const wire = { conversationsCollapsed: false } as unknown as Parameters<ReturnType<typeof store>['applyRemote']>[0]

    store().setConversationsCollapsed(true)
    store().applyRemote(wire)

    expect(store().conversationsCollapsed).toBe(true)
  })
})

describe('the selectors a screen reads', () => {
  it('answer per chat, from the state they are handed', () => {
    store().setMute('writer', 2_000)
    store().setPinned('writer', true)
    store().setCurrent('researcher', 'sess-ideas')
    store().setAccent('writer', 'teal')
    store().setLabel('writer', 'De Schrijver')

    expect(chatMuted(store(), 'writer', 1_000)).toBe(true)
    expect(chatMuted(store(), 'writer', 3_000)).toBe(false)
    expect(chatPinned(store(), 'writer')).toBe(true)
    expect(myChat(store(), 'researcher')).toBe(true)
    expect(currentConversation(store(), 'researcher')).toBe('sess-ideas')
    expect(chatAccent(store(), 'writer')).toBe('teal')
    expect(chatAccent(store(), 'researcher')).toBe('default')
    expect(botLabel(store(), 'writer')).toBe('De Schrijver')
    expect(botLabel(store(), undefined)).toBe('')
  })

  it('lets the window width decide the sidebar only where nobody has', () => {
    expect(resolveSidebarCollapsed(undefined, 800)).toBe(true)
    expect(resolveSidebarCollapsed(undefined, 1200)).toBe(false)
    expect(resolveSidebarCollapsed(false, 800)).toBe(false)
    expect(resolveSidebarCollapsed(true, 1200)).toBe(true)
  })
})
