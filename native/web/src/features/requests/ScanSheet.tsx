/**
 * The sheet for a `device.scan` request: one code (QR or barcode) read with the camera, shown to the person, and sent
 * only when they press Send (`contract/requests/README.md` section 12).
 *
 *  - **Start first, then the camera.** The browser asks for the camera only after the person pressed Start on the sheet.
 *  - **The camera picture stays here.** Frames are given to the browser's `BarcodeDetector` and nothing else; no frame is
 *    drawn to a canvas, stored or sent. The stream is stopped the moment a code is read, when the sheet is put away or
 *    hidden behind another, and when it goes.
 *  - **Only the symbologies asked for**, and only those this browser's detector reads (`getSupportedFormats`): a request
 *    for none of them cannot be done here, and the sheet says so instead of scanning in vain.
 *  - **The value is untrusted** (a code is whatever its printer chose). It is shown as plain text, with every character
 *    the eye cannot see marked by its code point, BEFORE it is sent; it is never opened, followed or launched, and it is
 *    sent only on an explicit press. Rescan starts over.
 */
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'

import { type ScanAsk, SYMBOLOGIES, type Symbology } from '../../core/requests/interactive-types'
import { listOf, recordStrings } from '../../i18n/record-strings'
import { deviceStrings } from '../../i18n/device-strings'
import { useLocale } from '../../i18n/use-locale'
import { pageBarcodeDetector, pageNavigator } from '../../platform/device-apis'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { DETECTOR_FORMATS, scanAnswer } from './device-answers'
import { type DeviceSheetProps, refusalIn, ShareActions, useAlive } from './device-frame'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { useReportBusy } from './sheet-busy'
import { markHiddenCharacters } from './verbatim-detail'

/** The slice of `BarcodeDetector` the sheet uses (the type is not in the DOM library). */
export interface CodeDetector {
  detect(source: HTMLVideoElement): Promise<{ rawValue: string; format: string }[]>
}

export interface CodeDetectorClass {
  new (options?: { formats?: string[] }): CodeDetector
  getSupportedFormats?(): Promise<string[]>
}

/** What the sheet takes from the browser; the page's own unless a test hands in its own. */
export interface ScanEnvironment {
  Detector?: CodeDetectorClass | undefined
  getUserMedia?: ((constraints: MediaStreamConstraints) => Promise<MediaStream>) | undefined
}

export interface ScanSheetProps extends DeviceSheetProps<ScanAsk> {
  environment?: ScanEnvironment
  /** Milliseconds between two looks at the picture. Tests pass a short one. */
  pollMs?: number
}

const pageEnvironment = (): ScanEnvironment => ({
  Detector: pageBarcodeDetector<CodeDetectorClass>(),
  getUserMedia:
    pageNavigator()?.mediaDevices?.getUserMedia === undefined
      ? undefined
      : constraints => (pageNavigator() as Navigator).mediaDevices.getUserMedia(constraints)
})

type Phase = 'idle' | 'starting' | 'scanning' | 'found' | 'failed'

/** How often the picture is looked at: often enough to feel instant, rarely enough to leave the page alone. */
const POLL_MS = 250

const stop = (stream: MediaStream | null): void => {
  for (const track of stream?.getTracks() ?? []) {
    track.stop()
  }
}

