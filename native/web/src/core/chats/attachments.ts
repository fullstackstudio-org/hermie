/**
 * What the composer has staged to go with the next message: the attachment tray.
 *
 * React-free on purpose. The composer, the drop zone over the chat and a paste
 * into the field all add to the same tray, and the one rule that matters most is
 * easier to hold in a plain object than in component state: **what is sent is
 * taken out of the tray in the same synchronous step that decides to send it.**
 * The Expo app emptied its tray only after `send` resolved, so a second Return
 * (or a click on Send) that landed while the first send was in flight found the
 * same attachments still staged and sent them again: a second, identical agent
 * turn with no undo (HERM-126). Here `take()` empties the tray before anything
 * is awaited; a second press finds nothing to take, and a send that fails puts
 * exactly what it took back with `restore()`, ahead of anything staged since and
 * never twice.
 *
 * ## Two roads to the gateway
 *
 * The controller decides how an attachment travels (`chat-controller.ts`,
 * `send`), and this module only sorts files onto its two roads:
 *
 *  - **An image** goes as base64 over the socket (`image.attach_bytes`). The
 *    gateway accepts it by the file name's extension (`_sniff_image_ext`, then
 *    `_allowed_image_extensions` in `tui_gateway/prompt_attachments.py`) and up
 *    to 25 MiB (`_ATTACH_BYTES_MAX_BYTES`). The bytes are read when the image is
 *    staged, so a send does not wait for a file system and a file that cannot be
 *    read says so on its chip rather than as a failed send.
 *  - **Anything else** is uploaded over HTTP when it is staged
 *    (`POST /api/files/upload-stream`, 100 MiB, `file-upload.ts`) and named in
 *    the prompt by its `@file:` reference. An SVG or an icon is a file: the
 *    gateway would take it as an image, but a vision model reads neither, and
 *    an SVG is text the agent can read as a file. A HEIC photograph is a file
 *    too: the gateway has no extension for it.
 *
 * No image is resized or re-encoded here: the client carries no image
 * processing (plan W-19). An image over the gateway's cap is refused on its chip
 * before any byte moves, the same way an oversized file is.
 *
 * An image's thumbnail is a `data:` URL of the bytes already read for the send,
 * up to `MAX_PREVIEW_BYTES`; a larger one shows the file glyph. Not a `blob:`
 * URL, which the page's policy would also allow as an image: a recorder that
 * copies the page (Playwright's trace, a save-page extension) fetches a `blob:`
 * image from inside the page, a connection `connect-src 'self'` refuses and
 * reports, and a `data:` URL needs no fetch and nothing to revoke.
 *
 * ## Progress, cancel, retry
 *
 * An upload's progress is "working" and then "ready" or "failed": `fetch` has no
 * upload progress event, and `XMLHttpRequest`, which has one, follows redirects
 * by itself and would replay the file and the session to wherever a 307 points.
 * `file-upload.ts` refuses redirects for exactly that reason, so no percentage
 * is invented. Cancel aborts the request (the gateway removes its temporary file
 * when the stream ends early) and takes the chip away; Retry starts the same
 * file again on a fresh path. A chip that is still working or has failed holds
 * the send back (`blocked`): what the reader sees in the tray is what goes.
 *
 * An uploaded file that is removed from the tray stays on the gateway, as it
 * does in the Expo app: deleting it would need a write the reader did not ask for.
 */
import type { AttachmentInput } from '../chat-controller'
import { FileUploadError, MAX_UPLOAD_BYTES, type UploadableFile, type UploadedFile } from './file-upload'

/** `_ATTACH_BYTES_MAX_BYTES` in `tui_gateway/prompt_attachments.py`: the cap of `image.attach_bytes`. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** The largest image drawn as its own thumbnail; the attribute holding it is a third larger again. */
export const MAX_PREVIEW_BYTES = 8 * 1024 * 1024

/**
 * The extensions an image keeps the image road with: the gateway's own list
 * (`_IMAGE_EXTENSIONS` in `hermes_cli/cli_terminal_input.py`) minus `.svg` and
 * `.ico` (see the module comment).
 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.tiff',
  '.tif'
])

/** The extension a nameless image (a paste, a screenshot) is given, from its type. */
const EXTENSION_FOR_TYPE: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff'
}

const FALLBACK_TYPE = 'application/octet-stream'

/** The part of a browser `File` the tray reads. A `File` is one; a test can hand in less. */
export interface PickedFile extends Blob {
  readonly name: string
}

/** `.png` of `shot.PNG`; `''` for a name with no extension. */
function extensionOf(name: string): string {
  const base = name.split(/[/\\]/u).pop() ?? ''
  const dot = base.lastIndexOf('.')

  return dot > 0 ? base.slice(dot).toLowerCase() : ''
}

/**
 * The name an image is attached under, or `null` when the file takes the file
 * road. The gateway reads the image's format off this name, so a nameless paste
 * is given the extension of its type rather than left to the gateway's guess.
 */
