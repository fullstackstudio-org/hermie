/** Small, dependency-free formatters shared by the chat components. */
import { type ChatPreview, chatRowPreview, type MessageAuthor } from '@hermie/transcript'

import { plainTextPreview } from '../markdown/plain-text'
import { ACCENTS, SENDER_INK_ORDER, type Scheme } from '../ui/tokens'

/** `12:48`, in the device's locale-independent 24h-or-not default. */
export function formatClock(unixSeconds: number | undefined): string {
  if (!unixSeconds) {
    return ''
  }

  const date = new Date(unixSeconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')

  return `${hours}:${minutes}`
}

/** `0.4s`, `12s`, `1m 12s`, `1h 04m` — the tool-card and agents-bar dial. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
    return ''
  }

  if (seconds < 10) {
    return `${Math.round(seconds * 10) / 10}s`
  }

  if (seconds < 60) {
    return `${Math.round(seconds)}s`
  }

  const totalMinutes = Math.floor(seconds / 60)
  const restSeconds = Math.round(seconds % 60)

  if (totalMinutes < 60) {
    return `${totalMinutes}m ${String(restSeconds).padStart(2, '0')}s`
  }

  const hours = Math.floor(totalMinutes / 60)

  return `${hours}h ${String(totalMinutes % 60).padStart(2, '0')}m`
}

/**
 * `0:42`, `1:12`, `1:02:33` — a running clock, for the agents bar.
 *
 * Not `formatDuration`. The bar's number ticks every second in a fixed slot, and
 * `1m 12s` changes WIDTH as it counts (`9s` → `10s` → `1m 00s`), which shoves
 * the "Show" beside it left and right once a second — the one thing a bar the
 * design board calls static must not do. A colon clock only ever grows, and only
 * at a minute or an hour.
 */
export function formatElapsedClock(seconds: number | undefined): string {
  if (seconds === undefined || Number.isNaN(seconds) || seconds < 0) {
    return '0:00'
  }

  const whole = Math.floor(seconds)
  const minutes = Math.floor(whole / 60)
  const rest = String(whole % 60).padStart(2, '0')

  if (minutes < 60) {
    return `${minutes}:${rest}`
  }

  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}`
}

/** `1.2k`, `912` — token counts in a bubble footer. */
export function formatCount(value: number | undefined): string {
  if (value === undefined || Number.isNaN(value)) {
    return ''
  }

  if (value < 1000) {
    return String(value)
  }

  if (value < 1_000_000) {
    return `${Math.round(value / 100) / 10}k`
  }

  return `${Math.round(value / 100_000) / 10}M`
}

/**
 * Does this reply get the READING treatment?
 *
 * §6.3 and §7.1: a long reply drops the frosted interior for the near-opaque
 * `bubbleInRead` wash, looser leading and more generous padding. That is not a
 * stylistic variant — it is the only way body-text contrast becomes a fixed
 * number instead of a function of whatever wallpaper is behind the bubble, and a
 * wall of text is exactly where that matters.
 *
 * The test is deliberately crude and cheap: it runs on every streaming flush. A
 * fenced block or a table qualifies at any length, because both are wide machine
 * text that has to sit on a known surface to be readable at all.
 */
export function needsReadingTreatment(text: string): boolean {
  if (text.length >= 480) {
    return true
  }

  if (text.includes('```')) {
    return true
  }

  // A table's delimiter row is the one line whose shape is unambiguous.
  return /^\s*\|?[\s:-]*-{2,}[\s:|-]*$/m.test(text)
}

/** `4 KB`, `1.2 MB`, `98.4 MB` — an attachment's size on a chip. */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes < 0 || Number.isNaN(bytes)) {
    return ''
  }

  if (bytes < 1024) {
    return `${bytes} B`
  }

  const kilobytes = bytes / 1024

  if (kilobytes < 1024) {
    return `${Math.round(kilobytes)} KB`
  }

  const megabytes = kilobytes / 1024

  return megabytes < 1024 ? `${Math.round(megabytes * 10) / 10} MB` : `${Math.round((megabytes / 1024) * 10) / 10} GB`
}

/**
 * Ellipsise the HEAD of a file name and keep the tail.
 *
 * The extension is the most informative part of a file name, so it is the part
 * that survives: `…-final-v4.xlsx` tells a reader more than `Q3-report-fin…`.
 */
