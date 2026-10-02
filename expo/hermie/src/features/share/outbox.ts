/**
 * What another app hands Hermie, as one file format.
 *
 * A share sheet is not the app. On iOS it is a separate process with its own
 * sandbox and a few seconds to live; on Android it is an intent that arrives
 * before anything here is signed in. Both write down what was shared, and this
 * module is that writing-down step, read back.
 *
 * Since ADR-0026 the iOS sheet may also SEND what it wrote, over the network,
 * before it goes away — which is the one sentence in this file's history that
 * changed. It does not change the format or who owns it: the entry is written
 * first and it is still the app that delivers everything the extension could
 * not. What it adds is the claim below, which is the only way an entry can now
 * be ambiguous rather than merely waiting.
 *
 * It is the exact mirror of `features/widgets/snapshot.ts`, and for the same
 * reason: one versioned JSON file in a container both sandboxes can reach,
 * produced by one side and consumed by the other, with a pure function on the
 * TypeScript side so that every way it can be malformed is a table in a test
 * rather than something discovered on a phone.
 *
 * ## The direction is the difference
 *
 * The snapshot is written by code in this repository and read by Swift. A
 * manifest is written by SWIFT (or Kotlin) and read here, which inverts who has
 * to be paranoid. A snapshot with a missing field is a bug in a pure function
 * with a test beside it; a manifest with a missing field is a bug in a process
 * that ran three seconds ago inside another app's share sheet, possibly from a
 * build older than this one. So `parseShareManifest` refuses rather than
 * repairs wherever a repair would be a guess, drops the individual items it
 * cannot trust, and keeps the entry only when something is left to send.
 *
 * ## Paths are the part that has to be hostile
 *
 * A manifest names its files by a path RELATIVE to its own directory, and that
 * path came from a filename another application chose. `screenshot.png` is the
 * ordinary case; `../../../Library/Preferences/x.plist` is why this is not a
 * string copy. Separators, `..`, leading dots and control characters are all
 * rejected outright rather than escaped, because there is no legitimate share
 * whose file lives in a subdirectory and an escape is this app making a
 * decision about somebody else's bytes.
 *
 * ## What is NOT here
 *
 * No I/O, no clock, no gateway and no idea of a chat. `share-delivery.ts` does
 * all of that. This answers one question, which is what the entry says.
 */

/** Bumped when a field changes meaning or goes. Adding an OPTIONAL one is free. */
export const SHARE_MANIFEST_VERSION = 1

/** The directory inside the shared container that holds the entries. */
export const SHARE_OUTBOX_DIRECTORY = 'share-outbox'

/** The file inside one entry's directory. Also spelled in Swift and in Kotlin. */
export const SHARE_MANIFEST_FILE = 'manifest.json'

/**
 * The second file an entry can hold: "somebody is sending this RIGHT NOW".
 *
 * It exists because the share extension may now deliver an entry itself
 * (ADR-0026) and there is a window between the gateway accepting the message
 * and the extension unlinking the entry. A process torn down inside that
 * window leaves an entry that may or may not have been sent, and the two ways
 * of guessing are both wrong: sending it produces a duplicate, dropping it
 * loses somebody's words.
 *
 * So the sender writes this file immediately BEFORE it submits and the app
 * treats an entry that has one as a question rather than as work. Nobody
 * guesses; the person who shared it decides, and they are shown what is known.
 */
export const SHARE_CLAIM_FILE = 'claim.json'

/** Bumped with `SHARE_MANIFEST_VERSION`'s rules. An unreadable claim is still a claim. */
export const SHARE_CLAIM_VERSION = 1

/**
 * The most items one share is allowed to carry.
 *
 * iOS hands a share sheet every photo somebody selected, and "select all" in
 * Photos is a real gesture. Each file becomes an upload and a `@file:` token in
 * ONE prompt, so the cap is about what a message can usefully be rather than
 * about memory: past a dozen the prompt is a directory listing. The native
 * sheet applies the same number, so the cut is made where somebody can still
 * see it happen.
 */