export function imageNameFor(file: { name: string; type: string }): string | null {
  const extension = extensionOf(file.name)

  if (extension) {
    return IMAGE_EXTENSIONS.has(extension) && (file.type === '' || file.type.startsWith('image/')) ? file.name : null
  }

  const given = EXTENSION_FOR_TYPE[file.type]

  return given ? `${file.name.trim() || 'image'}${given}` : null
}

/** Why a chip did not become ready. */
export type AttachmentProblem =
  /** Over the cap of the road it takes: caught before any byte moves, or the gateway's 413. */
  | { reason: 'too-large'; limitBytes: number }
  /** The chat has not told us its working directory, so there is nowhere a file would be readable. */
  | { reason: 'no-workspace' }
  /** The gateway answered and said no; `detail` is its own words. */
  | { reason: 'refused'; detail: string }
  /** The upload did not complete: the network, a proxy, a 5xx. */
  | { reason: 'failed'; message: string }
  /** The browser could not read the file (it moved, or permission went). */
  | { reason: 'unreadable'; message: string }

export type AttachmentStatus = 'working' | 'ready' | 'failed'

/** One chip in the tray, as the screen draws it. */
export interface StagedAttachment {
  readonly id: string
  readonly kind: 'image' | 'file'
  /** The file's own name: what the reader picked. */
  readonly name: string
  readonly size: number
  readonly status: AttachmentStatus
  readonly problem?: AttachmentProblem
  /** A `data:` URL of a ready image's own bytes, for its thumbnail (see the module comment). */
  readonly previewUrl?: string
}

/** What the tray needs from the page. */
export interface AttachmentTrayDeps {
  /** The controller's `uploadFile`, bound to the chat. */
  upload(file: UploadableFile, options: { signal: AbortSignal }): Promise<UploadedFile>
  /** The file's bytes as plain base64, no `data:` prefix. */
  readBase64(file: Blob): Promise<string>
  /** Injected in tests, so ids are predictable. */
  newId?(): string
}

/** Attachments taken out of the tray for one send. Hand it back to `restore` or `release`. */
export interface TakenAttachments {
  /** What `ChatController.send` takes, in the order the reader staged them. */
  readonly inputs: AttachmentInput[]
  /** @internal The chips, so a failed send can put them back exactly. */
  readonly entries: readonly TrayEntry[]
}

/** @internal A chip and what only the tray holds: the file, the abort, the attempt. */
interface TrayEntry {
  view: StagedAttachment
  readonly file: PickedFile
  /** The name an image is attached under (`imageNameFor`); unused for a file. */
  readonly imageName: string
  input?: AttachmentInput
  abort?: AbortController
  /** Bumped on every start: an answer for an earlier attempt is dropped. */
  attempt: number
}

const EMPTY: readonly StagedAttachment[] = []

let fallbackCounter = 0

const fallbackId = (): string => `attachment-${Date.now().toString(36)}-${(fallbackCounter += 1)}`

function problemOf(error: unknown): AttachmentProblem {
  if (error instanceof FileUploadError) {
    switch (error.reason) {
      case 'too-large':
        return { reason: 'too-large', limitBytes: MAX_UPLOAD_BYTES }
      case 'no-workspace':
        return { reason: 'no-workspace' }
      case 'refused':
        return { reason: 'refused', detail: error.detail ?? error.message }
      default:
        return { reason: 'failed', message: error.message }
    }
  }

  return { reason: 'failed', message: error instanceof Error ? error.message : String(error) }
}

export class AttachmentTray {
  private entries: TrayEntry[] = []
  private snapshot: readonly StagedAttachment[] = EMPTY
  private readonly listeners = new Set<() => void>()
  private readonly deps: AttachmentTrayDeps

  constructor(deps: AttachmentTrayDeps) {
    this.deps = deps
  }

