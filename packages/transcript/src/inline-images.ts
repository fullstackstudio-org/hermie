/**
 * Pictures a message carries inside its own text.
 *
 * The gateway writes an image a person attached into the turn as a handle line,
 * `[Image attached at: <path>]` (a file on its own disk) or `[Image attached: <url>]`
 * (`agent/image_routing.py`), and older sessions also hold the picture itself as a
 * `data:image/<type>;base64,<data>` blob beside it. Neither is for the reader: the
 * handle is a way for the model to name the file, and the blob is thousands of
 * characters of noise. This module lifts both out of the text:
 *
 * - **a blob that decodes** (png, jpeg, gif, webp, heic; at most 20 MiB; the first
 *   bytes say what the declared type claims) becomes an `InlineImage` the view
 *   draws as a thumbnail from the bytes it already holds;
 * - **a handle with no usable blob** becomes an `@image:<path>` reference, which is
 *   what an attachment already is: the client fetches the file through the
 *   gateway's own files route, or says it cannot;
 * - **a blob that does not decode** (broken base64, a type outside the list, too
 *   big) becomes the `@image:Image` reference: a compact chip, never the blob.
 *
 * Nothing here fetches anything, and no part of the marker or the blob stays in the
 * text. The Swift port (`HermieTranscript/InlineImages.swift`) is kept in step by the
 * shared vectors in `__fixtures__/inline-images.json`.
 */

/** A picture held by the message itself. */
export interface InlineImage {
  /** The file's name for the label (`upload_1.png`), or `Image`. */
  name: string
  /** The type the first bytes show: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/heic`. */
  mime: string
  /** The picture, base64 without the `data:` prefix and without padding stripped. */
  data: string
}

export interface InlineImageScan {
  /** The text without the handles and the blobs. */
  text: string
  /** Blobs that decode, in the order they appeared. */
  images: InlineImage[]
  /** `@image:` references for handles whose picture the message does not hold, and for blobs that cannot be shown. */
  references: string[]
}

/** The largest picture kept in a message, decoded. */
export const INLINE_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** How many pictures one message gives up; the rest are dropped from the text without a trace. */
export const INLINE_IMAGE_MAX_COUNT = 12

/** What a rejected blob is called. */
export const INLINE_IMAGE_FALLBACK_NAME = 'Image'

const DATA_PREFIX = 'data:image/'
const MARKER_PREFIX = '[Image attached'
const MARKER_RE = /^[ \t]*\[Image attached( at)?: (.+?)\][ \t]*$/gmu
const MEDIA_TYPE_RE = /^[a-z0-9.+-]{1,40}$/u
const BASE64_BODY_CHAR = /[A-Za-z0-9+/=_-]/u
const BASE64_STANDARD = /^[A-Za-z0-9+/]*$/u

const DECLARED_TYPES = new Set(['png', 'x-png', 'jpeg', 'jpg', 'pjpeg', 'gif', 'webp', 'heic', 'heif'])

interface Span {
  start: number
  end: number
}

interface BlobSpan extends Span {
  kind: 'blob'
  type: string
  body: string
}

interface MarkerSpan extends Span {
  kind: 'marker'
  isPath: boolean
  value: string
}

/** The type a picture's first bytes show, or `null` when they show none of the five. */
export function sniffImageType(bytes: ArrayLike<number>): string | null {
  const at = (index: number): number => bytes[index] ?? -1
  const text = (from: number, value: string): boolean =>
    [...value].every((char, i) => at(from + i) === char.charCodeAt(0))

  if (at(0) === 0x89 && text(1, 'PNG') && at(4) === 0x0d && at(5) === 0x0a) {
    return 'image/png'
  }

  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) {
    return 'image/jpeg'
  }

  if (text(0, 'GIF87a') || text(0, 'GIF89a')) {
    return 'image/gif'
  }

  if (text(0, 'RIFF') && text(8, 'WEBP')) {
    return 'image/webp'
  }

  if (
    text(4, 'ftyp') &&
    ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'heif'].some(brand => text(8, brand))
  ) {
    return 'image/heic'
  }

  return null
}

function decodeHead(base64: string): number[] | null {
  const usable = Math.min(32, Math.floor(base64.length / 4) * 4)

  if (usable < 12) {
    return null
  }

  try {
    return Array.from(atob(base64.slice(0, usable)), char => char.charCodeAt(0))
  } catch {
    return null
  }
}

/**
 * Whether `body` is a base64 picture this client will draw: standard alphabet, a length
 * that decodes, between 8 bytes and `INLINE_IMAGE_MAX_BYTES`, and a type outside the list
 * ruled out by the first bytes. Reads the first 24 bytes only; nothing is decoded in full.
 */
export function readInlineImage(type: string, body: string, name: string): InlineImage | null {
  if (!DECLARED_TYPES.has(type.toLowerCase())) {
    return null
  }

  let end = body.length

  while (end > 0 && body[end - 1] === '=') {
    end -= 1
  }

  const padding = body.length - end
  const significant = body.slice(0, end)

  if (padding > 2 || !BASE64_STANDARD.test(significant) || significant.length % 4 === 1) {
    return null
  }

  // Padding, when present, has to complete the last group.
  if (padding > 0 && body.length % 4 !== 0) {
    return null
  }

  const bytes = Math.floor((significant.length * 3) / 4)

  if (bytes < 8 || bytes > INLINE_IMAGE_MAX_BYTES) {
    return null
  }

  const head = decodeHead(significant)
  const mime = head ? sniffImageType(head) : null

  return mime ? { name, mime, data: body } : null
}

