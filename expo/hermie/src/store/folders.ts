/**
 * The chat list's arrangement, as folders.
 *
 * ADR-0012 put the list's groups in ONE flat array of positions — a `divider`
 * entry followed by the chats that belonged under it — because that made "move
 * this bot into that section" a swap of two adjacent positions rather than a
 * graft between two containers. It was the right shape for a heading and the
 * wrong one for a folder, and the difference is collapsing: a divider has no
 * inside, so there is nothing to close, nothing to count while it is closed and
 * nothing to drop a row onto. A folder has all three.
 *
 * So the arrangement is now two lists that mean one thing:
 *
 *  - `entries` — the TOP LEVEL, in order: folders and loose chats interleaved.
 *    A folder appears here by id only; its contents are not in this list.
 *  - `folders` — each folder's name, colour and the bots inside it, in order.
 *
 * **A bot is in exactly one place.** Either loose in `entries` or inside exactly
 * one folder, never both and never twice. That is not a convention this module
 * hopes callers keep: `normalise` enforces it on every read and every write, and
 * it is the invariant every other function here is allowed to assume. Two copies
 * of one row is a list where every drag is ambiguous.
 *
 * **Which bots exist is the roster's business, not this file's.** The
 * arrangement only ever says where a bot sits, so a bot the gateway no longer
 * has is dropped lazily by `reconcileBots` without disturbing anything around it
 * — exactly as ADR-0012 had it.
 *
 * Nothing here is a store and nothing here reads a clock. It is a value and the
 * functions that move it, which is what lets the migration, the invariant and
 * every drag be tested as arithmetic.
 */
import { ACCENTS, type AccentName } from '../ui/tokens'

/** One folder. `colour` absent is the default tint, as everywhere else. */
export interface Folder {
  id: string
  name: string
  colour?: AccentName
  bots: string[]
}

/**
 * One position at the top level.
 *
 * A folder is named by id rather than carried inline so that the top-level
 * order and a folder's contents are two independent edits: dragging a folder
 * past a chat touches `entries` alone, and dragging a bot within a folder
 * touches `folders` alone.
 */
export type LayoutEntry = { kind: 'folder'; id: string } | { kind: 'chat'; name: string }

export interface Arrangement {
  entries: LayoutEntry[]
  folders: Folder[]
}

export const EMPTY_ARRANGEMENT: Arrangement = { entries: [], folders: [] }

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const colourOf = (value: unknown): AccentName | undefined =>
  typeof value === 'string' && value in ACCENTS && value !== 'default' ? (value as AccentName) : undefined

let folderCounter = 0

/** Ids only have to be unique within one gateway's arrangement. */
export function newFolderId(): string {
  folderCounter += 1

  return `f${Date.now().toString(36)}${folderCounter.toString(36)}`
}

/**
 * Whether a string could be one of these ids.
 *
 * It exists because a folder id now travels in a URL — `hermie://folder/<id>`,
 * from a widget somebody pinned to a folder — and a URL scheme is registered
 * with the system, so any app on the device can send one. The ids this module
 * mints are `f` and base-36 digits; the check is a little wider than that
 * because the arrangement also arrives from a gateway (ADR-0016), where another
 * client may have written ids of its own shape.
 *
 * What it refuses is everything that is not a NAME: separators, dots, anything
 * that could be read as a path. A link naming something else answers nothing,
 * which is all a deep link is ever allowed to do here.
 */
export function isSafeFolderId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

/**
 * The invariant, applied.
 *
 * Four things, and all four are about a list that came from somewhere this
 * build does not control — the disk, the gateway, an older version of itself:
 *
 *  1. a bot appears at most once, the FIRST position winning;
 *  2. a folder's id appears at most once;
 *  3. a folder named in `entries` that has no definition is dropped, and a
 *     folder defined but never placed is appended, so neither list can point at
 *     something the other does not have;
 *  4. a folder's `bots` holds only names not already placed somewhere earlier.
 *
 * First-wins rather than last-wins because the top level is read before the
 * folders are: a bot that is both loose and inside a folder stays where the
 * reader can see it.
 */
export function normalise(entries: readonly LayoutEntry[], folders: readonly Folder[]): Arrangement {
  const byId = new Map<string, Folder>()

  for (const folder of folders) {
    if (folder.id && !byId.has(folder.id)) {
      byId.set(folder.id, folder)
    }
  }

  const placedBots = new Set<string>()
  const placedFolders = new Set<string>()
  const outEntries: LayoutEntry[] = []

  for (const entry of entries) {
    if (entry.kind === 'folder') {
      if (byId.has(entry.id) && !placedFolders.has(entry.id)) {
        placedFolders.add(entry.id)
        outEntries.push({ kind: 'folder', id: entry.id })
      }

      continue
    }

    if (entry.name && !placedBots.has(entry.name)) {
      placedBots.add(entry.name)
      outEntries.push({ kind: 'chat', name: entry.name })
    }
  }

  // A folder nobody placed still exists — it is appended rather than dropped,
  // because losing a folder loses every bot in it.
  for (const id of byId.keys()) {
    if (!placedFolders.has(id)) {
      placedFolders.add(id)
      outEntries.push({ kind: 'folder', id })
    }
  }

  const outFolders: Folder[] = []

  for (const entry of outEntries) {
    if (entry.kind !== 'folder') {
      continue
    }

    const folder = byId.get(entry.id) as Folder
    const bots: string[] = []

    for (const name of folder.bots) {
      if (name && !placedBots.has(name)) {
        placedBots.add(name)
        bots.push(name)
      }
    }

    outFolders.push({
      id: folder.id,
      name: typeof folder.name === 'string' ? folder.name : '',
      ...(folder.colour ? { colour: folder.colour } : {}),
      bots
    })
  }

  return { entries: outEntries, folders: outFolders }
}