export const SHARE_ITEM_LIMIT = 12

/** The longest note the sheet accepts, and the longest one that is read back. */
export const SHARE_NOTE_LIMIT = 2_000

/**
 * What one shared thing is.
 *
 * `image` and `file` both name a copied file and differ only in how the app
 * sends them — an image goes over the socket as bytes (`image.attach_bytes`), a
 * file goes over HTTP and is referenced by path (see `file-upload.ts`). That
 * classification is made on the native side, where the UTI or the MIME type is
 * still available; by the time it reaches here there is only a name.
 *
 * `url` and `text` carry no file at all. They are kept apart rather than folded
 * into one because a URL is the single commonest thing anybody shares and it is
 * worth being able to say so — a later round that wants to fetch one, or title
 * one, needs the distinction and could not recover it from a string.
 */
export type ShareItemKind = 'image' | 'file' | 'url' | 'text'

export interface ShareItem {
  kind: ShareItemKind
  /**
   * The copied file's name inside the entry's own directory, for `image` and
   * `file`. Never a path: one segment, no separators. Absent for the other two.
   */
  path?: string
  /** What to call it in the chat. Falls back to `path` when the sender had none. */
  filename?: string
  /** Bytes, as the native side measured them. `0` when it could not. */
  size?: number
  /** Only ever a hint; the upload does not send it and the gateway re-sniffs. */
  mimeType?: string
  /** The whole content, for `url` and `text`. Absent for the other two. */
  text?: string
}

export interface ShareManifest {
  version: number
  /** Unique per share. Also the entry's directory name and the deep link's path. */
  id: string
  /**
   * Which chat this goes to, or absent.
   *
   * The iOS sheet always names one, because it can show the roster and let
   * somebody pick. Android's `ACTION_SEND` cannot — there is no sheet of ours
   * in that flow, only an intent — so an entry arrives with no bot and the app
   * asks. Absent is therefore not an error state; it is the second of the two
   * normal shapes, and the one the picker exists for.
   */
  bot?: string
  /** What was typed in the sheet's note field. Empty is ordinary. */
  note: string
  /** Unix SECONDS. Orders the queue, and ages an entry out. */
  createdAt: number
  items: ShareItem[]
}

/**
 * "This was handed to the gateway and the answer was not seen."
 *
 * Written by whichever process was about to submit, and read by the app as a
 * reason NOT to submit the same thing again. It carries a bot and a moment
 * rather than a verdict, because a verdict is exactly what the writer did not
 * live long enough to learn.
 */
export interface ShareClaim {
  version: number
  /** Which chat it was being sent to. Shown, so the question can be answered. */
  bot: string
  /** Unix SECONDS, from the claiming process's clock. */
  at: number
}

/**
 * Read a claim, or answer `null`.
 *
 * Much more forgiving than `parseShareManifest`, and deliberately: the existence
 * of the file is the load-bearing fact and its contents are only there to make
 * the question answerable. A claim whose JSON is broken still means "something
 * may have been sent", so it parses to a claim with an empty bot rather than to
 * nothing — the alternative is a corrupt byte turning an ambiguous entry back
 * into one the app sends without asking.
 */
export function parseShareClaim(json: string): ShareClaim | null {
  if (!json.trim()) {
    return null
  }

  let raw: unknown

  try {
    raw = JSON.parse(json)
  } catch {
    return { version: SHARE_CLAIM_VERSION, bot: '', at: 0 }
  }

  if (!isObject(raw)) {
    return { version: SHARE_CLAIM_VERSION, bot: '', at: 0 }
  }

  return { version: num(raw.version) || SHARE_CLAIM_VERSION, bot: str(raw.bot), at: num(raw.at) }
}

