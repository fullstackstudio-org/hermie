/**
 * The sheet for an `input.file` request: the person picks the files, the page prepares and uploads them to the
 * directory the request names, and answers with references (path, name, type, size, SHA-256), never bytes
 * (`contract/requests/README.md` §5).
 *
 *  - **Picking.** A native picker filtered by `accept`, one file or several as the request says; where the bot
 *    would like a camera shot and the device probably has one, a second button asks for it (`capture`), and the
 *    person can always pick an existing file instead. A file that is the wrong kind, too large, empty, or one too
 *    many is not added, and the sheet says why. Pictures get a preview.
 *  - **Limits before bytes move.** `max_bytes` per file, `max_total_bytes` together and `max_files` are checked when
 *    a file is picked and again on the prepared files (re-encoding changes a picture's size), before the first
 *    upload starts.
 *  - **Metadata.** With `strip_metadata` a JPEG or PNG is re-encoded on a canvas so no EXIF or GPS leaves the page
 *    (`file-prepare.ts`); a picture the page cannot clean is not added.
 *  - **Uploading.** One file after another, DIRECTLY into `upload.dir` as `<16 hex>-<name>` (flat: the gateway
 *    refuses a subdirectory), through the page's own upload route (`uploadFile`), with progress and a way to
 *    cancel. A file that is already up is not uploaded again when the person tries again.
 *  - **Failing.** An upload that fails is said, and the person chooses: try again, or give up, which tells the bot
 *    `4041 upload_failed` (not an answer). A cancelled upload sends nothing.
 *  - **Skip** only when the request is `optional`. **A countdown. A tap guard.**
 */
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { FileUploadError, flatUploadPath, type UploadableFile } from '../../core/chats/file-upload'
import type { AnswerOutcome } from '../../core/requests/interactive'
import type { FileAsk, InteractiveAnswer, UploadedFile } from '../../core/requests/interactive-types'
import { displayText } from '../../core/requests/secure-input'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import type { InteractiveRequest } from '../../state/interactive'
import { Button } from '../../ui/primitives'
import { hasFinePointer } from '../../platform/input-kind'
import { formatBytes } from '../chat/chat-format'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { acceptAttribute, isImage, matchesAccept, PrepareError, type PreparedFile, prepareFile } from './file-prepare'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { useReportBusy } from './sheet-busy'

/** How the sheet puts a file on the gateway: the layer binds it to the controller's upload. */
export type FileUploader = (
  path: string,
  file: UploadableFile,
  options: { onProgress?: (fraction: number) => void; signal?: AbortSignal }
) => Promise<unknown>

export interface FileSheetProps {
  request: InteractiveRequest & { ask: FileAsk }
  /** The gateway's host. */
  gateway: string
  titleId: string
  descriptionId: string
  onAnswer: (result: InteractiveAnswer) => Promise<AnswerOutcome>
  onSkip: () => Promise<AnswerOutcome>
  /** Put the sheet away without answering (what was picked, and what is uploading, stays while it is away). */
  onLater: () => void
  /** Tell the gateway the page cannot show the request, or the person will not share it (`4041`): `upload_failed`, `declined`. */
  onCannotShow: (reason: string) => 'sent' | 'closed' | 'offline' | 'busy'
  /** Put a file on the gateway; absent, an upload fails. */
  onUpload?: FileUploader | undefined
  /** Prepare a file for upload (metadata, size, SHA-256); the real one unless a test hands in its own. */
  prepare?: (file: File, stripMetadata: boolean) => Promise<PreparedFile>
  /** Whether the sheet is the one on screen: its tap guard runs from the moment it is (default: it is). */
  shown?: boolean
  /** Milliseconds before a control takes anything. Tests pass 0. */
  tapGuardMs?: number
  /** Epoch milliseconds, for the countdown; the clock unless a test hands in its own. */
  now?: () => number
}

interface Picked {
  key: number
  file: File
  /** A `blob:` address for a picture's preview, or `null`. */
  preview: string | null
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'uploading'; index: number; name: string; done: number }
  | { kind: 'sending' }
  | { kind: 'failed'; name: string; why: 'prepare' | 'upload' }

