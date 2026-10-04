/**
 * The sheet for a voice note (`input.file` with `accept: audio` and `capture: audio`, `contract/requests/README.md`
 * section 5.1) where this browser can record: `MediaRecorder` and a microphone. Anywhere else the request is the
 * ordinary file sheet, which picks an audio file.
 *
 *  - **Record first, then the microphone.** The browser asks for it only after Record was pressed on the sheet.
 *  - **Listen before it goes.** The recording is played back on the sheet and uploaded only when the person presses Send;
 *    Record again throws it away. Nothing is uploaded, kept or sent while the person is still deciding.
 *  - **A recording stops with the sheet.** The microphone is let go when the recording stops, when the sheet is put away
 *    or hidden behind another, and when it goes. A recording that reaches the size the gateway takes stops by itself and
 *    says so.
 *  - **The declared type has no parameters** (`audio/mp4`, not `audio/mp4;codecs=mp4a.40.2`): the gateway refuses it
 *    otherwise (`file:<n>:not_audio`). `audio/mp4` is preferred where the browser records it; the sheet never makes a
 *    transcript (a browser has no on-device recognition it could promise), so the answer carries no `text`.
 *  - **A file can always be picked instead** (`pickInstead`): a refused or missing microphone is no reason to decline.
 */
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { FileUploadError, flatUploadPath } from '../../core/chats/file-upload'
import type { FileAsk, UploadedFile } from '../../core/requests/interactive-types'
import { sha256Hex } from '../../core/requests/sha256'
import { deviceStrings } from '../../i18n/device-strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { pageMediaRecorder, pageNavigator } from '../../platform/device-apis'
import { Button } from '../../ui/primitives'
import { formatBytes } from '../chat/chat-format'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { type DeviceSheetProps, ShareActions, useAlive } from './device-frame'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { useReportBusy } from './sheet-busy'

/** The slice of `MediaRecorder` the sheet uses. */
export interface RecorderLike {
  readonly mimeType: string
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror: (() => void) | null
  start(timeslice?: number): void
  stop(): void
}

export interface RecorderClass {
  new (stream: MediaStream, options?: { mimeType?: string }): RecorderLike
  isTypeSupported?(type: string): boolean
}

/** What the sheet takes from the browser; the page's own unless a test hands in its own. */
export interface VoiceEnvironment {
  Recorder?: RecorderClass | undefined
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined
}

export interface VoiceSheetProps extends DeviceSheetProps<FileAsk> {
  environment?: VoiceEnvironment
  /** The file sheet for this request: what Choose an audio file instead shows. */
  renderPicker: () => ReactElement
}

const pageEnvironment = (): VoiceEnvironment => ({
  Recorder: pageMediaRecorder<RecorderClass>(),
  getUserMedia:
    pageNavigator()?.mediaDevices?.getUserMedia === undefined
      ? undefined
      : constraints => (pageNavigator() as Navigator).mediaDevices.getUserMedia(constraints)
})

/** The types tried, best first: `audio/mp4` plays everywhere a voice note is read, the others where it is not offered. */
const PREFERRED = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
const AUDIO_TYPE = /^audio\/[a-z0-9][a-z0-9.+-]{0,62}$/u
const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/mp4': 'm4a',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav'
}
/** A recording stops at this share of what the gateway takes, so the container's overhead still fits. */
const FULL_SHARE = 0.9

/** `audio/mp4` for `audio/mp4;codecs=mp4a.40.2`: a type without its parameters, lower case. */
export const bareType = (type: string): string => (type.split(';')[0] ?? '').trim().toLowerCase()

/** The first of `PREFERRED` the browser records, or `undefined` (the browser then picks its own). */
export const preferredType = (Recorder: RecorderClass): string | undefined =>
  PREFERRED.find(type => Recorder.isTypeSupported?.(type) === true)