/**
 * Read an arrangement off the wire or off the disk, migrating the old shape.
 *
 * `rawEntries` may be either list: the current one, whose only kinds are
 * `folder` and `chat`, or ADR-0012's, which carried `divider` entries inline.
 * A `divider` is turned into a folder holding every chat below it up to the
 * next divider, which is the only reading that preserves what the reader was
 * looking at — a heading's rows ARE its rows, and they stop where the next
 * heading starts.
 *
 * Deliberately not gated on a section version. Bumping `v` on the app-wide key
 * would make an older build read the whole section as unreadable, and a section
 * an older build cannot read is one it re-seeds from its own local copy — see
 * `seedWhatTheGatewayLacks`. That would not protect the folders, it would
 * hand a two-month-old phone the power to delete them. An additive field that
 * an older build simply does not mention is the safer half of the same trade.
 */
export function readArrangement(rawEntries: unknown, rawFolders: unknown): Arrangement {
  const entries: LayoutEntry[] = []
  const migrated: Folder[] = []
  let open: Folder | null = null

  for (const raw of Array.isArray(rawEntries) ? rawEntries : []) {
    if (!isObject(raw)) {
      continue
    }

    if (raw.kind === 'folder' && typeof raw.id === 'string' && raw.id) {
      open = null
      entries.push({ kind: 'folder', id: raw.id })
      continue
    }

    if (raw.kind === 'divider' && typeof raw.id === 'string' && raw.id) {
      open = {
        id: raw.id,
        name: typeof raw.name === 'string' ? raw.name : '',
        bots: []
      }
      migrated.push(open)
      entries.push({ kind: 'folder', id: raw.id })
      continue
    }

    if (raw.kind === 'chat' && typeof raw.name === 'string' && raw.name) {
      if (open) {
        open.bots.push(raw.name)
      } else {
        entries.push({ kind: 'chat', name: raw.name })
      }
    }
  }

  const folders: Folder[] = [...migrated]

  for (const raw of Array.isArray(rawFolders) ? rawFolders : []) {
    if (!isObject(raw) || typeof raw.id !== 'string' || !raw.id) {
      continue
    }

    folders.push({
      id: raw.id,
      name: typeof raw.name === 'string' ? raw.name : '',
      ...(colourOf(raw.colour) ? { colour: colourOf(raw.colour) as AccentName } : {}),
      bots: (Array.isArray(raw.bots) ? raw.bots : []).filter(
        (name): name is string => typeof name === 'string' && name.length > 0
      )
    })
  }

  return normalise(entries, folders)
}

/** Which folder holds this bot, or `null` for a loose one. */
export function folderOf(arrangement: Arrangement, botName: string): string | null {
  return arrangement.folders.find(folder => folder.bots.includes(botName))?.id ?? null
}

/** Every bot in the arrangement, in the order the list draws them. */
export function botsInOrder(arrangement: Arrangement): string[] {
  const out: string[] = []

  for (const entry of arrangement.entries) {
    if (entry.kind === 'chat') {
      out.push(entry.name)
      continue
    }

    out.push(...(arrangement.folders.find(folder => folder.id === entry.id)?.bots ?? []))
  }

  return out
}

/**
 * Fold the live roster in.
 *
 * New bots land at the end of the LOOSE top-level run, before the first folder:
 * the end of the list would bury them inside whatever folder happens to be
 * last, and the top would push them in front of the chat the reader is looking
 * at. Bots that no longer exist are dropped from wherever they were.
 */
export function reconcileBots(arrangement: Arrangement, botNames: readonly string[]): Arrangement {
  const live = new Set(botNames)
  const entries = arrangement.entries.filter(entry => entry.kind === 'folder' || live.has(entry.name))
  const folders = arrangement.folders.map(folder => ({
    ...folder,
    bots: folder.bots.filter(name => live.has(name))
  }))

  const placed = new Set(botsInOrder({ entries, folders }))
  const added = botNames.filter(name => !placed.has(name)).map<LayoutEntry>(name => ({ kind: 'chat', name }))

  if (!added.length && entries.length === arrangement.entries.length) {
    const unchanged = folders.every((folder, index) => folder.bots.length === arrangement.folders[index]?.bots.length)

    if (unchanged) {
      return arrangement
    }
  }

  const firstFolder = entries.findIndex(entry => entry.kind === 'folder')
  const at = firstFolder === -1 ? entries.length : firstFolder

  return normalise([...entries.slice(0, at), ...added, ...entries.slice(at)], folders)
}