export function middleTruncate(name: string, max = 28): string {
  if (name.length <= max) {
    return name
  }

  // Keep a couple of leading characters as well: a tail alone loses which of
  // three similarly-named exports this is.
  const head = Math.max(0, Math.floor((max - 1) / 3))
  const tail = max - 1 - head

  return `${name.slice(0, head)}…${name.slice(name.length - tail)}`
}

/** One line, whitespace collapsed, ellipsised. */
export function clipInline(value: string, max = 80): string {
  const collapsed = value.replace(/\s+/g, ' ').trim()

  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed
}

/**
 * One clipped line of a reply, with the markdown taken off.
 *
 * Every preview in the app is the raw text of a message, and a message from a
 * model is markdown — the owner read `## Retry semantics: what actu…` off a chat
 * row, where two hashes and a space bought nothing and the sentence was cut
 * anyway. Anywhere a single line stands for a whole reply goes through here: the
 * chat list row, an Activity row, and a bot-to-bot line and its quoted answer.
 */
export function previewLine(value: string, max = 80): string {
  return clipInline(plainTextPreview(value), max)
}

/** The initial a generated avatar shows. */
export function initialFor(name: string): string {
  const first = name.trim()[0]

  return first ? first.toUpperCase() : '?'
}

/**
 * A stable tint index for a name, so the same bot always gets the same avatar
 * colour without anyone storing one.
 */
export function tintIndex(name: string, buckets: number): number {
  let hash = 0

  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0
  }

  return buckets > 0 ? hash % buckets : 0
}

/** How far a sender label or a stripped identity may run before it is cut. */
const SENDER_NAME_LIMIT = 80

/**
 * Unicode's own bucket for this: category Cf, "format" — text with no shape
 * and no width of its own, present only to change how the characters AROUND it
 * lay out or render. The bidi embeddings and overrides (U+202A..U+202E), the
 * bidi isolates (U+2066..U+2069), the directional marks (U+200E, U+200F,
 * U+061C), the zero-width space (U+200B) and the BOM (U+FEFF) are all members
 * of it — a colleague called "\u202Eetaged" otherwise reverses every line their
 * name leads, the chat-list preview and an export line included.
 *
 * A whole category is dropped, rather than that hand-picked list, because Cf
 * is bigger than the characters anyone had reason to test with: the WORD
 * JOINER (U+2060, invisible and just as capable of hiding a name as U+200B)
 * and the 128 TAG characters (U+E0000..U+E007F, an invisible sub-alphabet
 * Unicode reserves for language-tagging and for the flag-sequence encodings
 * built on it) both slipped through the old list untested and unnoticed. The
 * category test needs no such list kept in step with Unicode by hand.
 *
 * Two members are kept, because dropping them changes what a name's
 * characters ARE rather than how they lay out: ZERO WIDTH JOINER (U+200D),
 * without which an emoji sequence — a family, a profession, a skin tone on a
 * couple — falls apart into its plain pieces, and ZERO WIDTH NON-JOINER
 * (U+200C), which Persian and other scripts need to keep two letters from
 * ligating into one.
 */
const FORMAT_CHAR = /\p{Cf}/u

function isStrippedFormatChar(codePoint: number): boolean {
  if (codePoint === 0x200c || codePoint === 0x200d) {
    return false
  }

  return FORMAT_CHAR.test(String.fromCodePoint(codePoint))
}

/** C0 and C1 controls, DEL included: never text, but they may separate two words. */
function isControl(codePoint: number): boolean {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}

/** A surrogate standing on its own: `Array.from` yields a PAIR as one code point above U+FFFF. */
function isLoneSurrogate(codePoint: number): boolean {
  return codePoint >= 0xd800 && codePoint <= 0xdfff
}

/** Unicode's combining marks (Mn, Mc, Me): drawn ON TOP of the character before them, not beside it. */
const COMBINING_MARK = /\p{M}/u

/**
 * How many combining marks may stack on one base character before the rest
 * are dropped. A name is one line among many in a list or a transcript, and a
 * base letter is drawn once; every mark past a handful adds height rather than
 * meaning, drawing tall over the row above it, and there is no legitimate
 * script this cuts into — ordinary combining stacks, Vietnamese and Hebrew
 * cantillation among the tallest, run to two or three marks.
 */
const MAX_COMBINING_MARKS = 3

/**
 * One line of a name, safe to lead a line with: controls become a space, the
 * layout-changing invisibles above and any lone surrogate are dropped, a run
 * of combining marks longer than `MAX_COMBINING_MARKS` is cut back to it,
 * whitespace is collapsed, and the result is cut at `limit` CODE POINTS —
 * never UTF-16 units, which could leave half of an astral character behind.
 *
 * Written here rather than imported from anywhere: the chat kit takes items
 * and callbacks and carries no runtime dependency on the gateway layer.
 */
