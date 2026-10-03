/**
 * The passkeys of the signed-in person on this gateway (`#/settings/passkeys`):
 * whether the level is on here and why not, the list, adding a passkey of this
 * browser with a one-time code, making a code for another device, and removing
 * a passkey. The native apps' Passkeys page (plan CP-10), kept to what a browser
 * needs; the rest of Settings is W-20b's.
 *
 * Every action goes through the passkey model (`PasskeyRuntimeContext`); the list
 * and the state are read from `state/passkeys.ts`. An invite or a removal is a
 * step-up: the browser asks for a passkey of this site first (plan P6, P7), so a
 * session alone can neither add nor remove one.
 *
 * A code is shown once, as the gateway gave it, in the page (with a Copy button) and never in a live
 * region: the status line says it is ready, not what it is. It is never written anywhere.
 */
import { type FormEvent, type ReactElement, useEffect, useId, useState } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { displayEnrolmentCode } from '../../core/passkey/challenge'
import type { PasskeyActionError, PasskeyInvite } from '../../core/passkey/model'
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

type Busy = null | 'enrol' | 'invite' | { revoke: string }

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
  const words = sheetStrings.passkeys.settings
  const ids = useId()
  const codeId = `${ids}-code`
  const helpId = `${ids}-help`
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [message, setMessage] = useState<Message | null>(null)
  const [invite, setInvite] = useState<PasskeyInvite | null>(null)
  const [forgetting, setForgetting] = useState(false)

  // The list as it is now, every time the page is opened.
  useEffect(() => {
    void runtime?.refresh()
  }, [runtime])

  const accepted =
    status?.enabled === true && Array.isArray(status.rp?.web) && status.rp.web.includes(rpId) && !unlisted
  const canAct = supported && accepted && runtime !== null && busy === null
  const ownPasskey = credentials.some(credential => credential.rp_id === rpId)

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