export function ScanSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  onLater,
  onCannotShow,
  environment,
  pollMs = POLL_MS,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: ScanSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const ids = useId()
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  const alive = useAlive()
  const env = environment ?? pageEnvironment()
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  /** A camera that arrives after the person put the sheet away, or pressed Start again, is not used: it is stopped. */
  const attempt = useRef(0)
  const [phase, setPhase] = useState<Phase>('idle')
  /** The symbologies asked for that this browser reads; `null` until the detector was asked. */
  const [reads, setReads] = useState<readonly Symbology[] | null>(null)
  const [found, setFound] = useState<{ value: string; symbology: Symbology } | null>(null)
  const [changed, setChanged] = useState(false)

  useEffect(() => {
    setChanged(false)
  }, [request.refusal])

  // Which of the symbologies asked for the browser can read.
  useEffect(() => {
    let live = true
    const asked = ask.formats ?? SYMBOLOGIES

    void (env.Detector?.getSupportedFormats?.() ?? Promise.resolve(asked.map(name => DETECTOR_FORMATS[name]))).then(
      supported => live && setReads(asked.filter(name => supported.includes(DETECTOR_FORMATS[name]))),
      () => live && setReads(asked)
    )

    return () => {
      live = false
    }
    // The detector class does not change while the sheet is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask.formats])

  const camera = phase === 'starting' || phase === 'scanning'
  // The camera and an answer on its way are not cut off by a question that arrives meanwhile (`sheet-order.ts`).
  useReportBusy(camera || sending.pending)

  const locked = !armed || sending.pending || sending.finished
  const unreadable = reads !== null && reads.length === 0

  // A sheet that is put away or hidden behind another stops looking, and goes back to the start.
  useEffect(() => {
    if (!shown && camera) {
      // A camera still being asked for is for nobody now: when it arrives it is stopped.
      attempt.current += 1
      stop(stream.current)
      stream.current = null
      setPhase('idle')
    }
  }, [shown, camera])

  // The camera is let go when the sheet goes, whatever it was doing.
  useEffect(
    () => () => {
      attempt.current += 1
      stop(stream.current)
      stream.current = null
    },
    []
  )

  // While scanning: show the picture and look at it, until a code the request asks for is read.
  useEffect(() => {
    if (phase !== 'scanning' || !stream.current || !env.Detector || reads === null) {
      return
    }

    const element = video.current
    const detector = new env.Detector({ formats: reads.map(name => DETECTOR_FORMATS[name]) })
    let live = true
    let looking = false

    if (element) {
      element.srcObject = stream.current
      void element.play().catch(() => undefined)
    }

    const timer = setInterval(() => {
      if (looking || !element || element.readyState < 2) {
        return
      }

      looking = true
      detector
        .detect(element)
        .then(codes => {
          for (const code of codes) {
            const answer = scanAnswer(reads, code)

            if (live && answer) {
              live = false
              stop(stream.current)
              stream.current = null
              setFound({ value: answer.value, symbology: answer.symbology })
              setChanged(true)
              setPhase('found')

              return
            }
          }
        })
        .catch(() => undefined)
        .finally(() => {
          looking = false
        })
    }, pollMs)

    return () => {
      live = false
      clearInterval(timer)

      if (element) {
        element.srcObject = null
      }
    }
    // The detector and the formats are fixed for as long as the camera runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, reads, pollMs])

  async function start(): Promise<void> {
    if (locked || camera || !env.getUserMedia || reads === null || unreadable) {
      return
    }

    attempt.current += 1

    const mine = attempt.current

    setPhase('starting')
    setFound(null)
    sending.clearNotice()

    try {
      const media = await env.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })

      // The sheet went, was put away, or Start was pressed again meanwhile: this camera is nobody's.
      if (!alive.current || attempt.current !== mine) {
        stop(media)

        return
      }

      // Never two cameras at once: whatever was held is let go before this one is kept.
      stop(stream.current)
      stream.current = media
      setPhase('scanning')
    } catch (error) {
      if (!alive.current || attempt.current !== mine) {
        return
      }

      const name = error instanceof DOMException || error instanceof Error ? error.name : ''

      if (name === 'NotAllowedError' || name === 'SecurityError') {
        // The person (or the browser's settings) said no: that is the bot's answer.
        setPhase('idle')
        sending.declined(onCannotShow('permission_denied'))
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        setPhase('idle')
        sending.declined(onCannotShow('no_camera'))
      } else {
        setPhase('failed')
      }
    }
  }

  const words = deviceStrings.scan
  const refusal = changed ? null : refusalIn(request.refusal, { 'scan:empty': words.refusedEmpty })
  const kinds = listOf((reads ?? []).map(name => recordStrings.symbology[name]))
  const valueId = `${ids}-value`

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
          <SendStatus notice={sending.notice} />
          {phase === 'starting' ? (
            <p className="hm-requests__phase" role="status">
              {words.starting} {deviceStrings.common.browserMayAsk}
            </p>
          ) : null}
          {phase === 'scanning' ? (
            <p className="hm-requests__phase" role="status">
              {words.scanning}
            </p>
          ) : null}
          {phase === 'found' ? (
            <p className="hm-requests__phase" role="status">
              {words.found}
            </p>
          ) : null}
          {phase === 'failed' ? (
            <p className="hm-requests__phase" role="alert" data-tone="danger">
              {words.failed}
            </p>
          ) : null}
        </>
      }
      actions={
        <ShareActions
          optional={ask.optional}
          busy={locked}
          sending={sending}
          onLater={onLater}
          onSkip={onSkip}
          onCannotShow={onCannotShow}
        >
          {unreadable ? (
            <Button
              className="hm-requests__action"
              variant="quiet"
              disabled={locked}
              onClick={() => sending.declined(onCannotShow('not_supported_on_device'))}
            >
              {deviceStrings.common.cannotDo}
            </Button>
          ) : phase === 'found' && found ? (
            <>
              <Button
                className="hm-requests__action"
                variant="quiet"
                disabled={locked}
                data-scan-rescan=""
                onClick={() => void start()}
              >
                {words.rescan}
              </Button>
              <Button
                className="hm-requests__action"
                variant="primary"
                disabled={locked}
                data-scan-send=""
                onClick={() =>
                  void sending.run(() =>
                    onAnswer({ status: 'answered', value: found.value, symbology: found.symbology })
                  )
                }
              >
                {words.send}
              </Button>
            </>
          ) : (
            <Button
              className="hm-requests__action"
              variant="primary"
              disabled={locked || camera || reads === null || !env.getUserMedia || !env.Detector}
              data-scan-start=""
              onClick={() => void start()}
            >
              {phase === 'failed' ? deviceStrings.location.retry : words.start}
            </Button>
          )}
        </ShareActions>
      }
    >
      {unreadable ? (
        <p className="hm-form__error">{words.unreadable}</p>
      ) : (
        <p className="hm-form__hint">
          {ask.formats === undefined && reads !== null ? words.lookingAny : words.looking({ kinds })}
        </p>
      )}

      {camera ? (
        <video
          ref={video}
          className="hm-scan__video"
          autoPlay
          muted
          playsInline
          aria-label={words.preview}
          data-scan-video=""
        />
      ) : null}

      {phase === 'found' && found ? (
        <div className="hm-requests__detail-box">
          <p className="hm-requests__label" id={valueId}>
            {words.value}
          </p>
          <pre
            className="hm-draft__text hm-scan__value"
            dir="auto"
            tabIndex={0}
            aria-labelledby={valueId}
            data-scan-value=""
          >
            {markHiddenCharacters(found.value, { tabs: true })}
          </pre>
          <p className="hm-requests__meta">{words.kind({ kind: recordStrings.symbology[found.symbology] })}</p>
        </div>
      ) : null}
    </InteractiveFrame>
  )
}