/** The type to declare for what was recorded: the recorder's own, bare, or the type asked for, bare. */
export function declaredType(recorded: string, asked: string | undefined): string {
  const own = bareType(recorded)

  if (AUDIO_TYPE.test(own)) {
    return own
  }

  const fallback = bareType(asked ?? '')

  return AUDIO_TYPE.test(fallback) ? fallback : 'audio/webm'
}

/** `m:ss`. */
const clock = (seconds: number): string => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`

type Phase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'recording' }
  | { kind: 'ready' }
  | { kind: 'uploading' }
  | { kind: 'sending' }
  | { kind: 'failed'; why: 'prepare' | 'upload' }

interface Take {
  blob: Blob
  mime: string
  name: string
  url: string | null
}

export function VoiceSheet({ renderPicker, ...props }: VoiceSheetProps): ReactElement {
  const [picking, setPicking] = useState(false)

  return picking ? renderPicker() : <Recorder {...props} onPick={() => setPicking(true)} />
}

function Recorder({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  onLater,
  onCannotShow,
  onUpload,
  environment,
  onPick,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: Omit<VoiceSheetProps, 'renderPicker'> & { onPick: () => void }): ReactElement {
  useLocale()

  const { ask } = request
  const { upload } = ask
  const ids = useId()
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  const alive = useAlive()
  /** A recorder that was told to stop is not told again (a stopped one refuses it). */
  const stopping = useRef(false)
  const env = environment ?? pageEnvironment()
  const stream = useRef<MediaStream | null>(null)
  const recorder = useRef<RecorderLike | null>(null)
  const cancel = useRef<AbortController | null>(null)
  /** What is already up for the take as it is now: reused when the person tries again. */
  const uploaded = useRef<UploadedFile | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [take, setTake] = useState<Take | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [micFailed, setMicFailed] = useState(false)
  const [recordFailed, setRecordFailed] = useState(false)
  const [full, setFull] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [offline, setOffline] = useState(false)

  const recording = phase.kind === 'recording' || phase.kind === 'starting'
  const working = phase.kind === 'uploading' || phase.kind === 'sending'
  // The microphone and an upload are not cut off by a question that arrives meanwhile (`sheet-order.ts`).
  useReportBusy(recording || working || sending.pending)

  const locked = !armed || sending.pending || sending.finished
  const busy = locked || working

  function stopRecorder(): void {
    if (!recorder.current || stopping.current) {
      return
    }

    stopping.current = true

    try {
      recorder.current.stop()
    } catch {
      // Already stopped: its end is on its way.
    }
  }

  function release(): void {
    for (const track of stream.current?.getTracks() ?? []) {
      track.stop()
    }

    stream.current = null
  }

  /** A take's playback address is let go when the take is replaced and when the sheet goes. */
  function forget(old: Take | null): void {
    if (old?.url) {
      URL.revokeObjectURL(old.url)
    }
  }

  const latest = useRef<Take | null>(null)

  useEffect(() => {
    latest.current = take
  }, [take])

  useEffect(
    () => () => {
      cancel.current?.abort()

      if (recorder.current) {
        recorder.current.ondataavailable = null
        recorder.current.onstop = null
        recorder.current.onerror = null

        try {
          recorder.current.stop()
        } catch {
          // Already stopped.
        }
      }

      release()
      forget(latest.current)
    },
    []
  )

  // The time shown while recording.
  useEffect(() => {
    if (phase.kind !== 'recording') {
      return
    }

    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250)

    return () => clearInterval(timer)
  }, [phase.kind])

  // A sheet that is put away or hidden behind another stops recording; what was recorded is kept.
  useEffect(() => {
    if (!shown && recorder.current && phase.kind === 'recording') {
      stopRecorder()
    }
  }, [shown, phase.kind])

  function finish(chunks: Blob[], asked: string | undefined, recorded: string): void {
    release()
    recorder.current = null

    if (!alive.current) {
      return
    }

    const mime = declaredType(recorded || chunks[0]?.type || '', asked)
    const blob = new Blob(chunks, { type: mime })

    if (blob.size === 0) {
      setRecordFailed(true)
      setPhase({ kind: 'idle' })

      return
    }

    const url = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null

    forget(latest.current)
    uploaded.current = null
    setTake({ blob, mime, name: `voice-note.${EXTENSIONS[mime] ?? 'audio'}`, url })
    setPhase({ kind: 'ready' })
  }

  async function record(): Promise<void> {
    if (locked || recording || working || !env.Recorder || !env.getUserMedia) {
      return
    }

    setMicFailed(false)
    setRecordFailed(false)
    setFull(false)
    setProblem(null)
    setOffline(false)
    setSeconds(0)
    sending.clearNotice()
    setPhase({ kind: 'starting' })

    let media: MediaStream

    try {
      media = await env.getUserMedia({ audio: true })
    } catch {
      if (alive.current) {
        setMicFailed(true)
        setPhase({ kind: 'idle' })
      }

      return
    }

    if (!alive.current) {
      for (const track of media.getTracks()) {
        track.stop()
      }

      return
    }

    stream.current = media
    stopping.current = false

    const asked = preferredType(env.Recorder)
    const chunks: Blob[] = []
    let size = 0
    const limit = Math.floor(Math.min(upload.maxBytes, upload.maxTotalBytes) * FULL_SHARE)

    try {
      const instance = new env.Recorder(media, asked ? { mimeType: asked } : undefined)

      recorder.current = instance
      instance.ondataavailable = event => {
        if (event.data.size > 0) {
          chunks.push(event.data)
          size += event.data.size
        }

        if (size >= limit && recorder.current === instance && !stopping.current) {
          setFull(true)
          stopRecorder()
        }
      }
      instance.onstop = () => finish(chunks, asked, instance.mimeType)
      instance.onerror = () => {
        release()
        recorder.current = null

        if (alive.current) {
          setRecordFailed(true)
          setPhase({ kind: 'idle' })
        }
      }
      instance.start(1_000)
      setPhase({ kind: 'recording' })
    } catch {
      release()
      recorder.current = null
      setRecordFailed(true)
      setPhase({ kind: 'idle' })
    }
  }

  function stopRecording(): void {
    stopRecorder()
  }

  /** Put the recording on the gateway, then answer. */
  async function send(): Promise<void> {
    if (locked || working || !take) {
      return
    }

    const control = new AbortController()

    cancel.current = control
    setProblem(null)
    setOffline(false)

    try {
      let file = uploaded.current

      if (!file) {
        if (take.blob.size > upload.maxBytes || take.blob.size > upload.maxTotalBytes) {
          setProblem(
            sheetStrings.interactive.file.problemPreparedTooLarge({
              name: take.name,
              max: formatBytes(Math.min(upload.maxBytes, upload.maxTotalBytes))
            })
          )

          return
        }

        setPhase({ kind: 'uploading' })

        if (!onUpload) {
          throw new FileUploadError('failed', 'no way to upload')
        }

        const path = flatUploadPath(upload.dir, take.name)

        await onUpload(
          path,
          { name: take.name, size: take.blob.size, mimeType: take.mime, uri: '', body: take.blob },
          { signal: control.signal }
        )
        file = { path, name: take.name, mime: take.mime, bytes: take.blob.size, sha256: await sha256Hex(take.blob) }
        uploaded.current = file
      }

      const files: UploadedFile[] = [file]

      setPhase({ kind: 'sending' })
      await sending.run(() => onAnswer({ status: 'answered', files }))

      if (alive.current) {
        setPhase({ kind: 'ready' })
      }
    } catch (error) {
      if (!alive.current) {
        return
      }

      setPhase(
        error instanceof FileUploadError && error.reason === 'cancelled'
          ? { kind: 'ready' }
          : { kind: 'failed', why: error instanceof FileUploadError ? 'upload' : 'prepare' }
      )
    } finally {
      cancel.current = null

      if (alive.current) {
        setPhase(current => (current.kind === 'uploading' ? { kind: 'ready' } : current))
      }
    }
  }

  const words = deviceStrings.voice
  const fileWords = sheetStrings.interactive.file
  const canRecord = env.Recorder !== undefined && env.getUserMedia !== undefined
  const takeName = take?.name ?? 'voice-note'
  const refusal = request.refusal === null ? null : sheetStrings.interactive.refusedOther({ reason: request.refusal })
  const noteId = `${ids}-note`

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
          <RefusalAlert text={take === null || phase.kind !== 'ready' ? null : refusal} />
          <SendStatus notice={sending.notice ?? (offline ? 'offline' : null)} />
          {micFailed ? (
            <p className="hm-requests__phase" role="alert" data-tone="danger">
              {words.micFailed}
            </p>
          ) : null}
          {recordFailed ? (
            <p className="hm-requests__phase" role="alert" data-tone="danger">
              {words.recordFailed}
            </p>
          ) : null}
          {full && take ? (
            <p className="hm-requests__phase" role="status">
              {words.full}
            </p>
          ) : null}
          {problem ? (
            <p className="hm-form__error" role="alert">
              {problem}
            </p>
          ) : null}
          {phase.kind === 'failed' ? (
            <div className="hm-interactive__failure" role="alert">
              <p className="hm-requests__phase" data-tone="danger">
                {phase.why === 'prepare'
                  ? fileWords.problemPrepare({ name: takeName })
                  : fileWords.uploadFailed({ name: takeName })}
              </p>
              <p className="hm-requests__meta">{fileWords.failedNote}</p>
            </div>
          ) : null}
          {working ? (
            <div className="hm-file__progress">
              <progress aria-label={fileWords.progress} />
              <p className="hm-requests__meta" role="status">
                {phase.kind === 'uploading'
                  ? fileWords.uploading({ current: 1, total: 1, name: takeName })
                  : fileWords.sending}
              </p>
            </div>
          ) : null}
        </>
      }
      actions={
        working && phase.kind === 'uploading' ? (
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
            busy={busy || recording}
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
            {take !== null && !recording ? (
              <Button
                className="hm-requests__action"
                variant="primary"
                disabled={busy}
                data-voice-send=""
                onClick={() => void send()}
              >
                {phase.kind === 'failed' ? fileWords.retry : words.send}
              </Button>
            ) : null}
          </ShareActions>
        )
      }
    >
      <div className="hm-voice">
        <p className="hm-form__hint" id={noteId}>
          {words.micAsk}
        </p>

        {recording ? (
          <div className="hm-voice__live">
            <p className="hm-requests__phase" role="status" data-voice-timer="">
              {phase.kind === 'starting' ? words.micAsk : words.recording({ time: clock(seconds) })}
            </p>
            <Button
              className="hm-requests__action"
              variant="primary"
              disabled={phase.kind !== 'recording'}
              data-voice-stop=""
              onClick={stopRecording}
            >
              {words.stop}
            </Button>
          </div>
        ) : (
          <div className="hm-requests__actions">
            <Button
              className="hm-requests__action"
              variant={take === null ? 'primary' : 'quiet'}
              disabled={busy || !canRecord}
              aria-describedby={noteId}
              data-voice-record=""
              onClick={() => void record()}
            >
              {take === null ? words.record : words.again}
            </Button>
            <Button className="hm-requests__action" variant="quiet" disabled={busy} data-voice-pick="" onClick={onPick}>
              {words.pickInstead}
            </Button>
          </div>
        )}

        {take !== null && !recording ? (
          <div className="hm-voice__take">
            <p className="hm-requests__meta">{words.ready({ size: formatBytes(take.blob.size) })}</p>
            {take.url ? (
              <audio
                className="hm-voice__player"
                controls
                src={take.url}
                aria-label={words.player}
                data-voice-player=""
              />
            ) : null}
          </div>
        ) : null}
      </div>
    </InteractiveFrame>
  )
}
