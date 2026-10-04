/**
 * The passkeys of the signed-in person on this gateway (`#/settings/passkeys`):
 * whether the level is on here and why not, the list, adding a passkey of this
 * browser by signing in again (when the gateway offers it) or with a one-time
 * code, making a code for another device, and removing a passkey. The native apps' Passkeys page (plan CP-10), kept to what a browser
 * needs; the rest of Settings is W-20b's.
 *
 * Every action goes through the passkey model (`PasskeyRuntimeContext`); the list
 * and the state are read from `state/passkeys.ts`. An invite or a removal is a
 * step-up: the browser asks for a passkey of this site first (plan P6, P7), so a
 * session alone can neither add nor remove one.
 *
 * Adding by signing in again is two steps with a trip in between: "Add a passkey" sends the whole window to the
 * gateway's sign-in page, and when the page is back the same section reads "Finish adding your passkey", a button,
 * because the browser's passkey sheet wants a click. Every failure of the sign-in names what happened and offers
 * "Sign in again".
 *
 * A code is shown once, as the gateway gave it, in the page (with a Copy button) and never in a live
 * region: the status line says it is ready, not what it is. It is never written anywhere.
 */
import { type FormEvent, type ReactElement, useEffect, useId, useState } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { displayEnrolmentCode } from '../../core/passkey/challenge'
import { isReauthFailure, type PasskeyActionError, type PasskeyInvite } from '../../core/passkey/model'
import { sheetStrings } from '../../i18n/sheet-strings'
import { formatDate, formatDateTime, formatDuration } from '../../i18n/format'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { writeClipboard } from '../../platform/clipboard'
import { type PasskeysState, passkeysStore } from '../../state/passkeys'
import { Button } from '../../ui/primitives'
import { noticeText } from '../requests/PasskeyNotices'
import { usePasskeyRuntime } from '../requests/passkey-runtime'
import './passkeys.css'

type Busy = null | 'enrol' | 'self' | 'finish' | 'invite' | { revoke: string }

interface Message {
  tone: 'ok' | 'danger'
  text: string
}

/** What a failed action says. */
export function actionFailure(error: unknown, rpId: string): string {
  const words = sheetStrings.passkeys.settings
  const problem = (error as PasskeyActionError | null)?.problem

  if (!problem) {
    return words.failed({ message: error instanceof Error ? error.message : String(error) })
  }

  switch (problem.kind) {
    case 'invalid_code':
      return words.invalidCode
    case 'not_supported':
      return words.notSupported
    case 'unavailable':
      return words.off({ reason: problem.reason || 'disabled' })
    case 'rp_not_accepted':
      return words.rpNotAccepted({ host: rpId })
    case 'not_enrolled':
      return words.notEnrolled
    case 'self_enrol_unavailable':
      switch (problem.reason) {
        case 'disabled':
          return words.selfDisabled
        case 'provider_no_reauth':
          return words.selfNoReauth
        default:
          return words.selfNotOffered
      }
    case 'self_enrol_stash':
      return words.selfStash
    case 'self_enrol_expired':
      return words.selfExpired
    case 'gateway_id_mismatch':
    case 'gateway_id_conflict':
      return noticeText(problem)
    case 'ceremony':
      switch (problem.problem.kind) {
        case 'cancelled':
          return words.cancelled
        case 'exists':
          return words.exists
        case 'unavailable':
          return words.notSupported
        case 'busy':
          return words.failed({ message: sheetStrings.passkeys.signing })
        case 'failed':
          return words.failed({ message: problem.problem.message })
      }

      return words.failed({ message: 'ceremony' })
    case 'refused':
      if (problem.error === 'code_invalid') {
        return words.codeRefused
      }

      if (problem.error === 'reauth_invalid') {
        return reauthInvalidText(problem.reason, problem.failure ?? '')
      }

      if (problem.error === 'self_enrol_disabled') {
        return words.selfDisabled
      }

      if (problem.error === 'provider_no_reauth') {
        return words.selfNoReauth
      }

      if (problem.error === 'insecure_binding') {
        return words.selfInsecure
      }

      if (problem.error === 'origin_not_listed') {
        // 403: the gateway does not list this page's address for passkeys. Its own state, in plain words.
        return words.originNotListed({ host: rpId })
      }

      if (problem.status === 429) {
        return problem.retryAfter !== null
          ? words.rateLimitedFor({ time: formatDuration(problem.retryAfter) })
          : words.rateLimited
      }

      return words.failed({ message: problem.reason ? `${problem.message} (${problem.reason})` : problem.message })
    case 'bad_answer':
      return words.failed({ message: 'bad_answer' })
    case 'transport':
      return words.failed({ message: problem.message })
  }
}