/** One entry as the bridge hands it over: the manifest, and where its files went. */
export interface ShareOutboxEntry {
  id: string
  /** The manifest file's bytes, exactly as the sharing process wrote them. */
  manifest: string
  /**
   * The claim file's bytes, when the entry has one. Absent is the ordinary case.
   *
   * Reported separately rather than left in `files` for the same reason the
   * manifest is: it is not something somebody shared, it is bookkeeping, and an
   * entry whose `files` contained it would send it as an attachment.
   */
  claim?: string
  /**
   * `path` → a local URI the upload can stream from.
   *
   * Resolved natively rather than joined here, because the two platforms put
   * the entry in different places and only the native side knows where its own
   * container is. A path with no entry has no file, which `parseShareEntry`
   * treats as an item to drop rather than an entry to refuse.
   */
  files: Record<string, string>
}

/** An entry that has been read, checked, and whose files are known to be there. */
export interface PendingShare {
  id: string
  /** Absent until somebody picks one. */
  bot?: string
  note: string
  createdAt: number
  items: ResolvedShareItem[]
  /**
   * Set when a previous sender got as far as submitting and did not report back.
   *
   * The app never delivers one of these on its own — see `share-delivery.ts`.
   * It is the one state in this feature that needs a person, and the picker is
   * where they are asked.
   */
  claim?: ShareClaim
}

/** A `ShareItem` whose file, if it has one, exists. */
export type ResolvedShareItem =
  | { kind: 'image' | 'file'; uri: string; filename: string; size: number; mimeType: string }
  | { kind: 'url' | 'text'; text: string }

const MAX_NAME_LENGTH = 200

const FALLBACK_MIME_TYPE = 'application/octet-stream'

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

/**
 * Whether a manifest path names a file inside the entry's own directory.
 *
 * Deliberately a whitelist of one shape rather than a blacklist of the ways
 * out: exactly one segment, no separator of either kind, no control character,
 * and not starting with a dot — which covers `.` and `..` without naming them.
 * A name that fails this is dropped with its item, because a share whose file
 * cannot be named is a share whose file cannot be sent.
 */
export function isSafeShareFileName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH) {
    return false
  }

  if (name.startsWith('.') || name.includes('/') || name.includes('\\')) {
    return false
  }

  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1f\x7f]/.test(name)
}

/** The same question for the entry id, which is a directory name AND a URL path. */
export function isSafeShareId(id: string): boolean {
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(id)
}

function parseItem(raw: unknown): ShareItem | null {
  if (!isObject(raw)) {
    return null
  }

  const kind = str(raw.kind)

  if (kind === 'url' || kind === 'text') {
    const text = str(raw.text).trim()

    return text ? { kind, text } : null
  }

  if (kind !== 'image' && kind !== 'file') {
    return null
  }

  const path = str(raw.path)

  if (!isSafeShareFileName(path)) {
    return null
  }

  const filename = str(raw.filename)
  const mimeType = str(raw.mimeType)

  return {
    kind,
    path,
    filename: isSafeShareFileName(filename) ? filename : path,
    size: num(raw.size),
    ...(mimeType ? { mimeType } : {})
  }
}

/**
 * Read one manifest, or answer `null`.
 *
 * Three refusals, and they are the whole contract: a version this build does
 * not understand, an id that is not a name, and an entry with nothing left in
 * it once the items have been checked. Everything else is repaired towards a
 * default, because a note that is not a string is one field written badly and
 * not a reason to lose somebody's photograph.
 *
 * An empty `items` with a non-empty note is NOT empty: sharing a note alone is
 * a message, which is the same thing the composer sends every day.
 */
export function parseShareManifest(json: string): ShareManifest | null {
  let raw: unknown

  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }

  if (!isObject(raw) || num(raw.version) !== SHARE_MANIFEST_VERSION) {
    return null
  }

  const id = str(raw.id)

  if (!isSafeShareId(id)) {
    return null
  }

  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(parseItem)
    .filter((item): item is ShareItem => item !== null)
    .slice(0, SHARE_ITEM_LIMIT)

  const note = str(raw.note).slice(0, SHARE_NOTE_LIMIT)

  if (!items.length && !note.trim()) {
    return null
  }

  const bot = str(raw.bot)

  return {
    version: SHARE_MANIFEST_VERSION,
    id,
    ...(bot ? { bot } : {}),
    note,
    createdAt: num(raw.createdAt),
    items
  }
}

