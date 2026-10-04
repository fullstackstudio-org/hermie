/**
 * The sheet for an `input.signature` request: a statement signed on a pad, answered with a PNG and an SVG of the drawing
 * and a fingerprint of the statement (`contract/requests/README.md` section 8).
 *
 *  - **What is signed is what is shown.** The statement is drawn whole above the pad, as the characters it is (what the
 *    eye cannot see is marked by its code point), with the signer's name and the time. Its SHA-256 goes in the answer, over
 *    the UTF-8 bytes exactly as the frame had them (`statementSha256`); a gateway that sees another is told so.
 *  - **The pad takes a finger, a pen or a mouse** (pointer events; pressure is ignored, a stroke is a line of one width)
 *    and does not scroll the page under a finger (`touch-action: none`). Clear starts over.
 *  - **Two files, built on the device.** The PNG is the canvas, encoded; the SVG is written from the same strokes in the
 *    gateway's allowlist exactly (`signature-export.ts`). Both are uploaded through the page's own upload route into the
 *    request's directory, then answered by reference with `signed_at` (the page's clock when Send was pressed). A file
 *    that is already up is not uploaded again when the person tries again.
 *  - A pad is not a keyboard control: a person who cannot draw uses Don't share or Skip.
 */
import { type PointerEvent as ReactPointerEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { FileUploadError, flatUploadPath } from '../../core/chats/file-upload'
import type { SignatureAsk, UploadedFile } from '../../core/requests/interactive-types'
import { sha256Hex } from '../../core/requests/sha256'
import { formatDateTime } from '../../i18n/format'
import { deviceStrings } from '../../i18n/device-strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'
import { formatBytes } from '../chat/chat-format'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { signatureAnswer } from './device-answers'
import { type DeviceSheetProps, refusalIn, ShareActions, useAlive } from './device-frame'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { useReportBusy } from './sheet-busy'
import {
  drawSignature,
  extend,
  inkOf,
  MAX_POINTS,
  MIN_INK,
  PAD,
  type Point,
  signaturePng,
  signatureSvg,
  statementSha256,
  type Stroke
} from './signature-export'
import { markHiddenCharacters } from './verbatim-detail'

export interface SignatureSheetProps extends DeviceSheetProps<SignatureAsk> {
  /** The PNG of the strokes; the canvas's own unless a test hands in its own (jsdom has no canvas). */
  renderPng?: (strokes: readonly Stroke[]) => Promise<Blob>
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'preparing' }
  | { kind: 'uploading'; index: number; name: string }
  | { kind: 'sending' }
  | { kind: 'failed'; name: string; why: 'prepare' | 'upload' }

const pointCount = (strokes: readonly Stroke[]): number => strokes.reduce((sum, stroke) => sum + stroke.length, 0)

export function SignatureSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  onLater,
  onCannotShow,
  onUpload,
  renderPng = signaturePng,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: SignatureSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const { upload } = ask
  const ids = useId()
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  const alive = useAlive()
  const canvas = useRef<HTMLCanvasElement>(null)
  /** The strokes, in the pad's own coordinates: the drawing is read from here, never from the canvas. */
  const strokes = useRef<Stroke[]>([])
  /** The pointer that is drawing, and the stroke it is making. */
  const active = useRef<{ id: number; stroke: Stroke } | null>(null)
  /** What is already up for the strokes as they are now: reused when the person tries again. */
  const uploaded = useRef<{ png: UploadedFile; svg: UploadedFile } | null>(null)
  const cancel = useRef<AbortController | null>(null)
  const clockNow = (): number => (now ? now() : Date.now())
  /** The time the sheet shows beside the signature: kept current, since the answer says when it was pressed. */
  const [clock, setClock] = useState(clockNow)
  const [ink, setInk] = useState(0)
  const [announce, setAnnounce] = useState('')
  const [full, setFull] = useState(false)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [problem, setProblem] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)
  /** The gateway's refusal is about a drawing that was changed since: it is out of date. */
  const [changed, setChanged] = useState(false)

  useEffect(() => {
    setChanged(false)
  }, [request.refusal])

  useEffect(() => () => cancel.current?.abort(), [])

  useEffect(() => {
    const timer = setInterval(() => setClock(clockNow()), 15_000)

    return () => clearInterval(timer)
    // The clock is read afresh on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [now])

  const working = phase.kind !== 'idle' && phase.kind !== 'failed'
  // Preparing, uploading and sending are not cut off by a question that arrives meanwhile (`sheet-order.ts`).
  useReportBusy(working || sending.pending)

  const locked = !armed || sending.pending || sending.finished
  const busy = locked || working
  const signable = ink >= MIN_INK

  /** The pad as a canvas draws it: from the strokes, on white. */
  function redraw(): void {
    const context = canvas.current?.getContext('2d')

    if (context) {
      drawSignature(context, strokes.current)
    }
  }

  // The empty pad, white, once the canvas is there.
  useEffect(() => {
    redraw()
  }, [])

  /** The pad's coordinates of a pointer event: the canvas is shown at any width, the pad is always 600 by 200. */
  function pointOf(
    event: ReactPointerEvent<HTMLCanvasElement>,
    sample: { clientX: number; clientY: number } = event
  ): Point {
    const box = event.currentTarget.getBoundingClientRect()

    return {
      x: ((sample.clientX - box.left) / (box.width || 1)) * PAD.width,
      y: ((sample.clientY - box.top) / (box.height || 1)) * PAD.height
    }
  }

  function changedDrawing(): void {
    uploaded.current = null
    setInk(inkOf(strokes.current))
    setChanged(true)
    setProblem(null)
    setOffline(false)
    sending.clearNotice()

    if (phase.kind === 'failed') {
      setPhase({ kind: 'idle' })
    }
  }

  function down(event: ReactPointerEvent<HTMLCanvasElement>): void {
    // A mouse draws with its main button only; a finger or a pen always.
    if (busy || active.current || (event.pointerType === 'mouse' && event.button !== 0)) {
      return
    }

    if (pointCount(strokes.current) >= MAX_POINTS) {
      setFull(true)

      return
    }

    event.preventDefault()
    event.currentTarget.setPointerCapture?.(event.pointerId)

    const stroke: Stroke = [pointOf(event)]

    active.current = { id: event.pointerId, stroke }
    strokes.current = [...strokes.current, stroke]
    drawDot(stroke)
    changedDrawing()
  }

  /** What a pointer just did, drawn at once as a line from the point before (the export smooths it). */
  function drawDot(stroke: Stroke): void {
    const context = canvas.current?.getContext('2d')
    const last = stroke[stroke.length - 1]
    const before = stroke[stroke.length - 2] ?? last

    if (!context || !last || !before) {
      return
    }

    context.save()
    context.setTransform(PAD.scale, 0, 0, PAD.scale, 0, 0)
    context.strokeStyle = '#000000'
    context.lineWidth = PAD.ink
    context.lineCap = 'round'
    context.lineJoin = 'round'
    context.beginPath()
    context.moveTo(before.x, before.y)
    context.lineTo(last.x, last.y)
    context.stroke()
    context.restore()
  }

  function move(event: ReactPointerEvent<HTMLCanvasElement>): void {
    const current = active.current

    if (!current || current.id !== event.pointerId) {
      return
    }

    // A pad can report many samples between two frames; take them all.
    const samples = event.nativeEvent.getCoalescedEvents?.() ?? []
    const points = samples.length > 0 ? samples.map(sample => pointOf(event, sample)) : [pointOf(event)]
    let stroke = current.stroke

    for (const point of points) {
      if (pointCount(strokes.current) + (stroke.length - current.stroke.length) >= MAX_POINTS) {
        setFull(true)

        break
      }

      const next = extend(stroke, point)

      if (next !== stroke) {
        stroke = next
        current.stroke = stroke
        strokes.current = [...strokes.current.slice(0, -1), stroke]
        drawDot(stroke)
      }
    }

    setInk(inkOf(strokes.current))
  }

  function up(event: ReactPointerEvent<HTMLCanvasElement>): void {
    if (active.current?.id === event.pointerId) {
      active.current = null
      setAnnounce(deviceStrings.signature.drawn)
    }
  }

  function clear(): void {
    active.current = null
    strokes.current = []
    setFull(false)
    redraw()
    changedDrawing()
    setAnnounce(deviceStrings.signature.cleared)
  }

  /** Build both files, put what is not up yet on the gateway, and answer. */
  async function sign(): Promise<void> {
    if (locked || working || !signable) {
      return
    }

    const control = new AbortController()
    let failing = 'signature.png'

    cancel.current = control
    setProblem(null)
    setOffline(false)
    setPhase({ kind: 'preparing' })

    try {
      const signedAt = clockNow()
      const hash = await statementSha256(ask.statement)
      let files = uploaded.current

      if (!files) {
        const png = await renderPng(strokes.current)
        const svg = new Blob([signatureSvg(strokes.current)], { type: 'image/svg+xml' })
        const parts = [
          { name: 'signature.png', mime: 'image/png', blob: png },
          { name: 'signature.svg', mime: 'image/svg+xml', blob: svg }
        ]

        // The limits, on the bytes that will go, before the first upload starts.
        const tooLarge = parts.find(part => part.blob.size > upload.maxBytes)

        if (tooLarge || parts.reduce((sum, part) => sum + part.blob.size, 0) > upload.maxTotalBytes) {
          setProblem(
            sheetStrings.interactive.file.problemPreparedTooLarge({
              name: tooLarge?.name ?? 'signature',
              max: formatBytes(tooLarge ? upload.maxBytes : upload.maxTotalBytes)
            })
          )
          setPhase({ kind: 'idle' })

          return
        }

        const made: UploadedFile[] = []

        for (const [index, part] of parts.entries()) {
          failing = part.name
          setPhase({ kind: 'uploading', index, name: part.name })

          if (!onUpload) {
            throw new FileUploadError('failed', 'no way to upload')
          }

          const path = flatUploadPath(upload.dir, part.name)

          await onUpload(
            path,
            { name: part.name, size: part.blob.size, mimeType: part.mime, uri: '', body: part.blob },
            { signal: control.signal }
          )
          made.push({
            path,
            name: part.name,
            mime: part.mime,
            bytes: part.blob.size,
            sha256: await sha256Hex(part.blob)
          })
        }

        files = { png: made[0] as UploadedFile, svg: made[1] as UploadedFile }
        uploaded.current = files
      }

      setPhase({ kind: 'sending' })
      await sending.run(() => onAnswer(signatureAnswer(files.png, files.svg, hash, signedAt)))

      if (alive.current) {
        setPhase({ kind: 'idle' })
      }
    } catch (error) {
      if (!alive.current) {
        return
      }

      if (error instanceof FileUploadError && error.reason === 'cancelled') {
        setPhase({ kind: 'idle' })
      } else {
        setPhase({ kind: 'failed', name: failing, why: error instanceof FileUploadError ? 'upload' : 'prepare' })
      }
    } finally {
      cancel.current = null
    }
  }

  const words = deviceStrings.signature
  const fileWords = sheetStrings.interactive.file
  const refusal = changed ? null : refusalIn(request.refusal, { 'statement:mismatch': words.refusedStatement })
  const statementId = `${ids}-statement`
  const hintId = `${ids}-hint`
  const phaseText =
    phase.kind === 'preparing'
      ? words.preparing
      : phase.kind === 'uploading'
        ? fileWords.uploading({ current: phase.index + 1, total: 2, name: phase.name })
        : phase.kind === 'sending'
          ? fileWords.sending
          : ''

  return (
    <InteractiveFrame
      request={request}
      gateway={gateway}
      title={words.title}
      titleId={titleId}
      descriptionId={descriptionId}
      receiver={words.receiver}
      {...(now ? { now } : {})}
      status={
        <>
          <RefusalAlert text={refusal} />
          <SendStatus notice={sending.notice ?? (offline ? 'offline' : null)} />
          {problem ? (
            <p className="hm-form__error" role="alert">
              {problem}
            </p>
          ) : null}
          {phase.kind === 'failed' ? (
            <div className="hm-interactive__failure" role="alert">
              <p className="hm-requests__phase" data-tone="danger">
                {phase.why === 'prepare'
                  ? fileWords.problemPrepare({ name: phase.name })
                  : fileWords.uploadFailed({ name: phase.name })}
              </p>
              <p className="hm-requests__meta">{fileWords.failedNote}</p>
            </div>
          ) : null}
          {working ? (
            <div className="hm-file__progress">
              <progress aria-label={fileWords.progress} />
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
            <Button className="hm-requests__action" variant="quiet" onClick={onLater}>
              {sheetStrings.interactive.later}
            </Button>
            <Button className="hm-requests__action" variant="quiet" onClick={() => cancel.current?.abort()}>
              {fileWords.cancel}
            </Button>
          </>
        ) : (
          <ShareActions
            optional={ask.optional}
            busy={busy}
            sending={sending}
            onLater={onLater}
            onSkip={onSkip}
            onCannotShow={onCannotShow}
          >
            {phase.kind === 'failed' ? (
              <Button
                className="hm-requests__action"
                variant="quiet"
                disabled={locked}
                onClick={() => setOffline(onCannotShow('upload_failed') === 'offline')}
              >
                {fileWords.giveUp}
              </Button>
            ) : null}
            <Button
              className="hm-requests__action"
              variant="primary"
              disabled={busy || !signable}
              aria-describedby={signable ? undefined : hintId}
              data-signature-send=""
              onClick={() => void sign()}
            >
              {phase.kind === 'failed' ? fileWords.retry : words.sign}
            </Button>
          </ShareActions>
        )
      }
    >
      <div className="hm-requests__detail-box">
        <p className="hm-requests__label" id={statementId}>
          {words.statement}
        </p>
        <pre
          className="hm-draft__text hm-signature__statement"
          dir="auto"
          tabIndex={0}
          aria-labelledby={statementId}
          data-signature-statement=""
        >
          {markHiddenCharacters(ask.statement, { tabs: true })}
        </pre>
        {ask.signerName ? (
          <p className="hm-requests__meta">
            {words.signer}: <span data-agent-text="">{ask.signerName}</span>
          </p>
        ) : null}
        <p className="hm-requests__meta">
          {words.time}: {formatDateTime(clock)}
        </p>
      </div>

      <div className="hm-signature__pad">
        <canvas
          ref={canvas}
          className="hm-signature__canvas"
          width={PAD.width * PAD.scale}
          height={PAD.height * PAD.scale}
          role="img"
          aria-label={words.pad}
          aria-describedby={hintId}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          data-signature-pad=""
        />
        <div className="hm-signature__tools">
          <p className="hm-form__hint" id={hintId}>
            {full ? words.tooLong : words.hint}
          </p>
          <Button variant="quiet" disabled={busy || ink === 0} onClick={clear} data-signature-clear="">
            {words.clear}
          </Button>
        </div>
        <p className="hm-sr" role="status" aria-live="polite">
          {announce}
        </p>
      </div>
    </InteractiveFrame>
  )
}
