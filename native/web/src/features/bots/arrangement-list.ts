/**
 * What the sidebar draws out of the chat list's arrangement and the roster, as a value.
 *
 * The rules are the native apps' (`ChatListArrangement` in `HermieCore`: `ordered`, `pinnedFirst`, the
 * archive), with the one thing this client draws that they do not, folders:
 *
 *  - **The roster says which chats exist.** A chat the arrangement holds and the roster does not have is
 *    dropped, from wherever it was, without disturbing what is around it. A folder keeps its place.
 *  - **A chat the arrangement has not placed yet** (new on the gateway, not folded in yet) comes at the end
 *    of the loose top-level run, before the first folder, in the roster's order: where `reconcileBots`
 *    writes it, so nothing jumps when the fold happens, and a new chat never lands inside a folder or
 *    disturbs an order somebody made. With no arrangement at all, the list is the roster's.
 *  - **Pinned chats are held at the top of their container**: loose pinned chats lead the top level,
 *    a folder's pinned chats lead that folder; each group keeps the order it had.
 *  - **Archived chats leave the list** wherever they were (loose or in a folder) and are returned apart,
 *    in the order the arrangement would have drawn them.
 *  - **A folder with nothing to show** (empty, or every chat in it archived or filtered out) is not drawn:
 *    the sidebar is for opening chats, and Settings is where folders are managed.
 *
 * Nothing here is a store and nothing reads a clock, so each rule is tested as a function.
 */
import type { AccentName, Arrangement } from '../../state/folders'

/** One folder as the sidebar draws it. */
export interface ListFolder<T> {
  id: string
  name: string
  colour: AccentName
  /** What is in it that can be shown, pinned first. */
  chats: T[]
}

/** What the sidebar draws at the top level, in order. */
export type ListEntry<T> = { kind: 'chat'; bot: T } | ({ kind: 'folder' } & ListFolder<T>)

export interface ListView<T> {
  entries: ListEntry<T>[]
  /** The archived chats (nothing but Unarchive brings one back). */
  archived: T[]
}

/** The names the arrangement places, in any container. */
function placedNames(arrangement: Arrangement): Set<string> {
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

  return placed
}

/** `items` with the pinned ones first, each group in the order it came. */
function pinnedFirst<T extends { name: string }>(items: readonly T[], pinned: Readonly<Record<string, true>>): T[] {
  return [...items.filter(item => pinned[item.name]), ...items.filter(item => !pinned[item.name])]
}

/**
 * The sidebar's list: the arrangement drawn over `bots` (the roster, narrowed by a search or not), the
 * archive set apart.
 */
export function listView<T extends { name: string }>(
  arrangement: Arrangement,
  archived: Readonly<Record<string, true>>,
  pinned: Readonly<Record<string, true>>,
  bots: readonly T[]
): ListView<T> {
  const byName = new Map(bots.map(bot => [bot.name, bot]))
  const placed = placedNames(arrangement)
  const unplaced = bots.filter(bot => !placed.has(bot.name))

  // Top-level positions, with the unplaced ones where the native rule puts them.
  const firstFolder = arrangement.entries.findIndex(entry => entry.kind === 'folder')
  const top = [...arrangement.entries]

  top.splice(
    firstFolder === -1 ? top.length : firstFolder,
    0,
    ...unplaced.map(bot => ({ kind: 'chat', name: bot.name }) as const)
  )

  const entries: ListEntry<T>[] = []
  const archivedBots: T[] = []

  for (const entry of top) {
    if (entry.kind === 'chat') {
      const bot = byName.get(entry.name)

      if (bot && archived[bot.name]) {
        archivedBots.push(bot)
      } else if (bot) {
        entries.push({ kind: 'chat', bot })
      }

      continue
    }

    const folder = arrangement.folders.find(candidate => candidate.id === entry.id)

    if (!folder) {
      continue
    }

    const inside: T[] = []

    for (const name of folder.bots) {
      const bot = byName.get(name)

      if (bot && archived[bot.name]) {
        archivedBots.push(bot)
      } else if (bot) {
        inside.push(bot)
      }
    }

    // A folder with nothing to show is not drawn.
    if (inside.length > 0) {
      entries.push({
        kind: 'folder',
        id: folder.id,
        name: folder.name,
        colour: folder.colour ?? 'default',
        chats: pinnedFirst(inside, pinned)
      })
    }
  }

  // Pinned loose chats lead the top level, each group in the order it had.
  const isPinnedLoose = (entry: ListEntry<T>): boolean => entry.kind === 'chat' && Boolean(pinned[entry.bot.name])

  entries.splice(0, entries.length, ...entries.filter(isPinnedLoose), ...entries.filter(entry => !isPinnedLoose(entry)))

  return { entries, archived: archivedBots }
}
