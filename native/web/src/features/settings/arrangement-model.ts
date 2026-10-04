/**
 * The arithmetic behind Settings, Chat list: what the page lists out of the arrangement and the
 * roster, how far one step up or down goes, and where a drop lands. None of it touches a store or the
 * DOM, so each rule is tested as a function.
 *
 * The arrangement (`state/folders.ts`) holds every chat of the roster, archived ones too, in a top level
 * of loose chats and folders and in each folder's own list. The page shows the archived ones apart, so a
 * step has to hop over the archived neighbours it cannot see, and a drop is read against the list as the
 * arrangement holds it, as `moveBotTo` and `moveFolderTo` read theirs: without the row that moves.
 */
import { type Arrangement, type Folder, moveBotTo, moveFolderTo } from '../../state/folders'

/** What the page draws at the top level, in order. */
export type ViewEntry = { kind: 'chat'; name: string } | { kind: 'folder'; id: string; folder: Folder; chats: string[] }

export interface ArrangementView {
  /** Loose chats and folders, archived chats left out (they have a list of their own). */
  entries: ViewEntry[]
  /** The archived chats, in the order the arrangement holds them. */
  archived: string[]
}

/**
 * The page's list: the arrangement as it is, the roster's bots the arrangement has not placed yet
 * (there is no connection to fold them in) where the native apps and the sidebar put them, at the end
 * of the loose top-level run before the first folder, and the archived ones set apart.
 */
export function viewOf(
  arrangement: Arrangement,
  archived: Readonly<Record<string, true>>,
  roster: readonly string[]
): ArrangementView {
  const placed = new Set<string>()

  for (const entry of arrangement.entries) {
    if (entry.kind === 'chat') {
      placed.add(entry.name)
    }
  }

  for (const folder of arrangement.folders) {
    for (const name of folder.bots) {
      placed.add(name)
    }
  }

  const unplaced = roster.filter(name => !placed.has(name))
  const entries: ViewEntry[] = []
  const archivedNames: string[] = []

  const loose = (name: string): void => {
    if (archived[name]) {
      archivedNames.push(name)
    } else {
      entries.push({ kind: 'chat', name })
    }
  }

  const top: Arrangement['entries'] = [...arrangement.entries]
  const firstFolder = top.findIndex(entry => entry.kind === 'folder')

  top.splice(
    firstFolder === -1 ? top.length : firstFolder,
    0,
    ...unplaced.map(name => ({ kind: 'chat', name }) as const)
  )

  for (const entry of top) {
    if (entry.kind === 'chat') {
      loose(entry.name)
      continue
    }

    const folder = arrangement.folders.find(candidate => candidate.id === entry.id)

    if (!folder) {
      continue
    }

    const chats: string[] = []

    for (const name of folder.bots) {
      if (archived[name]) {
        archivedNames.push(name)
      } else {
        chats.push(name)
      }
    }

    entries.push({ kind: 'folder', id: folder.id, folder, chats })
  }

  return { entries, archived: archivedNames }
}

/**
 * How many positions `moveBy` has to move `name` to step over to the next chat the reader can see,
 * in `direction` (-1 up, 1 down), or 0 when there is none that way. `container` is the list the
 * arrangement holds, archived chats included; `hidden` says which of them are not drawn.
 */
export function stepOffset(
  container: readonly string[],
  hidden: (name: string) => boolean,
  name: string,
  direction: -1 | 1
): number {
  const from = container.indexOf(name)

  if (from === -1) {
    return 0
  }

  for (let at = from + direction; at >= 0 && at < container.length; at += direction) {
    if (!hidden(container[at]!)) {
      return at - from
    }
  }

  return 0
}

/** The loose chats of the top level in the order the arrangement holds them: the list `moveBy` steps through. */
export const looseChats = (arrangement: Arrangement): string[] =>
  arrangement.entries.flatMap(entry => (entry.kind === 'chat' ? [entry.name] : []))

/**
 * The step a folder takes, in top-level positions (`moveFolderBy` counts every entry, loose chats
 * included), over archived loose chats that are not drawn. 0 when there is no visible entry that way.
 */
export function folderStepOffset(
  arrangement: Arrangement,
  archived: Readonly<Record<string, true>>,
  folderId: string,
  direction: -1 | 1
): number {
  const from = arrangement.entries.findIndex(entry => entry.kind === 'folder' && entry.id === folderId)

  if (from === -1) {
    return 0
  }

  for (let at = from + direction; at >= 0 && at < arrangement.entries.length; at += direction) {
    const entry = arrangement.entries[at]!

    if (entry.kind === 'folder' || !archived[entry.name]) {
      return at - from
    }
  }

  return 0
}

/** What is being dragged. */
export type Dragged = { kind: 'chat'; name: string } | { kind: 'folder'; id: string }