/** Take one bot out of wherever it is. Used by every move. */
function withoutBot(arrangement: Arrangement, botName: string): Arrangement {
  return {
    entries: arrangement.entries.filter(entry => entry.kind === 'folder' || entry.name !== botName),
    folders: arrangement.folders.map(folder => ({ ...folder, bots: folder.bots.filter(name => name !== botName) }))
  }
}

/**
 * Put one bot at `index` of a folder, or of the top level when `folderId` is
 * null.
 *
 * The index is read against the target list WITHOUT the moving row, which is
 * the number a caller can actually compute once it knows where the drop line
 * landed. A bot moved within its own list therefore sees the same convention as
 * one moved between two, and there is no "did removing it shift me" correction
 * at any call site.
 */
export function moveBotTo(
  arrangement: Arrangement,
  botName: string,
  folderId: string | null,
  index: number
): Arrangement {
  if (folderId !== null && !arrangement.folders.some(folder => folder.id === folderId)) {
    return arrangement
  }

  /*
    A bot that is not in the arrangement is not moved INTO it.

    The roster is the source of truth for which bots exist and `reconcileBots`
    is the only thing allowed to add one; a move that also created a row would
    let a stale menu id, a deep link or a rename put a chat in the list that the
    gateway has never heard of. It cost a test, which is the right place to find
    out: `moveToFolder('nobody', null)` appended a row called `nobody`.
  */
  if (!botsInOrder(arrangement).includes(botName)) {
    return arrangement
  }

  const stripped = withoutBot(arrangement, botName)

  if (folderId === null) {
    const entries = [...stripped.entries]

    entries.splice(Math.max(0, Math.min(entries.length, index)), 0, { kind: 'chat', name: botName })

    return normalise(entries, stripped.folders)
  }

  const folders = stripped.folders.map(folder => {
    if (folder.id !== folderId) {
      return folder
    }

    const bots = [...folder.bots]

    bots.splice(Math.max(0, Math.min(bots.length, index)), 0, botName)

    return { ...folder, bots }
  })

  return normalise(stripped.entries, folders)
}

/** Put one bot at the END of a folder, or of the top level. The menu's move. */
export function moveBotToFolder(arrangement: Arrangement, botName: string, folderId: string | null): Arrangement {
  if (folderId === null) {
    const loose = withoutBot(arrangement, botName).entries.filter(entry => entry.kind === 'chat').length

    return moveBotTo(arrangement, botName, null, loose)
  }

  const folder = arrangement.folders.find(entry => entry.id === folderId)

  return folder ? moveBotTo(arrangement, botName, folderId, folder.bots.length) : arrangement
}

/** Move a folder itself to `index` of the top level, ignoring the loose chats. */
export function moveFolderTo(arrangement: Arrangement, folderId: string, index: number): Arrangement {
  const entries = arrangement.entries.filter(entry => !(entry.kind === 'folder' && entry.id === folderId))

  if (entries.length === arrangement.entries.length) {
    return arrangement
  }

  entries.splice(Math.max(0, Math.min(entries.length, index)), 0, { kind: 'folder', id: folderId })

  return normalise(entries, arrangement.folders)
}

/** A new, empty folder at the end of the top level. */
export function addFolder(arrangement: Arrangement, name: string, id = newFolderId()): Arrangement {
  return normalise([...arrangement.entries, { kind: 'folder', id }], [...arrangement.folders, { id, name, bots: [] }])
}

export function renameFolder(arrangement: Arrangement, id: string, name: string): Arrangement {
  return normalise(
    arrangement.entries,
    arrangement.folders.map(folder => (folder.id === id ? { ...folder, name } : folder))
  )
}

/** `default` is the absence of a choice, so it is stored as nothing. */
export function setFolderColour(arrangement: Arrangement, id: string, colour: AccentName): Arrangement {
  return normalise(
    arrangement.entries,
    arrangement.folders.map(folder => {
      if (folder.id !== id) {
        return folder
      }

      const { colour: _dropped, ...rest } = folder

      return colour === 'default' ? rest : { ...rest, colour }
    })
  )
}

/**
 * Delete a folder and keep every bot in it.
 *
 * Its rows come back to the top level AT THE FOLDER'S OWN POSITION, in their
 * own order, rather than at the end. Deleting a container should not also be a
 * reordering: the reader can still see where the group was, which is the only
 * outcome that never surprises them and never loses a chat.
 */
export function removeFolder(arrangement: Arrangement, id: string): Arrangement {
  const folder = arrangement.folders.find(entry => entry.id === id)

  if (!folder) {
    return arrangement
  }

  const entries: LayoutEntry[] = []

  for (const entry of arrangement.entries) {
    if (entry.kind === 'folder' && entry.id === id) {
      entries.push(...folder.bots.map<LayoutEntry>(name => ({ kind: 'chat', name })))
      continue
    }

    entries.push(entry)
  }

  return normalise(
    entries,
    arrangement.folders.filter(entry => entry.id !== id)
  )
}