function cleanSenderText(value: string, limit = Number.POSITIVE_INFINITY): string {
  let spaced = ''
  // Resets on anything that is not itself a combining mark: a space, a
  // control turned into one, or an ordinary base character starts a new run.
  let combiningRun = 0

  for (const character of Array.from(value)) {
    const codePoint = character.codePointAt(0) ?? 0

    if (isControl(codePoint)) {
      spaced += ' '
      combiningRun = 0
    } else if (isStrippedFormatChar(codePoint) || isLoneSurrogate(codePoint)) {
      continue
    } else if (COMBINING_MARK.test(character)) {
      combiningRun += 1

      if (combiningRun <= MAX_COMBINING_MARKS) {
        spaced += character
      }
    } else {
      spaced += character
      combiningRun = 0
    }
  }

  const flat = spaced.split(/\s+/u).filter(Boolean).join(' ')
  const points = Array.from(flat)

  return points.length > limit ? points.slice(0, limit).join('').trimEnd() : flat
}

/**
 * Hangul reserves three JAMO FILLER code points (U+115F, U+1160, U+3164) to
 * hold a syllable block together when one of its parts is left out — visible
 * to Unicode as ordinary letters, so `isStrippedFormatChar` never touches
 * them, and visible to a reader as nothing at all. Beside the two joiners
 * `isStrippedFormatChar` deliberately keeps, which draw nothing without a real
 * character on either side, and whitespace: a name built only from this set
 * survives cleaning as a non-empty string and still shows no name.
 */
const BLANK_WHEN_ALONE = /^(?:\s|\u115f|\u1160|\u200c|\u200d|\u3164)*$/u

/** Whether a cleaned name has no character left in it that a reader could see. */
function isBlankName(value: string): boolean {
  return BLANK_WHEN_ALONE.test(value)
}

/** `authentik:7f3a…` → `7f3a…`, and an issuer URL used as a subject left alone. */
const PROVIDER_PREFIX = /^[A-Za-z][A-Za-z0-9._-]*:(?!\/\/)(.+)$/u

/**
 * The name a sender's label shows, for EVERY surface that shows one — the
 * bubble's label, its screen-reader announcement, the chat-list preview and the
 * export all get it from here, so they all get the same cleaned name.
 *
 * D4's rungs, each cleaned on read by `cleanSenderText` before it is trusted,
 * and the first that is not empty after cleaning wins:
 *
 *  1. `directory` — the host's own name for this identity, when it has one
 *     (the `context.users` directory D4 describes; nothing supplies one today);
 *  2. the gateway's own stamped `author.name`;
 *  3. the identity with its provider prefix stripped — never prettified,
 *     because guessing a person's name out of an opaque id would put a wrong
 *     name on screen.
 *
 * Every rung is text somebody else authored, a stamped name included (the
 * gateway takes it from the identity provider), so none is exempt.
 */
export function senderLabel(author: MessageAuthor, directory?: (author: MessageAuthor) => string): string {
  const fromDirectory = cleanSenderText(directory?.(author) ?? '', SENDER_NAME_LIMIT)

  // `isBlankName` catches what a plain emptiness check cannot: a name built
  // only from a Hangul filler, a lone joiner or whitespace cleans to a
  // NON-empty string that still shows nothing, and an invisible label is worse
  // than falling through to the next rung.
  if (!isBlankName(fromDirectory)) {
    return fromDirectory
  }

  const stamped = cleanSenderText(author.name ?? '', SENDER_NAME_LIMIT)

  if (!isBlankName(stamped)) {
    return stamped
  }

  const id = cleanSenderText(author.id)

  return cleanSenderText(PROVIDER_PREFIX.exec(id)?.[1] ?? id, SENDER_NAME_LIMIT)
}

/** `senderLabel` with nothing but the row itself to go on: D4's rungs 2 and 3. */
export function fallbackSenderName(author: MessageAuthor): string {
  return senderLabel(author)
}

/**
 * The colour a sender's name and avatar circle are keyed to — deterministic
 * from their IDENTITY, never their name (D5): a rename must not recolour a
 * conversation, and two people who both call themselves the same thing must
 * not merge. Picked from `SENDER_INK_ORDER`, so a teammate's ink is never the
 * chat's own accent and never one of the two status hues, `red` and `green`
 * (see `tokens.ts`).
 */