  /** For `useSyncExternalStore`: the same array until something changes. */
  readonly getSnapshot = (): readonly StagedAttachment[] => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)

    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Nothing staged. */
  get empty(): boolean {
    return this.entries.length === 0
  }

  /**
   * A chip is still working, or failed and was neither retried nor removed. The
   * send waits: a message that silently went without the file the reader can see
   * in the tray would be the worse surprise.
   */
  get blocked(): boolean {
    return this.entries.some(entry => entry.view.status !== 'ready')
  }

  /** Stage files, in the order given, and start each on its road. Answers how many were staged. */
  add(files: Iterable<PickedFile>): number {
    let added = 0

    for (const file of files) {
      const imageName = imageNameFor(file)
      const kind = imageName === null ? 'file' : 'image'
      const entry: TrayEntry = {
        file,
        imageName: imageName ?? file.name,
        attempt: 0,
        view: {
          id: (this.deps.newId ?? fallbackId)(),
          kind,
          name: file.name || imageName || 'attachment',
          size: file.size,
          status: 'working'
        }
      }

      this.entries.push(entry)
      added += 1
      this.start(entry)
    }

    if (added > 0) {
      this.emit()
    }

    return added
  }

  /** Take a chip away. A running upload is aborted; an uploaded file stays on the gateway. */
  remove(id: string): void {
    const entry = this.entries.find(candidate => candidate.view.id === id)

    if (!entry) {
      return
    }

    entry.abort?.abort()
    this.entries = this.entries.filter(candidate => candidate !== entry)
    this.emit()
  }

  /** Start a failed chip again. An oversized file is not retried: it would be refused the same way. */
  retry(id: string): void {
    const entry = this.entries.find(candidate => candidate.view.id === id)

    if (!entry || entry.view.status !== 'failed' || entry.view.problem?.reason === 'too-large') {
      return
    }

    this.start(entry)
    this.emit()
  }

  /**
   * Everything staged, out of the tray, in one synchronous step: the tray is
   * empty before the caller awaits anything (see the module comment). `null`
   * when there is nothing to take, or while the tray is `blocked`.
   */
  take(): TakenAttachments | null {
    if (this.entries.length === 0 || this.blocked) {
      return null
    }

    const entries = this.entries

    this.entries = []
    this.emit()

    return { entries, inputs: entries.flatMap(entry => (entry.input ? [entry.input] : [])) }
  }

  /**
   * A send that failed: its attachments come back, in the order they were sent,
   * ahead of anything staged meanwhile and never twice.
   */
  restore(taken: TakenAttachments): void {
    const back = new Set(taken.entries)

    this.entries = [...taken.entries, ...this.entries.filter(entry => !back.has(entry))]
    this.emit()
  }

  /**
   * A send that went: the taken chips are done with. Their bytes are let go here
   * rather than kept for a restore that will not come.
   */
  release(taken: TakenAttachments): void {
    for (const entry of taken.entries) {
      delete entry.input
    }
  }

  /** Leaving the chat: every upload stops and the tray is emptied. */
  clear(): void {
    if (this.entries.length === 0) {
      return
    }

    for (const entry of this.entries) {
      entry.abort?.abort()
    }

    this.entries = []
    this.emit()
  }

  private start(entry: TrayEntry): void {
    entry.attempt += 1
    entry.abort?.abort()

    const attempt = entry.attempt
    const { file } = entry
    const current = (): boolean => entry.attempt === attempt && this.entries.includes(entry)

    delete entry.input
    delete entry.abort
    this.update(entry, { status: 'working' })

    if (entry.view.kind === 'image') {
      if (file.size > MAX_IMAGE_BYTES) {
        this.update(entry, { status: 'failed', problem: { reason: 'too-large', limitBytes: MAX_IMAGE_BYTES } })

        return
      }

      this.deps.readBase64(file).then(
        base64 => {
          if (current()) {
            entry.input = { kind: 'image', filename: entry.imageName, base64 }
            this.update(entry, {
              status: 'ready',
              ...(file.size <= MAX_PREVIEW_BYTES && /^image\/[a-z0-9.+-]+$/iu.test(file.type)
                ? { previewUrl: `data:${file.type};base64,${base64}` }
                : {})
            })
            this.emit()
          }
        },
        (error: unknown) => {
          if (current()) {
            const message = error instanceof Error ? error.message : String(error)

            this.update(entry, { status: 'failed', problem: { reason: 'unreadable', message } })
            this.emit()
          }
        }
      )

      return
    }

    const abort = new AbortController()

    entry.abort = abort
    this.deps
      .upload(
        { name: file.name, size: file.size, mimeType: file.type || FALLBACK_TYPE, uri: '', body: file },
        { signal: abort.signal }
      )
      .then(
        uploaded => {
          if (current()) {
            delete entry.abort
            entry.input = { kind: 'file', filename: uploaded.filename, path: uploaded.path }
            this.update(entry, { status: 'ready' })
            this.emit()
          }
        },
        (error: unknown) => {
          if (current() && !abort.signal.aborted) {
            delete entry.abort
            this.update(entry, { status: 'failed', problem: problemOf(error) })
            this.emit()
          }
        }
      )
  }

  /** A new view object for the chip; the snapshot is rebuilt by `emit`. */
  private update(
    entry: TrayEntry,
    change: { status: AttachmentStatus; problem?: AttachmentProblem; previewUrl?: string }
  ): void {
    const { problem: _problem, previewUrl: _preview, ...rest } = entry.view

    entry.view = {
      ...rest,
      status: change.status,
      ...(change.problem ? { problem: change.problem } : {}),
      ...(change.previewUrl ? { previewUrl: change.previewUrl } : {})
    }
  }

  private emit(): void {
    this.snapshot = this.entries.length === 0 ? EMPTY : this.entries.map(entry => entry.view)

    for (const listener of [...this.listeners]) {
      listener()
    }
  }
}