/** A file that is up: what the answer says about it. */
interface Uploaded {
  prepared: PreparedFile
  path: string
}

const sizeOf = (files: readonly { size: number }[]): number => files.reduce((sum, file) => sum + file.size, 0)

/** A `blob:` address to show a picture by, or `null` where the browser has none to give. */
function previewFor(file: File): string | null {
  try {
    return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null
  } catch {
    return null
  }
}

/** The picker button's wording for a request. */
const captureLabel = (capture: NonNullable<FileAsk['capture']>): string =>
  capture === 'audio' ? sheetStrings.interactive.file.captureAudio : sheetStrings.interactive.file.capturePhoto

export function FileSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  onLater,
  onCannotShow,
  onUpload,
  prepare = prepareFile,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: FileSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const { upload } = ask
  const ids = useId()
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  const picker = useRef<HTMLInputElement>(null)
  const camera = useRef<HTMLInputElement>(null)
  const counter = useRef(0)
  const cancel = useRef<AbortController | null>(null)
  const uploaded = useRef(new Map<number, Uploaded>())
  const previews = useRef<string[]>([])
  const [picked, setPicked] = useState<readonly Picked[]>([])
  const [problems, setProblems] = useState<readonly string[]>([])
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [cancelled, setCancelled] = useState(false)
  const [offline, setOffline] = useState(false)
  /** The gateway's refusal is about files that were changed since: it is out of date. */
  const [changed, setChanged] = useState(false)

  const limit = ask.multiple ? upload.maxFiles : 1
  const working = phase.kind !== 'idle' && phase.kind !== 'failed'
  // Preparing, uploading and sending are not cut off by a question that arrives meanwhile (`sheet-order.ts`).
  useReportBusy(working || sending.pending)
  const locked = !armed || sending.pending || sending.finished
  const busy = locked || working
  const wantsCamera =
    ask.capture !== undefined &&
    ask.capture !== 'scan' &&
    (ask.accept === 'any' || ask.accept === (ask.capture === 'audio' ? 'audio' : 'image')) &&
    !hasFinePointer()

  // A picture's preview address is released when the file goes and when the sheet does.
  useEffect(
    () => () => {
      for (const address of previews.current) {
        URL.revokeObjectURL(address)
      }

      cancel.current?.abort()
    },
    []
  )

  useEffect(() => {
    setChanged(false)
  }, [request.refusal])

  const total = sizeOf(picked.map(entry => entry.file))

  /** A file that is no longer picked: its preview address is let go, and what was uploaded of it is forgotten. */
  function release(entry: Picked): void {
    uploaded.current.delete(entry.key)

    if (entry.preview) {
      URL.revokeObjectURL(entry.preview)
      previews.current = previews.current.filter(address => address !== entry.preview)
    }
  }

  function addFiles(list: FileList | null): void {
    const incoming = Array.from(list ?? [])

    if (incoming.length === 0) {
      return
    }

    const said: string[] = []
    const next: Picked[] = ask.multiple ? [...picked] : []
    let running = sizeOf(next.map(entry => entry.file))

    for (const file of incoming) {
      const name = displayText(file.name, 120) || 'file'

      if (file.size === 0) {
        said.push(sheetStrings.interactive.file.problemEmpty({ name }))
      } else if (!matchesAccept(ask.accept, file)) {
        said.push(sheetStrings.interactive.file.problemWrongKind({ name }))
      } else if (file.size > upload.maxBytes) {
        said.push(sheetStrings.interactive.file.problemTooLarge({ name, max: formatBytes(upload.maxBytes) }))
      } else if (next.length >= limit) {
        said.push(sheetStrings.interactive.file.problemTooMany({ max: limit }))
      } else if (running + file.size > upload.maxTotalBytes) {
        said.push(sheetStrings.interactive.file.problemTotal({ max: formatBytes(upload.maxTotalBytes) }))
      } else {
        counter.current += 1

        const preview = isImage(file) ? previewFor(file) : null

        if (preview) {
          previews.current.push(preview)
        }

        next.push({ key: counter.current, file, preview })
        running += file.size
      }
    }

    // A single-file request replaces what was picked: the earlier file is gone from the page.
    if (!ask.multiple) {
      for (const entry of picked) {
        release(entry)
      }
    }

    setPicked(next)
    setProblems([...new Set(said)])
    setCancelled(false)
    setChanged(true)
    setOffline(false)
  }

  function remove(key: number): void {
    const entry = picked.find(candidate => candidate.key === key)

    if (entry) {
      release(entry)
    }

    setPicked(previous => previous.filter(entry => entry.key !== key))
    setProblems([])
    setCancelled(false)
    setChanged(true)
  }

  /** Prepare, check the limits, upload what is not up yet, and answer. */
  async function start(): Promise<void> {
    if (locked || working || picked.length === 0) {
      return
    }

    const control = new AbortController()
    let failing = ''

    cancel.current = control
    setCancelled(false)
    setOffline(false)
    setProblems([])
    setPhase({ kind: 'preparing' })

    try {
      const prepared: PreparedFile[] = []

      for (const entry of picked) {
        const known = uploaded.current.get(entry.key)

        failing = entry.file.name
        prepared.push(known ? known.prepared : await prepare(entry.file, upload.stripMetadata))

        if (control.signal.aborted) {
          throw new FileUploadError('cancelled', 'cancelled')
        }
      }

      // The limits again, on the bytes that will go (a re-encoded picture is not the size it was picked at).
      const name = (index: number): string => prepared[index]?.name ?? ''
      const tooLarge = prepared.findIndex(entry => entry.bytes > upload.maxBytes)

      if (tooLarge >= 0) {
        setProblems([
          sheetStrings.interactive.file.problemPreparedTooLarge({
            name: name(tooLarge),
            max: formatBytes(upload.maxBytes)
          })
        ])
        setPhase({ kind: 'idle' })

        return
      }

      if (sizeOf(prepared.map(entry => ({ size: entry.bytes }))) > upload.maxTotalBytes) {
        setProblems([sheetStrings.interactive.file.problemTotal({ max: formatBytes(upload.maxTotalBytes) })])
        setPhase({ kind: 'idle' })

        return
      }

      let done = 0

      for (const [index, entry] of picked.entries()) {
        const file = prepared[index]

        if (!file) {
          continue
        }

        if (uploaded.current.has(entry.key)) {
          done += file.bytes

          continue
        }

        failing = file.name
        setPhase({ kind: 'uploading', index, name: file.name, done })

        if (!onUpload) {
          throw new FileUploadError('failed', 'no way to upload')
        }

        const path = flatUploadPath(upload.dir, file.name)

        await onUpload(
          path,
          { name: file.name, size: file.bytes, mimeType: file.mime, uri: '', body: file.blob },
          { signal: control.signal }
        )
        uploaded.current.set(entry.key, { prepared: file, path })
        done += file.bytes
      }

      const files: UploadedFile[] = picked.flatMap(entry => {
        const known = uploaded.current.get(entry.key)

        return known
          ? [
              {
                path: known.path,
                name: known.prepared.name,
                mime: known.prepared.mime,
                bytes: known.prepared.bytes,
                sha256: known.prepared.sha256
              }
            ]
          : []
      })

      setPhase({ kind: 'sending' })
      await sending.run(() => onAnswer({ status: 'answered', files }))
      setPhase({ kind: 'idle' })
    } catch (error) {
      if (error instanceof FileUploadError && error.reason === 'cancelled') {
        setCancelled(true)
        setPhase({ kind: 'idle' })
      } else if (error instanceof PrepareError && error.reason === 'strip_unsupported') {
        // A picture this browser cannot decode cannot be cleaned of its location data, so it is not sent: the person
        // removes it or picks another. (Trying again would change nothing.)
        setProblems([sheetStrings.interactive.file.problemStrip({ name: displayText(failing, 120) || 'file' })])
        setPhase({ kind: 'idle' })
      } else {
        // A file that could not be prepared is a file the page cannot send: said, and the person chooses.
        setPhase({ kind: 'failed', name: failing, why: error instanceof FileUploadError ? 'upload' : 'prepare' })
      }
    } finally {
      cancel.current = null
    }
  }

  const refusalText = ((): string | null => {
    const reason = request.refusal

    if (reason === null || changed) {
      return null
    }

    if (reason === 'files:too_many') {
      return sheetStrings.interactive.file.refusedTooMany({ max: limit })
    }

    if (reason === 'files:too_large') {
      return sheetStrings.interactive.file.refusedTotal({ max: formatBytes(upload.maxTotalBytes) })
    }

    const match = /^file:(\d+):(outside_dir|too_large)$/u.exec(reason)

    if (match) {
      const entry = picked[Number(match[1])]

      return sheetStrings.interactive.file.refusedFile({
        name: entry ? displayText(entry.file.name, 120) : `#${Number(match[1]) + 1}`
      })
    }

    return sheetStrings.interactive.refusedOther({ reason })
  })()

  const phaseText =
    phase.kind === 'preparing'
      ? sheetStrings.interactive.file.preparing
      : phase.kind === 'uploading'
        ? sheetStrings.interactive.file.uploading({
            current: phase.index + 1,
            total: picked.length,
            name: displayText(phase.name, 120)
          })
        : phase.kind === 'sending'
          ? sheetStrings.interactive.file.sending
          : ''

  const limits = ask.multiple
    ? sheetStrings.interactive.file.limitMany({
        count: upload.maxFiles,
        size: formatBytes(upload.maxBytes),
        total: formatBytes(upload.maxTotalBytes)
      })
    : sheetStrings.interactive.file.limitOne({ size: formatBytes(upload.maxBytes) })
  const acceptNote = {
    image: sheetStrings.interactive.file.acceptImage,
    document: sheetStrings.interactive.file.acceptDocument,
    audio: sheetStrings.interactive.file.acceptAudio,
    any: sheetStrings.interactive.file.acceptAny
  }[ask.accept]
  const notesId = `${ids}-notes`
  const later = (
    <Button className="hm-requests__action" variant="quiet" onClick={onLater}>
      {sheetStrings.interactive.later}
    </Button>
  )
  const hasImages = ask.accept === 'image' || ask.accept === 'any'

  return (
    <InteractiveFrame
      request={request}
      gateway={gateway}
      title={sheetStrings.interactive.file.title}
      titleId={titleId}
      descriptionId={descriptionId}
      receiver={sheetStrings.interactive.file.receiver}
      {...(now ? { now } : {})}
      status={
        <>
          <RefusalAlert text={refusalText} />
          <SendStatus notice={sending.notice ?? (offline ? 'offline' : null)} />
          {phase.kind === 'failed' ? (
            <div className="hm-interactive__failure" role="alert">
              <p className="hm-requests__phase" data-tone="danger">
                {phase.why === 'prepare'
                  ? sheetStrings.interactive.file.problemPrepare({ name: displayText(phase.name, 120) || '…' })
                  : sheetStrings.interactive.file.uploadFailed({ name: displayText(phase.name, 120) || '…' })}
              </p>
              <p className="hm-requests__meta">{sheetStrings.interactive.file.failedNote}</p>
            </div>
          ) : null}
          {cancelled ? (
            <p className="hm-requests__phase" role="status">
              {sheetStrings.interactive.file.cancelled}
            </p>
          ) : null}
          {working ? (
            <div className="hm-file__progress">
              <progress
                aria-label={sheetStrings.interactive.file.progress}
                {...(phase.kind === 'uploading' ? { max: total, value: phase.done } : {})}
              />
              <p className="hm-requests__meta" role="status">
                {phaseText}
              </p>
            </div>
          ) : null}
        </>
      }
      actions={
        working && phase.kind !== 'sending' ? (
          <>
            {later}
            <Button className="hm-requests__action" variant="quiet" onClick={() => cancel.current?.abort()}>
              {sheetStrings.interactive.file.cancel}
            </Button>
          </>
        ) : phase.kind === 'failed' ? (
          <>
            {later}
            <Button
              className="hm-requests__action"
              variant="quiet"
              disabled={locked}
              onClick={() => setOffline(onCannotShow('upload_failed') === 'offline')}
            >
              {sheetStrings.interactive.file.giveUp}
            </Button>
            <Button className="hm-requests__action" variant="primary" disabled={locked} onClick={() => void start()}>
              {sheetStrings.interactive.file.retry}
            </Button>
          </>
        ) : (
          <>
            {later}
            <Button
              className="hm-requests__action"
              variant="quiet"
              disabled={busy}
              data-interactive-dont-share=""
              onClick={() => sending.declined(onCannotShow('declined'))}
            >
              {sheetStrings.interactive.dontShare}
            </Button>
            {ask.optional ? (
              <Button
                className="hm-requests__action"
                variant="quiet"
                disabled={busy}
                onClick={() => void sending.run(onSkip)}
              >
                {sheetStrings.secureInput.skip}
              </Button>
            ) : null}
            <Button
              className="hm-requests__action"
              variant="primary"
              disabled={busy || picked.length === 0}
              onClick={() => void start()}
            >
              {sheetStrings.interactive.file.upload}
            </Button>
          </>
        )
      }
    >
      <div className="hm-file__pick">
        <div className="hm-requests__actions">
          <input
            ref={picker}
            hidden
            type="file"
            multiple={ask.multiple}
            {...(acceptAttribute(ask.accept) ? { accept: acceptAttribute(ask.accept) } : {})}
            onChange={event => {
              addFiles(event.currentTarget.files)
              event.currentTarget.value = ''
            }}
            data-file-picker=""
          />
          <Button
            className="hm-requests__action"
            variant="quiet"
            disabled={busy || phase.kind === 'failed'}
            aria-describedby={notesId}
            onClick={() => picker.current?.click()}
          >
            {ask.multiple ? sheetStrings.interactive.file.chooseMany : sheetStrings.interactive.file.chooseOne}
          </Button>
          {wantsCamera && ask.capture ? (
            <>
              <input
                ref={camera}
                hidden
                type="file"
                accept={ask.capture === 'audio' ? 'audio/*' : 'image/*'}
                capture={ask.capture === 'audio' ? 'user' : 'environment'}
                multiple={ask.multiple}
                onChange={event => {
                  addFiles(event.currentTarget.files)
                  event.currentTarget.value = ''
                }}
                data-file-camera=""
              />
              <Button
                className="hm-requests__action"
                variant="quiet"
                disabled={busy || phase.kind === 'failed'}
                aria-describedby={notesId}
                onClick={() => camera.current?.click()}
              >
                {captureLabel(ask.capture)}
              </Button>
            </>
          ) : null}
        </div>

        <div id={notesId}>
          <p className="hm-form__hint">{acceptNote}</p>
          <p className="hm-form__hint">{limits}</p>
          {upload.stripMetadata && hasImages ? (
            <p className="hm-form__hint">{sheetStrings.interactive.file.strip}</p>
          ) : null}
        </div>

        <div className="hm-requests__detail-box">
          <p className="hm-requests__label">{sheetStrings.interactive.file.whereLabel}</p>
          <p className="hm-file__where" data-agent-text="">
            {displayText(upload.dir, 1_024)}
          </p>
        </div>

        {problems.length > 0 ? (
          <div className="hm-file__problems" role="alert">
            {problems.map(problem => (
              <p key={problem} className="hm-form__error">
                {problem}
              </p>
            ))}
          </div>
        ) : null}

        {picked.length > 0 ? (
          <ul className="hm-file__list" aria-label={sheetStrings.interactive.file.picked}>
            {picked.map(entry => {
              const name = displayText(entry.file.name, 120) || 'file'

              return (
                <li className="hm-file__item" key={entry.key} data-file-name={name}>
                  {entry.preview ? (
                    <img
                      className="hm-file__preview"
                      src={entry.preview}
                      alt={sheetStrings.interactive.file.previewOf({ name })}
                    />
                  ) : null}
                  <span className="hm-file__name">
                    <span data-agent-text="">{name}</span>
                    <span className="hm-requests__meta">{formatBytes(entry.file.size)}</span>
                  </span>
                  <Button
                    variant="quiet"
                    disabled={busy || phase.kind === 'failed'}
                    aria-label={sheetStrings.interactive.file.remove({ name })}
                    onClick={() => remove(entry.key)}
                  >
                    {sheetStrings.interactive.file.removeShort}
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : null}
      </div>
    </InteractiveFrame>
  )
}
