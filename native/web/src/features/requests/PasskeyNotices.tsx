/**
 * What the passkey model wants the person to see that is not one confirmation:
 * a gateway that presents another id than the one pinned, a passkey added or
 * removed without this browser, a request this build refused. Never a silent
 * failure (plan P7, contract §10).
 *
 * Over the page and over a dialog alike (the request layer keeps it out of the
 * inert page, `data-modal-keep`), each with a Close button; an alert, because a
 * passkey added by somebody else is exactly what must not wait for a glance.
 */
import type { ReactElement } from 'react'
import { useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'

import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { type PasskeyNoticeKind, type PasskeysState, passkeysStore } from '../../state/passkeys'
import { Button } from '../../ui/primitives'
import { usePasskeyRuntime } from './passkey-runtime'

export function noticeText(notice: PasskeyNoticeKind): string {
  const words = webStrings.passkeys.notice

  switch (notice.kind) {
    case 'gateway_id_mismatch':
      return words.gatewayIdMismatch
    case 'gateway_id_conflict':
      return words.gatewayIdConflict
    case 'unsupported_version':
      return words.unsupportedVersion
    case 'no_credential':
      return words.noCredential
    case 'malformed_request':
      return words.malformedRequest
    case 'base_url_not_listed':
      return words.baseUrlNotListed
    case 'credential_added':
      return words.credentialAdded({ name: notice.name })
    case 'credential_revoked':
      return words.credentialRevoked({ name: notice.name })
  }
}

export function PasskeyNotices({ store = passkeysStore }: { store?: StoreApi<PasskeysState> }): ReactElement | null {
  useLocale()

  const notices = useStore(store, state => state.notices)
  const runtime = usePasskeyRuntime()

  if (notices.length === 0) {
    return null
  }

  return (
    <ul className="hm-requests__notices" data-modal-keep="">
      {notices.map(notice => (
        <li key={notice.id} className="hm-requests__notice" role="alert">
          <p>{noticeText(notice.notice)}</p>
          <Button variant="quiet" onClick={() => runtime?.dismissNotice(notice.id)}>
            {webStrings.passkeys.close}
          </Button>
        </li>
      ))}
    </ul>
  )
}
