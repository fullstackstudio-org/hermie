/**
 * The sheet for a `device.location` request: where the device is now, once, approximately or precisely
 * (`contract/requests/README.md` section 9).
 *
 *  - **Share first, then the browser.** The sheet says what is asked and how exact; the browser's own permission prompt
 *    comes only after the person pressed Share, never on opening and never instead of it.
 *  - **Never more exact than the person chose.** A request for `approximate` offers no more; one for `precise` lets the
 *    person lower it. A browser has no reduced-accuracy mode, so an approximate share asks the browser with
 *    `enableHighAccuracy: false` and the page rounds what comes back (two decimals, an accuracy of at least 1,000 m)
 *    before it leaves; the gateway rounds again and does not need this to.
 *  - **One fix, never watching.** `getCurrentPosition`, with no cached position (`maximumAge: 0`).
 *  - **Denied is an answer to the bot** (`4041 permission_denied`), not a made-up skip; a fix that could not be had is
 *    said, with Try again and a way to give up (`4041 location_unavailable`).
 */
import { type ReactElement, useEffect, useId, useRef, useState } from 'react'

import type { LocationAsk, LocationPrecision } from '../../core/requests/interactive-types'
import { deviceStrings } from '../../i18n/device-strings'
import { useLocale } from '../../i18n/use-locale'
import { Button } from '../../ui/primitives'
import { DEFAULT_TAP_GUARD_MS } from './ApprovalSheet'
import { locationAnswer } from './device-answers'
import { type DeviceSheetProps, refusalIn, ShareActions, useAlive } from './device-frame'
import { InteractiveFrame, RefusalAlert, SendStatus, useSending, useTapGuard } from './interactive-frame'
import { useReportBusy } from './sheet-busy'

/** How long the browser has to find a position once it is allowed to look. */
const LOCATE_TIMEOUT_MS = 20_000

export interface LocationSheetProps extends DeviceSheetProps<LocationAsk> {
  /** The browser's geolocation; the page's own unless a test hands in its own. */
  geolocation?: Pick<Geolocation, 'getCurrentPosition'> | undefined
}

export function LocationSheet({
  request,
  gateway,
  titleId,
  descriptionId,
  onAnswer,
  onSkip,
  onLater,
  onCannotShow,
  geolocation,
  shown = true,
  tapGuardMs = DEFAULT_TAP_GUARD_MS,
  now
}: LocationSheetProps): ReactElement {
  useLocale()

  const { ask } = request
  const ids = useId()
  const armed = useTapGuard(tapGuardMs, request.id, shown)
  const sending = useSending()
  const alive = useAlive()
  const [chosen, setChosen] = useState<LocationPrecision>(ask.precision)
  const [phase, setPhase] = useState<'idle' | 'locating' | 'failed'>('idle')
  /** A fix that arrives after the person put the sheet away, or pressed Share again, is not used. */
  const attempt = useRef(0)

  useEffect(() => {
    // The sheet goes: a fix still on its way is for nobody.
    return () => {
      attempt.current += 1
    }
  }, [])

  const locating = phase === 'locating'
  // Locating and sending are not cut off by a question that arrives meanwhile (`sheet-order.ts`).
  useReportBusy(locating || sending.pending)

  const locked = !armed || sending.pending || sending.finished
  const busy = locked || locating
  const fixed = geolocation ?? (typeof navigator === 'undefined' ? undefined : navigator.geolocation)

  function share(): void {
    if (busy || !fixed) {
      return
    }

    attempt.current += 1

    const mine = attempt.current

    setPhase('locating')
    sending.clearNotice()

    fixed.getCurrentPosition(
      position => {
        if (!alive.current || attempt.current !== mine) {
          return
        }

        const answer = locationAnswer(ask.precision, chosen, {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp
        })

        if (answer === null) {
          setPhase('failed')

          return
        }

        setPhase('idle')
        void sending.run(() => onAnswer(answer))
      },
      error => {
        if (!alive.current || attempt.current !== mine) {
          return
        }

        // The person (or the browser's settings) said no: that is the bot's answer, not ours to turn into a skip.
        if (error.code === 1) {
          setPhase('idle')
          sending.declined(onCannotShow('permission_denied'))

          return
        }

        setPhase('failed')
      },
      // A browser's only reduced mode is not asking for a high-accuracy fix; the rounding is the page's.
      { enableHighAccuracy: chosen === 'precise', timeout: LOCATE_TIMEOUT_MS, maximumAge: 0 }
    )
  }

  const words = deviceStrings.location
  const refusal = refusalIn(request.refusal, {})
  const groupName = `${ids}-precision`

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
          {locating ? (
            <p className="hm-requests__phase" role="status">
              {words.locating} {deviceStrings.common.browserMayAsk}
            </p>
          ) : null}
          {phase === 'failed' ? (
            <p className="hm-requests__phase" role="alert" data-tone="danger">
              {words.unavailable}
            </p>
          ) : null}
        </>
      }
      actions={
        <ShareActions
          optional={ask.optional}
          busy={busy}
          sending={sending}
          onLater={onLater}
          onSkip={onSkip}
          onCannotShow={onCannotShow}
        >
          {phase === 'failed' ? (
            <Button
              className="hm-requests__action"
              variant="quiet"
              disabled={locked}
              onClick={() => sending.declined(onCannotShow('location_unavailable'))}
            >
              {words.giveUp}
            </Button>
          ) : null}
          <Button
            className="hm-requests__action"
            variant="primary"
            disabled={busy || !fixed}
            data-share-location=""
            onClick={share}
          >
            {phase === 'failed' ? words.retry : words.share}
          </Button>
        </ShareActions>
      }
    >
      <fieldset className="hm-form__field hm-form__group" disabled={busy}>
        <legend className="hm-requests__label">{words.legend}</legend>
        <div className="hm-requests__choices">
          {ask.precision === 'precise' ? (
            <label className="hm-requests__choice">
              <input
                type="radio"
                name={groupName}
                checked={chosen === 'precise'}
                onChange={() => setChosen('precise')}
                data-precision="precise"
              />
              <span>{words.precise}</span>
            </label>
          ) : null}
          <label className="hm-requests__choice">
            <input
              type="radio"
              name={groupName}
              checked={chosen === 'approximate'}
              onChange={() => setChosen('approximate')}
              data-precision="approximate"
            />
            <span>{words.approximate}</span>
          </label>
        </div>
        {ask.precision === 'approximate' ? <p className="hm-form__hint">{words.onlyApproximate}</p> : null}
        {chosen === 'approximate' ? <p className="hm-form__hint">{words.roundedNote}</p> : null}
      </fieldset>
    </InteractiveFrame>
  )
}