/** What it is over: a chat row or a folder's own row, and which half of it. */
export type Over = { kind: 'chat'; name: string; after: boolean } | { kind: 'folder'; id: string; after: boolean }

/** Where a drop lands, as the store's `dropBot` and `dropFolder` take it. */
export type Drop =
  { kind: 'chat'; name: string; folderId: string | null; index: number } | { kind: 'folder'; id: string; index: number }

/**
 * Where dropping `dragged` over `over` puts it, or `null` when that changes nothing or cannot be done.
 *
 *  - A chat over a chat goes before or after it, in the container that chat is in (a folder, or the top
 *    level, where the index counts folders too).
 *  - A chat over a folder's own row goes to the end of that folder.
 *  - A folder over anything goes before or after the top-level entry it is over (a chat inside a
 *    folder stands for that folder), because folders do not nest.
 */
export function dropOf(arrangement: Arrangement, dragged: Dragged, over: Over): Drop | null {
  let drop: Drop | null = null

  if (dragged.kind === 'chat') {
    if (over.kind === 'folder') {
      const folder = arrangement.folders.find(candidate => candidate.id === over.id)

      if (!folder) {
        return null
      }

      drop = {
        kind: 'chat',
        name: dragged.name,
        folderId: folder.id,
        index: folder.bots.filter(name => name !== dragged.name).length
      }
    } else {
      if (over.name === dragged.name) {
        return null
      }

      const folder = arrangement.folders.find(candidate => candidate.bots.includes(over.name))
      const list: string[] = folder
        ? folder.bots.filter(name => name !== dragged.name)
        : arrangement.entries
            .filter(entry => !(entry.kind === 'chat' && entry.name === dragged.name))
            .map(entry => (entry.kind === 'chat' ? `chat:${entry.name}` : `folder:${entry.id}`))
      const at = list.indexOf(folder ? over.name : `chat:${over.name}`)

      if (at === -1) {
        return null
      }

      drop = { kind: 'chat', name: dragged.name, folderId: folder?.id ?? null, index: at + (over.after ? 1 : 0) }
    }

    return changes(arrangement, drop) ? drop : null
  }

  // A folder: against the top level's entries as they are without it.
  const overKey =
    over.kind === 'folder'
      ? `folder:${over.id}`
      : (() => {
          const holder = arrangement.folders.find(candidate => candidate.bots.includes(over.name))

          return holder ? `folder:${holder.id}` : `chat:${over.name}`
        })()

  if (overKey === `folder:${dragged.id}`) {
    return null
  }

  const list = arrangement.entries
    .filter(entry => !(entry.kind === 'folder' && entry.id === dragged.id))
    .map(entry => (entry.kind === 'chat' ? `chat:${entry.name}` : `folder:${entry.id}`))
  const at = list.indexOf(overKey)

  if (at === -1) {
    return null
  }

  drop = { kind: 'folder', id: dragged.id, index: at + (over.after ? 1 : 0) }

  return changes(arrangement, drop) ? drop : null
}

/** Where a chat or a folder sits among what the reader can see: its container, its place and how many there are. */
export interface Placement {
  /** The folder holding it, or `null` at the top level. */
  folderId: string | null
  /** One-based. */
  index: number
  count: number
}

/**
 * Where a row is now, counted over what is drawn: a chat in a folder against that folder's visible
 * chats, a loose chat or a folder against the visible top-level entries. `null` for a row that is not
 * in the arrangement.
 */
export function placementOf(
  arrangement: Arrangement,
  archived: Readonly<Record<string, true>>,
  item: Dragged
): Placement | null {
  const folder =
    item.kind === 'chat' ? arrangement.folders.find(candidate => candidate.bots.includes(item.name)) : undefined

  if (folder && item.kind === 'chat') {
    const visible = folder.bots.filter(name => !archived[name])
    const at = visible.indexOf(item.name)

    return at === -1 ? null : { folderId: folder.id, index: at + 1, count: visible.length }
  }

  const keys = arrangement.entries.flatMap(entry =>
    entry.kind === 'folder' ? [`folder:${entry.id}`] : archived[entry.name] ? [] : [`chat:${entry.name}`]
  )
  const at = keys.indexOf(item.kind === 'chat' ? `chat:${item.name}` : `folder:${item.id}`)

  return at === -1 ? null : { folderId: null, index: at + 1, count: keys.length }
}

/** Would committing this drop change the arrangement? A drop onto the place a row already holds does not. */
function changes(arrangement: Arrangement, drop: Drop): boolean {
  const next =
    drop.kind === 'chat'
      ? moveBotTo(arrangement, drop.name, drop.folderId, drop.index)
      : moveFolderTo(arrangement, drop.id, drop.index)

  return JSON.stringify([next.entries, next.folders]) !== JSON.stringify([arrangement.entries, arrangement.folders])
}
