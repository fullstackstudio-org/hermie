/**
 * What a file goes through between the picker and the upload (`FileSheet.tsx`): is it the kind the bot asked for,
 * does it lose its metadata, what are its size and SHA-256 as they will be uploaded.
 *
 * **Metadata.** When the request says `strip_metadata`, a camera or library picture must not leave the page with its
 * EXIF and GPS data. A picture is decoded and drawn on a canvas and encoded again, which writes none of it
 * (`createImageBitmap` with `imageOrientation: 'from-image'` applies the camera's rotation to the pixels first, so
 * the picture still stands the right way up). A JPEG stays a JPEG and a PNG a PNG; any other picture the browser can
 * decode (WebP, GIF, AVIF, HEIC where the browser reads it) becomes a JPEG, named `.jpg`, on a white ground where it
 * was transparent. A picture the browser cannot decode is refused rather than uploaded with its metadata: the page
 * cannot clean what it cannot read. Documents and audio are uploaded untouched, as the contract says.
 *
 * **What the answer quotes** is the file as uploaded: its size and SHA-256 are those of the bytes after any
 * re-encoding, which is why the limits are checked again on the prepared files, before anything is uploaded.
 */
import type { FileAccept } from '../../core/requests/interactive-types'
import { sha256Hex } from '../../core/requests/sha256'

/** What a picker's `accept` says for each kind of request. */
export function acceptAttribute(accept: FileAccept): string | undefined {
  switch (accept) {
    case 'image':
      return 'image/*'
    case 'audio':
      return 'audio/*'
    case 'document':
      return 'application/pdf,text/*,.pdf,.txt,.md,.csv,.rtf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.odt,.ods,.odp'
    case 'any':
      return undefined
  }
}

const DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'application/rtf',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/json',
  'application/xml'
])
const DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'pdf',
  'txt',
  'md',
  'csv',
  'rtf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'json',
  'xml',
  'log'
])
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'avif',
  'heic',
  'heif',
  'bmp',
  'tif',
  'tiff'
])
const AUDIO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp3',
  'm4a',
  'wav',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aac',
  'webm',
  'caf'
])

const extensionOf = (name: string): string => (name.includes('.') ? (name.split('.').pop() ?? '').toLowerCase() : '')

/** Whether the file is a picture, by its type or, when the browser gave none, its name. */
export function isImage(file: { name: string; type: string }): boolean {
  return file.type === '' ? IMAGE_EXTENSIONS.has(extensionOf(file.name)) : file.type.startsWith('image/')
}

/** `jpeg` or `png` for the pictures whose metadata the page can remove; `other` for every other picture. */
export function imageKind(file: { name: string; type: string }): 'jpeg' | 'png' | 'other' {
  const type = file.type || { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }[extensionOf(file.name)] || ''

  return type === 'image/jpeg' ? 'jpeg' : type === 'image/png' ? 'png' : 'other'
}

/** Whether a file is the kind the request asked for (a picker's filter is a hint some systems ignore). */
export function matchesAccept(accept: FileAccept, file: { name: string; type: string }): boolean {
  switch (accept) {
    case 'any':
      return true
    case 'image':
      return isImage(file)
    case 'audio':
      return file.type === '' ? AUDIO_EXTENSIONS.has(extensionOf(file.name)) : file.type.startsWith('audio/')
    case 'document':
      return (
        DOCUMENT_TYPES.has(file.type) ||
        file.type.startsWith('text/') ||
        file.type.includes('officedocument') ||
        file.type.includes('opendocument') ||
        ((file.type === '' || file.type === 'application/octet-stream') &&
          DOCUMENT_EXTENSIONS.has(extensionOf(file.name)))
      )
  }
}

/** The name the answer gives the file (at most 120 characters, the person's own, without control characters). */
export function answerName(name: string): string {
  const cleaned = Array.from(name.replace(/\p{Cc}/gu, ' ').trim())
    .slice(0, 120)
    .join('')
    .trim()

  return cleaned === '' ? 'file' : cleaned
}

/**
 * The MIME type the answer gives (at most 80 characters, a `type/subtype`), or the generic one. Parameters are dropped:
 * a recording a browser makes says `audio/webm;codecs=opus`, and the contract wants `audio/webm` (section 5.1: the
 * gateway refuses a parameter in an audio file's `mime`).
 */
export function answerMime(type: string): string {
  const bare = (type.split(';')[0] ?? '').trim()

  return /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/u.test(bare) && bare.length <= 80
    ? bare
    : 'application/octet-stream'
}

/** A file ready to upload: its bytes as they will be sent, and what the answer says about them. */
export interface PreparedFile {
  blob: Blob
  name: string
  mime: string
  bytes: number
  sha256: string
}

/** Why a file could not be prepared. */
export class PrepareError extends Error {
  constructor(readonly reason: 'strip_unsupported' | 'failed') {
    super(reason)
  }
}

/** Draw a JPEG or PNG on a canvas and encode it again: the new bytes carry no EXIF, GPS or other metadata. */
export async function reencodeImage(file: Blob, kind: 'jpeg' | 'png'): Promise<Blob> {
  let bitmap: ImageBitmap

  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    // A browser that takes no options: it applies the rotation by itself or not at all.
    bitmap = await createImageBitmap(file)
  }

  try {
    const canvas = document.createElement('canvas')

    canvas.width = bitmap.width
    canvas.height = bitmap.height

    const context = canvas.getContext('2d')

    if (!context) {
      throw new PrepareError('failed')
    }

    if (kind === 'jpeg') {
      // A JPEG has no transparency: what was transparent is white, not black.
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
    }

    context.drawImage(bitmap, 0, 0)

    const type = kind === 'jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, 0.92))

    if (!blob || blob.type !== type) {
      throw new PrepareError('failed')
    }

    return blob
  } finally {
    bitmap.close()
  }
}

export interface PrepareDeps {
  /** Remove the metadata of a picture by encoding it again as `kind`; the canvas by default. */
  strip?: (file: Blob, kind: 'jpeg' | 'png') => Promise<Blob>
  digest?: (blob: Blob) => Promise<string>
}

/** `photo.heic` as `photo.jpg`: a picture re-encoded as a JPEG says so in its name. */
const asJpegName = (name: string): string => `${name.replace(/\.[^./\\]*$/u, '') || 'file'}.jpg`

/** The file as it will be uploaded: metadata removed when asked, its size and SHA-256 taken. */
export async function prepareFile(file: File, stripMetadata: boolean, deps: PrepareDeps = {}): Promise<PreparedFile> {
  const digest = deps.digest ?? sha256Hex
  let blob: Blob = file
  let mime = file.type
  let name = answerName(file.name)

  if (stripMetadata && isImage(file)) {
    const known = imageKind(file)
    // A JPEG stays one and a PNG stays one; any other picture is encoded as a JPEG, if the browser can read it at all.
    const kind = known === 'other' ? 'jpeg' : known

    try {
      blob = await (deps.strip ?? reencodeImage)(file, kind)
    } catch {
      // Not a picture this browser decodes (or no canvas to draw it on): it cannot be cleaned, so it is not sent.
      throw new PrepareError('strip_unsupported')
    }

    mime = kind === 'jpeg' ? 'image/jpeg' : 'image/png'

    if (known === 'other') {
      name = answerName(asJpegName(file.name))
    }
  }

  return { blob, name, mime: answerMime(mime), bytes: blob.size, sha256: await digest(blob) }
}