/** What a 403 `reauth_invalid` says (contract §8): the `reason`, and for `failed` the `failure`. */
function reauthInvalidText(reason: string, failure: string): string {
  const words = sheetStrings.passkeys.settings

  switch (reason) {
    case 'unknown':
      return words.selfExpired
    case 'spent':
      return words.selfSpent
    case 'not_fresh':
      return words.selfNotFresh
    case 'failed':
      switch (failure) {
        case 'auth_not_fresh':
          return words.selfAuthNotFresh
        case 'auth_time_missing':
          return words.selfAuthTimeMissing
        case 'user_mismatch':
          return words.selfUserMismatch
        case 'provider_mismatch':
          return words.selfProviderMismatch
        default:
          return words.selfFailed
      }
    default:
      return words.selfFailed
  }
}

export function Passkeys({ store = passkeysStore }: { store?: StoreApi<PasskeysState> }): ReactElement {
  useLocale()

  const runtime = usePasskeyRuntime()
  const status = useStore(store, state => state.status)
  const statusError = useStore(store, state => state.statusError)
  const credentials = useStore(store, state => state.credentials)
  const supported = useStore(store, state => state.supported)
  const rpId = useStore(store, state => state.rpId)
  const pinned = useStore(store, state => state.pinned)
  const unlisted = useStore(store, state => state.capability?.verdict.kind === 'base_url_not_listed')
  const selfEnrolSupported = useStore(store, state => state.selfEnrolSupported)
  const selfEnrolment = useStore(store, state => state.selfEnrolment)
  const words = sheetStrings.passkeys.settings
  const ids = useId()
  const codeId = `${ids}-code`
  const helpId = `${ids}-help`
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [invite, setInvite] = useState<PasskeyInvite | null>(null)
  const [forgetting, setForgetting] = useState(false)
  /** The last try at adding by signing in again ended with a sign-in that did not count: the button says "Sign in again". */
  const [signInFailed, setSignInFailed] = useState(false)

  // The list as it is now, every time the page is opened.
  useEffect(() => {
    void runtime?.refresh()
  }, [runtime])

  // The grant of a self-enrolment waiting to be finished runs out: the section goes when the gateway stops taking it.
  const resumeUntil = selfEnrolment?.expiresAt ?? null

  useEffect(() => {
    if (resumeUntil === null || !runtime) {
      return undefined
    }

    const timer = setTimeout(
      () => {
        if (runtime.expireSelfEnrolment()) {
          setMessage({ tone: 'danger', text: words.selfExpired })
          setSignInFailed(true)
        }
      },
      Math.max(0, resumeUntil * 1000 - Date.now()) + 50
    )

    return () => clearTimeout(timer)
  }, [resumeUntil, runtime, words.selfExpired])

  const accepted =
    status?.enabled === true && Array.isArray(status.rp?.web) && status.rp.web.includes(rpId) && !unlisted
  const canAct = supported && accepted && runtime !== null && busy === null
  const nowSeconds = Date.now() / 1000
  const coolingOff = (credential: { usable_from?: number }): boolean =>
    typeof credential.usable_from === 'number' && credential.usable_from > nowSeconds
  // A passkey still cooling off cannot sign a step-up: it does not make this browser able to invite or remove.
  const ownPasskey = credentials.some(credential => credential.rp_id === rpId && !coolingOff(credential))
  // Adding by signing in again: on offer when the gateway says so, this page can come back from the trip, and the RP is accepted.
  const selfAvailable = selfEnrolSupported && accepted && status?.self_enrol?.available === true
  const resuming = selfEnrolment !== null && selfEnrolSupported && accepted

  let state: string | null = null

  if (!supported) {
    state = words.notSupported
  } else if (statusError?.kind === 'not_offered') {
    state = words.notOffered
  } else if (statusError) {
    state = words.failed({ message: statusError.message })
  } else if (status && !status.enabled) {
    state = words.off({ reason: status.reason || 'disabled' })
  } else if (status && unlisted) {
    state = words.baseUrlNotListed({ host: rpId })
  } else if (status && !accepted) {
    state = words.rpNotAccepted({ host: rpId })
  } else if (status) {
    state = words.ready
  }

  async function run(kind: Busy, action: () => Promise<string>): Promise<void> {
    setBusy(kind)
    setMessage(null)

    try {
      setMessage({ tone: 'ok', text: await action() })
    } catch (error) {
      setMessage({ tone: 'danger', text: actionFailure(error, rpId) })
      setSignInFailed(kind === 'self' || kind === 'finish' ? isReauthFailure(error) : false)
    } finally {
      setBusy(null)
    }
  }

  const enrol = (event: FormEvent): void => {
    event.preventDefault()

    if (!runtime || !canAct) {
      return
    }

    void run('enrol', async () => {
      await runtime.enrol(code)
      setCode('')

      return words.enrolled
    })
  }

  const startSelf = (): void => {
    if (!runtime || !canAct) {
      return
    }

    setSignInFailed(false)
    // The window leaves for the sign-in page; what the live region says meanwhile is the only sign of life.
    void run('self', async () => {
      await runtime.startSelfEnrolment()

      return words.selfStarting
    })
  }

  const finishSelf = (): void => {
    if (!runtime || !canAct) {
      return
    }

    void run('finish', async () => {
      await runtime.finishSelfEnrolment()
      setSignInFailed(false)

      return words.enrolled
    })
  }

  const cancelSelf = (): void => {
    runtime?.cancelSelfEnrolment()
    setMessage({ tone: 'ok', text: words.selfCancelled })
  }

  const mintInvite = (): void => {
    if (!runtime || !canAct) {
      return
    }

    setInvite(null)
    void run('invite', async () => {
      const minted = await runtime.mintInvite()

      setInvite(minted)

      // The code is on the page, once; the live region only says it is there.
      return words.inviteReady
    })
  }

  const copyInvite = (): void => {
    if (!invite) {
      return
    }

    void writeClipboard(displayEnrolmentCode(invite.code)).then(copied =>
      setMessage({ tone: copied ? 'ok' : 'danger', text: copied ? words.codeCopied : words.codeNotCopied })
    )
  }

  const forgetPin = (): void => {
    setForgetting(false)
    runtime?.forgetPin()
    setMessage({ tone: 'ok', text: words.pinForgotten })
  }

  const revoke = (id: string): void => {
    if (!runtime || !canAct) {
      return
    }

    void run({ revoke: id }, async () => {
      await runtime.revoke(id)

      return words.removed
    })
  }

  return (
    <section className="hm-passkeys" aria-labelledby={`${ids}-title`}>
      <h2 className="hm-passkeys__title" id={`${ids}-title`}>
        {webStrings.passkeys.settings.title}
      </h2>
      <p className="hm-passkeys__text">{words.intro}</p>
      {state ? <p className="hm-passkeys__state">{state}</p> : null}

      <h3 className="hm-passkeys__heading">{words.listTitle}</h3>
      {credentials.length === 0 ? (
        <p className="hm-passkeys__text">{words.empty}</p>
      ) : (
        <ul className="hm-passkeys__list">
          {credentials.map(credential => (
            <li key={credential.id} className="hm-passkeys__item">
              <div className="hm-passkeys__item-text">
                <span className="hm-passkeys__name">{credential.name}</span>
                <span className="hm-passkeys__meta">
                  {words.forSite({ rp: credential.rp_id })}
                  {typeof credential.created_at === 'number'
                    ? ` · ${words.added({ date: formatDate(credential.created_at * 1000) })}`
                    : ''}
                </span>
                {coolingOff(credential) ? (
                  <span className="hm-passkeys__meta" data-cooling-off="">
                    {words.coolingOff({ time: formatDateTime((credential.usable_from ?? 0) * 1000) })}
                  </span>
                ) : null}
              </div>
              <Button
                variant="quiet"
                data-tone="danger"
                className="hm-passkeys__remove"
                aria-label={words.removeNamed({ name: credential.name })}
                disabled={!canAct || !ownPasskey}
                onClick={() => revoke(credential.id)}
              >
                {words.remove}
              </Button>
            </li>
          ))}
        </ul>
      )}

      {resuming ? (
        <div className="hm-passkeys__form" role="group" aria-label={words.selfFinishTitle}>
          <h3 className="hm-passkeys__heading">{words.selfFinishTitle}</h3>
          <p className="hm-passkeys__text">
            {words.selfFinishHelp({ time: formatDateTime(selfEnrolment.expiresAt * 1000) })}
          </p>
          <div className="hm-passkeys__actions">
            <Button disabled={!canAct} onClick={finishSelf}>
              {busy === 'finish' ? sheetStrings.passkeys.signing : words.selfFinish}
            </Button>
            <Button variant="quiet" disabled={busy !== null} onClick={cancelSelf}>
              {words.selfCancel}
            </Button>
          </div>
        </div>
      ) : selfAvailable ? (
        <div className="hm-passkeys__form">
          <h3 className="hm-passkeys__heading">{words.selfTitle}</h3>
          <p className="hm-passkeys__text">{words.selfHelp}</p>
          <Button disabled={!canAct} onClick={startSelf}>
            {busy === 'self' ? words.selfStarting : signInFailed ? words.selfRetry : words.selfStart}
          </Button>
        </div>
      ) : null}

      <form className="hm-passkeys__form" onSubmit={enrol}>
        <h3 className="hm-passkeys__heading">{words.enrolTitle}</h3>
        <p className="hm-passkeys__text" id={helpId}>
          {words.enrolHelp}
        </p>
        <label className="hm-passkeys__label" htmlFor={codeId}>
          {words.codeLabel}
        </label>
        <input
          id={codeId}
          className="hm-passkeys__field"
          value={code}
          onChange={event => setCode(event.target.value)}
          aria-describedby={helpId}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={!supported || !accepted}
        />
        <Button type="submit" disabled={!canAct || code.trim() === ''}>
          {busy === 'enrol' ? sheetStrings.passkeys.signing : words.enrol}
        </Button>
      </form>

      {status?.user_invites && ownPasskey ? (
        <div className="hm-passkeys__form">
          <h3 className="hm-passkeys__heading">{words.inviteTitle}</h3>
          <p className="hm-passkeys__text">{words.inviteHelp}</p>
          <Button variant="quiet" disabled={!canAct} onClick={mintInvite}>
            {busy === 'invite' ? sheetStrings.passkeys.signing : words.invite}
          </Button>
          {invite ? (
            <div className="hm-passkeys__code">
              <span className="hm-passkeys__meta">{words.inviteCodeLabel}</span>
              <code data-invite-code="">{displayEnrolmentCode(invite.code)}</code>
              <Button variant="quiet" onClick={copyInvite}>
                {words.copyCode}
              </Button>
              {invite.expiresAt !== null ? (
                <span className="hm-passkeys__meta">
                  {words.inviteExpires({ time: formatDateTime(invite.expiresAt * 1000) })}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {pinned && runtime ? (
        <div className="hm-passkeys__form">
          <h3 className="hm-passkeys__heading">{words.pinTitle}</h3>
          <p className="hm-passkeys__text">{words.pinHelp}</p>
          {forgetting ? (
            <div className="hm-passkeys__confirm" role="group" aria-label={words.pinForget}>
              <p className="hm-passkeys__text">{words.pinConfirmQuestion}</p>
              <Button variant="quiet" data-tone="danger" onClick={forgetPin}>
                {words.pinConfirm}
              </Button>
              <Button variant="quiet" onClick={() => setForgetting(false)}>
                {words.pinCancel}
              </Button>
            </div>
          ) : (
            <Button variant="quiet" data-tone="danger" onClick={() => setForgetting(true)}>
              {words.pinForget}
            </Button>
          )}
        </div>
      ) : null}

      <p className="hm-passkeys__message" role="status" data-tone={message?.tone}>
        {message?.text ?? ''}
      </p>
    </section>
  )
}