export function senderInk(authorId: string, scheme: Scheme): string {
  const name = SENDER_INK_ORDER[tintIndex(authorId, SENDER_INK_ORDER.length)] ?? SENDER_INK_ORDER[0] ?? 'indigo'

  return ACCENTS[name].text[scheme]
}

const DAY_SECONDS = 86_400
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * The right-aligned stamp on a chat-list row: `Now`, `12:47`, `Tue`, `12/09`.
 *
 * Deliberately relative rather than absolute — the list is read at a glance,
 * and "Now" against "12:47" is the difference a reader is actually after.
 */
export function formatListTime(unixSeconds: number | undefined, now = Date.now() / 1000): string {
  if (!unixSeconds || unixSeconds <= 0) {
    return ''
  }

  const date = new Date(unixSeconds * 1000)

  if (Number.isNaN(date.getTime())) {
    return ''
  }

  const age = now - unixSeconds

  if (age < 60) {
    return 'Now'
  }

  const today = new Date(now * 1000)
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()

  if (sameDay) {
    return formatClock(unixSeconds)
  }

  if (age < 7 * DAY_SECONDS) {
    return WEEKDAYS[date.getDay()] ?? ''
  }

  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}`
}

/**
 * FIRST STRONG ISOLATE (U+2068) … POP DIRECTIONAL ISOLATE (U+2069): the pair
 * that tells the bidi algorithm "read what is between these on its own
 * direction, decided from its own first strong character, then hand control
 * straight back and forget it was ever there". A right-to-left name — "שרה" —
 * joined into a line ahead of a body that opens with a digit or punctuation
 * would otherwise let the RTL run bleed past the colon and reorder the
 * neutral characters after it; isolating the name is enough, because FSI reads
 * an LTR name's own direction the same way and leaves it exactly as it was.
 *
 * For a name that stands ALONE — the sender label above a bubble, with
 * nothing else on its line to protect — this buys nothing and is not applied;
 * only a name JOINED with other text into one line needs it.
 */
function isolate(text: string): string {
  return `\u2068${text}\u2069`
}

/**
 * A chat-list preview line.
 *
 * The gateway's preview for an inbound teammate message is the raw row text,
 * which starts `Message from 🤖 Writer (@writer): …`. Spelling that out in full
 * on a 40-character row buries the message itself, so it is folded to
 * `🤖 @writer: …` — the same shape the transcript's DM bubble uses.
 *
 * A raw string still goes through here, and it still reaches this app from the
 * gateway unexamined, so the wrapper strip is HERE rather than only in the
 * caller: whatever asks for a preview line gets one that is not scaffolding. The
 * widget snapshot is the reason that matters — it shares this function and has
 * no derivation of its own.
 */
export function formatPreview(preview: string): string {
  return formatChatPreview(chatRowPreview(undefined, preview))
}

/**
 * The same line, from a preview the transcript derived.
 *
 * `chatRowPreview` decides WHAT to show — the last real message, or the
 * gateway's string with any wrapper taken off — and this decides how it reads.
 * The split is what lets one row prefer its own transcript while the widget,
 * which has none, keeps working off the string.
 */
export function formatChatPreview(preview: ChatPreview | null): string {
  if (!preview) {
    return ''
  }

  if (preview.fromHandle) {
    // The handle is ours, not the message's, so only the body is markdown.
    return clipInline(`🤖 @${preview.fromHandle}: ${plainTextPreview(preview.text)}`)
  }

  if (preview.senderName) {
    // Somebody else's turn in the group chat (HERM-83, D6) — already resolved
    // and sanitised by whoever built this preview (`fallbackSenderName` or its
    // caller), so it goes on as-is, with no bot emoji: this is a person, not a
    // teammate handle. Isolated (HERM-83 polish) because it is joined here with
    // the message body into ONE line: a right-to-left name — "שרה" — ahead of a
    // body that opens with a digit or punctuation would otherwise let its
    // direction bleed into what follows, on a row with no bubble to contain it.
    return clipInline(`${isolate(preview.senderName)}: ${plainTextPreview(preview.text)}`)
  }

  const match = preview.text.match(/^Message from\s+(?:🤖\s*)?([^(:]+?)(?:\s*\(@([^)]+)\))?\s*:\s*([\s\S]*)$/)

  if (!match) {
    return previewLine(preview.text)
  }

  const handle = (match[2] ?? match[1] ?? '').trim()

  return clipInline(`🤖 @${handle}: ${plainTextPreview(match[3] ?? '')}`)
}