/** The last path (or URL) component without a query or fragment. */
export function handleName(value: string): string {
  const bare = value.split(/[?#]/u, 1)[0] ?? value
  const last = bare.split(/[/\\]/u).filter(Boolean).pop() ?? bare

  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** `@image:<value>`, quoted when it holds whitespace so the reference stays one token. */
export function imageReference(value: string): string {
  const clean = value.trim()

  return /\s/u.test(clean) ? `@image:"${clean.replace(/"/gu, "'")}"` : `@image:${clean}`
}

function findBlobs(text: string): BlobSpan[] {
  const found: BlobSpan[] = []
  let from = 0

  while (from < text.length) {
    const start = text.indexOf(DATA_PREFIX, from)

    if (start < 0) {
      break
    }

    // The type is at most 40 characters, so `;base64,` is looked for in a window that long, not to the end of the text.
    const typeStart = start + DATA_PREFIX.length
    const offset = text.slice(typeStart, typeStart + 48).indexOf(';base64,')
    const semicolon = offset < 0 ? -1 : typeStart + offset
    const type = semicolon < 0 ? '' : text.slice(typeStart, semicolon)

    if (!MEDIA_TYPE_RE.test(type)) {
      from = start + DATA_PREFIX.length

      continue
    }

    const bodyStart = semicolon + ';base64,'.length
    let end = bodyStart

    while (end < text.length && BASE64_BODY_CHAR.test(text[end] as string)) {
      end += 1
    }

    // `=` belongs at the very end of a body, never inside it.
    const firstPad = text.indexOf('=', bodyStart)

    if (firstPad >= 0 && firstPad < end) {
      let pad = firstPad

      while (pad < end && text[pad] === '=') {
        pad += 1
      }

      end = pad
    }

    found.push({ kind: 'blob', start, end, type, body: text.slice(bodyStart, end) })
    from = end
  }

  return found
}

/** A blob written as a Markdown image or link: the whole `![alt](…)` goes, not just what is inside it. */
function widenToLink(text: string, span: Span): Span {
  if (text.slice(span.start - 2, span.start) !== '](' || text[span.end] !== ')') {
    return span
  }

  const open = text.lastIndexOf('[', span.start - 3)

  if (open < 0 || text.slice(open, span.start).includes('\n')) {
    return span
  }

  return { start: open > 0 && text[open - 1] === '!' ? open - 1 : open, end: span.end + 1 }
}

/**
 * Lift the handles and the blobs out of `text`. Returns `text` itself, untouched, when it
 * holds neither.
 */
export function scanInlineImages(text: string): InlineImageScan {
  if (!text.includes(DATA_PREFIX) && !text.includes(MARKER_PREFIX)) {
    return { text, images: [], references: [] }
  }

  const events: (BlobSpan | MarkerSpan)[] = findBlobs(text)

  if (text.includes(MARKER_PREFIX)) {
    for (const match of text.matchAll(MARKER_RE)) {
      const value = (match[2] ?? '').trim()

      if (value && match.index !== undefined) {
        events.push({
          kind: 'marker',
          start: match.index,
          end: match.index + match[0].length,
          isPath: match[1] !== undefined,
          value
        })
      }
    }
  }

  if (!events.length) {
    return { text, images: [], references: [] }
  }

  events.sort((a, b) => a.start - b.start)

  const images: InlineImage[] = []
  const references: string[] = []
  const cuts: Span[] = []
  let count = 0
  let pending: MarkerSpan | null = null

  const addReference = (reference: string): void => {
    if (count <= INLINE_IMAGE_MAX_COUNT && !references.includes(reference)) {
      references.push(reference)
    }
  }
  const flushPending = (): void => {
    if (pending) {
      addReference(imageReference(pending.value))
      pending = null
    }
  }

  for (const event of events) {
    if (event.kind === 'marker') {
      flushPending()
      count += 1
      pending = event
      cuts.push({ start: event.start, end: event.end })

      continue
    }

    const handle: MarkerSpan | null = pending
    const name = handle ? handleName(handle.value) || INLINE_IMAGE_FALLBACK_NAME : INLINE_IMAGE_FALLBACK_NAME
    const image = readInlineImage(event.type, event.body, name)

    pending = null
    cuts.push(widenToLink(text, event))

    if (!handle) {
      count += 1
    }

    if (count > INLINE_IMAGE_MAX_COUNT) {
      continue
    }

    if (image) {
      images.push(image)
    } else if (handle) {
      addReference(imageReference(handle.value))
    } else {
      addReference(imageReference(INLINE_IMAGE_FALLBACK_NAME))
    }
  }

  flushPending()

  let out = ''
  let cursor = 0

  for (const cut of cuts) {
    if (cut.start < cursor) {
      continue
    }

    out += text.slice(cursor, cut.start)
    cursor = cut.end

    // A handle line takes its line break with it.
    if (text[cursor] === '\n' && (out === '' || out.endsWith('\n'))) {
      cursor += 1
    }
  }

  out += text.slice(cursor)

  return {
    text: out
      .replace(/[ \t]+\n/gu, '\n')
      .replace(/\n{3,}/gu, '\n\n')
      .trim(),
    images,
    references
  }
}