/**
 * Pair a parsed manifest with the files the bridge actually found.
 *
 * An item whose file is missing is dropped rather than sent as a name with
 * nothing behind it. The entry then either still has something to say, in which
 * case it goes, or it does not, in which case this answers `null` and the
 * caller clears it. Both beat a message that references a file the bot cannot
 * open.
 *
 * The commonest way to reach that state is not corruption. It is the system
 * reclaiming a share extension's copied bytes before the app was next opened,
 * which is an ordinary thing for a phone to do to a week-old entry.
 */
export function parseShareEntry(entry: ShareOutboxEntry): PendingShare | null {
  const manifest = parseShareManifest(entry.manifest)

  if (!manifest || manifest.id !== entry.id) {
    return null
  }

  const items: ResolvedShareItem[] = []

  for (const item of manifest.items) {
    if (item.kind === 'url' || item.kind === 'text') {
      items.push({ kind: item.kind, text: item.text ?? '' })

      continue
    }

    const uri = item.path ? entry.files[item.path] : undefined

    if (!uri) {
      continue
    }

    items.push({
      kind: item.kind,
      uri,
      filename: item.filename || item.path || 'attachment',
      size: item.size ?? 0,
      mimeType: item.mimeType || FALLBACK_MIME_TYPE
    })
  }

  if (!items.length && !manifest.note.trim()) {
    return null
  }

  const claim = entry.claim === undefined ? null : parseShareClaim(entry.claim)

  return {
    id: manifest.id,
    ...(manifest.bot ? { bot: manifest.bot } : {}),
    note: manifest.note,
    createdAt: manifest.createdAt,
    items,
    ...(claim ? { claim } : {})
  }
}

const isWords = (item: ResolvedShareItem): item is Extract<ResolvedShareItem, { kind: 'url' | 'text' }> =>
  item.kind === 'url' || item.kind === 'text'

/**
 * The words of the message, before any attachment reference is appended.
 *
 * The note comes first, because it is what the person typed, and the URLs and
 * shared text follow it one paragraph each. A URL is NOT wrapped in anything:
 * the prompt is plain text, the bot reads it, and decorating it would be this
 * app inventing syntax the far side has never agreed to.
 *
 * `withFileReferences` appends the `@file:` tokens afterwards, in
 * `share-delivery.ts`, because that is the only place that knows where the
 * files landed.
 */
export function shareMessageText(share: PendingShare): string {
  const lines = share.items
    .filter(isWords)
    .map(item => item.text.trim())
    .filter(Boolean)

  return [share.note.trim(), ...lines].filter(Boolean).join('\n\n')
}

/** Every file this share will move, in order. */
export function shareFiles(share: PendingShare): Extract<ResolvedShareItem, { kind: 'image' | 'file' }>[] {
  return share.items.filter(
    (item): item is Extract<ResolvedShareItem, { kind: 'image' | 'file' }> =>
      item.kind === 'image' || item.kind === 'file'
  )
}

/**
 * One line naming what is waiting, for the badge's accessible label and the
 * picker's header.
 *
 * Counts rather than names, because a share of nine screenshots has no name
 * worth choosing between — and the reader already knows what they shared, they
 * did it a second ago.
 */
export function shareSummary(share: PendingShare): string {
  const files = shareFiles(share).length
  const words = shareMessageText(share)

  if (files && words) {
    return files === 1 ? '1 file and a message' : `${files} files and a message`
  }

  if (files) {
    return files === 1 ? '1 file' : `${files} files`
  }

  return words.length > 60 ? `${words.slice(0, 59)}…` : words
}

/** Oldest first, so a queue of shares arrives in the order somebody made them. */
export function sortShares(shares: readonly PendingShare[]): PendingShare[] {
  return [...shares].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
}
