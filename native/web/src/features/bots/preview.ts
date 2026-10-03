/**
 * The preview line one chat row shows, and where it comes from.
 *
 * `chatRowPreview` (`@hermie/transcript`) decides WHAT to show: the last real
 * message of the transcript when the client has one, the gateway's own string
 * (with any `[System: ...]` wrapper taken off) when it has not. This file decides
 * how it reads on one line: the Expo app's `formatChatPreview` and
 * `row-preview.ts`, ported with the markdown stripped through
 * `@hermie/markdown/plain-text` (a list row needs a string, not a parse).
 *
 * Pure: the row passes in what it read from the stores.
 */
import { plainTextPreview } from '@hermie/markdown/plain-text'
import { type ChatPreview, chatRowPreview, type ChatState, type MessageAuthor } from '@hermie/transcript'

/** How far a name or a line runs before it is cut. */
const SENDER_NAME_LIMIT = 80
const LINE_LIMIT = 120

/** Text another party authored, made safe to put in a line: no control or format characters (bidi overrides, zero-width spaces). */
function cleanText(value: string, max: number): string {
  // Zero-width joiner and non-joiner stay: some scripts need them.
  const cleaned = value
    .replace(/[\p{Cc}\p{Cf}]/gu, char => (char === '‌' || char === '‍' ? char : ''))
    .replace(/\s+/gu, ' ')
    .trim()

  return Array.from(cleaned).slice(0, max).join('')
}

/** A name that shows nothing: only whitespace and the invisible fillers Hangul reserves. */
const BLANK_WHEN_ALONE = /^(?:\s|ᅟ|ᅠ|‌|‍|ㅤ)*$/u

/** `authentik:7f3a` is `7f3a`, and an issuer URL used as an id is left alone. */
const PROVIDER_PREFIX = /^[A-Za-z][A-Za-z0-9._-]*:(?!\/\/)(.+)$/u

/**
 * What a foreign author is called in a preview: the gateway's stamped name, else
 * the identity with its provider prefix stripped. Never prettified: guessing a
 * person's name from an opaque id would put a wrong name on screen.
 */
export function senderName(author: MessageAuthor): string {
  const stamped = cleanText(author.name ?? '', SENDER_NAME_LIMIT)

  if (!BLANK_WHEN_ALONE.test(stamped)) {
    return stamped
  }

  const id = cleanText(author.id, SENDER_NAME_LIMIT)

  return cleanText(PROVIDER_PREFIX.exec(id)?.[1] ?? id, SENDER_NAME_LIMIT)
}

/** One line, whitespace collapsed, ellipsised. */
export function clipInline(value: string, max = LINE_LIMIT): string {
  const collapsed = value.replace(/\s+/gu, ' ').trim()
  const characters = Array.from(collapsed)

  return characters.length > max ? `${characters.slice(0, max - 1).join('')}…` : collapsed
}

/** FIRST STRONG ISOLATE ... POP DIRECTIONAL ISOLATE: a name joined into a line must not reorder what follows it. */
const isolate = (text: string): string => `⁨${text}⁩`

/** The words of a preview, as one line. */
export function formatChatPreview(preview: ChatPreview | null): string {
  if (!preview) {
    return ''
  }

  if (preview.fromHandle) {
    return clipInline(`\u{1F916} @${preview.fromHandle}: ${plainTextPreview(preview.text)}`)
  }

  if (preview.senderName) {
    return clipInline(`${isolate(preview.senderName)}: ${plainTextPreview(preview.text)}`)
  }

  const folded = /^Message from\s+(?:\u{1F916}\s*)?([^(:]+?)(?:\s*\(@([^)]+)\))?\s*:\s*([\s\S]*)$/u.exec(preview.text)

  if (!folded) {
    return clipInline(plainTextPreview(preview.text))
  }

  const handle = (folded[2] ?? folded[1] ?? '').trim()

  return clipInline(`\u{1F916} @${handle}: ${plainTextPreview(folded[3] ?? '')}`)
}

export interface RowPreview {
  text: string
  /** The words are scaffolding, not speech: the row draws them more quietly. */
  system: boolean
}

export interface RowPreviewOptions {
  /** The chat under this bot's key is the group chat (only then a row leads with a sender). */
  groupChat: boolean
  /** The reader's own author id, so their own turns carry no name. */
  ownAuthorId: string | undefined
}

/** Two primitives, so a row can select them and re-render only when its line changes. */
export function rowPreview(
  chat: ChatState | undefined,
  gatewayPreview: string,
  options: RowPreviewOptions
): RowPreview {
  const preview = chatRowPreview(chat, gatewayPreview, {
    groupChat: options.groupChat,
    ...(options.ownAuthorId ? { ownAuthorId: options.ownAuthorId } : {}),
    resolveSenderName: senderName
  })

  return { text: formatChatPreview(preview), system: preview?.system === true }
}
