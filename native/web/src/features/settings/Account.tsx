/**
 * Settings, Account: who the gateway says is signed in in this browser, and the way out.
 *
 * What is shown is `/api/auth/me` as the boot read it, in the gateway's words, cleaned to one line
 * (`displayText`): a name or an address a person chose is data, never markup. Sign out asks first,
 * with the choice that leaves nothing behind named in the question and Cancel holding the focus, and
 * then hands over to the entry module's sign-out, which stops the chats and the socket, ends the
 * gateway's session, clears this person's stored state and goes to the gateway's own page.
 *
 * On a gateway without sign-in (`gated: false`, session-token mode) nobody is signed in, and the page
 * says so: there is no identity to show, the token came from the gateway's own dashboard and is as open
 * as that dashboard, and the way out is forgetting the token (the same local clearing, no gateway call).
 */
import { type ReactElement, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { ownAuthorId, ownAuthorStore } from '../../core/chats/own-author'
import { displayText, NAME_LIMIT } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { Icon } from '../../ui/icons'
import { Button } from '../../ui/primitives'
import { PersonAvatar } from '../chat/PersonAvatar'
import { IdentityNote } from '../notices/IdentityNote'
import { Fact, SettingsPage } from './controls'
import { type SettingsRuntime, useSettingsRuntime } from './settings-runtime'

/** An address or an id the gateway gave runs longer than a name. */
const VALUE_LIMIT = 128

const hostOf = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export function Account(): ReactElement {
  useLocale()

  const runtime = useSettingsRuntime()
  const ownId = useStore(ownAuthorStore, ownAuthorId)
  const [confirming, setConfirming] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const signOutButton = useRef<HTMLButtonElement>(null)
  const words = sheetStrings.settings.account
  const title = strings.app.settings.categories.account

  if (!runtime) {
    return (
      <SettingsPage title={title}>
        <p className="hm-settings-page__lead">{words.noGateway}</p>
      </SettingsPage>
    )
  }

  const gated = runtime.gated
  const leaveLabel = gated ? strings.app.settings.signOut : webStrings.tokenMode.forget
  const name = displayText(runtime.user, NAME_LIMIT)
  const email = displayText(runtime.identity.email, VALUE_LIMIT)
  const userId = displayText(runtime.identity.userId, VALUE_LIMIT)
  const provider = displayText(runtime.identity.provider, NAME_LIMIT)

  return (
    <SettingsPage title={title}>
      {gated ? null : <p className="hm-settings-page__lead">{words.tokenMode}</p>}

      <dl className="hm-facts">
        {gated ? (
          <AccountFacts runtime={runtime} ownId={ownId} name={name} email={email} userId={userId} provider={provider} />
        ) : null}
        <Fact label={strings.app.settings.host}>{hostOf(runtime.gatewayBaseUrl)}</Fact>
      </dl>

      {gated ? <IdentityNote /> : null}

      {confirming ? (
        <div className="hm-settings-page__confirm" role="group" aria-label={leaveLabel}>
          <p className="hm-settings-page__text">{gated ? words.signOutQuestion : words.forgetQuestion}</p>
          <div className="hm-settings-page__actions">
            <Button
              variant="quiet"
              data-tone="danger"
              disabled={leaving}
              onClick={() => {
                setLeaving(true)
                runtime.signOut()
              }}
            >
              <Icon name="signOut" size={18} />
              {leaveLabel}
            </Button>
            {/* Cancel takes the focus: signing out is never one stray Enter away. */}
            <Button
              variant="quiet"
              autoFocus
              disabled={leaving}
              onClick={() => {
                setConfirming(false)
                // The button that asked is drawn again by the next render; the focus goes back to it.
                queueMicrotask(() => signOutButton.current?.focus())
              }}
            >
              {strings.app.common.cancel}
            </Button>
          </div>
          {leaving && gated ? (
            <p className="hm-settings-page__text" role="status">
              {words.signingOut}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="hm-settings-page__actions">
          <Button variant="quiet" data-tone="danger" ref={signOutButton} onClick={() => setConfirming(true)}>
            <Icon name="signOut" size={18} />
            {leaveLabel}
          </Button>
        </div>
      )}

      <p className="hm-set__hint">{gated ? words.signOutHint : words.forgetHint}</p>
    </SettingsPage>
  )
}

/** Who the gateway named: a gated gateway's person, with their picture when it holds one. */
function AccountFacts({
  runtime,
  ownId,
  name,
  email,
  userId,
  provider
}: {
  runtime: SettingsRuntime
  ownId: string | undefined
  name: string
  email: string
  userId: string
  provider: string
}): ReactElement {
  const words = sheetStrings.settings.account

  return (
    <>
      <Fact label={strings.app.settings.user}>
        <span className="hm-fact__person">
          {ownId && name ? (
            <PersonAvatar id={ownId} name={name} path={runtime.pictureUrl} skip={!runtime.pictureUrl} />
          ) : null}
          <span>{name || strings.app.onboarding.signIn.signedIn}</span>
        </span>
      </Fact>
      {email && email !== name ? <Fact label={strings.app.settings.email}>{email}</Fact> : null}
      {userId && userId !== name ? <Fact label={words.userId}>{userId}</Fact> : null}
      {provider && provider !== 'none' ? <Fact label={strings.app.settings.provider}>{provider}</Fact> : null}
    </>
  )
}
