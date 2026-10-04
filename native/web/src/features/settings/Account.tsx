/**
 * Settings, Account: who the gateway says is signed in in this browser, and the way out.
 *
 * What is shown is `/api/auth/me` as the boot read it, in the gateway's words, cleaned to one line
 * (`displayText`): a name or an address a person chose is data, never markup. Sign out asks first,
 * with the choice that leaves nothing behind named in the question and Cancel holding the focus, and
 * then hands over to the entry module's sign-out, which stops the chats and the socket, ends the
 * gateway's session, clears this person's stored state and goes to the gateway's own page.
 */
import { type ReactElement, useRef, useState } from 'react'
import { useStore } from 'zustand'

import { ownAuthorId, ownAuthorStore } from '../../core/chats/own-author'
import { displayText, NAME_LIMIT } from '../../core/requests/secure-input'
import { strings } from '../../generated/strings'
import { sheetStrings } from '../../i18n/sheet-strings'
import { useLocale } from '../../i18n/use-locale'
import { Icon } from '../../ui/icons'
import { Button } from '../../ui/primitives'
import { PersonAvatar } from '../chat/PersonAvatar'
import { IdentityNote } from '../notices/IdentityNote'
import { Fact, SettingsPage } from './controls'
import { useSettingsRuntime } from './settings-runtime'

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

  const name = displayText(runtime.user, NAME_LIMIT)
  const email = displayText(runtime.identity.email, VALUE_LIMIT)
  const userId = displayText(runtime.identity.userId, VALUE_LIMIT)
  const provider = displayText(runtime.identity.provider, NAME_LIMIT)

  return (
    <SettingsPage title={title}>
      <dl className="hm-facts">
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
        <Fact label={strings.app.settings.host}>{hostOf(runtime.gatewayBaseUrl)}</Fact>
      </dl>

      <IdentityNote />

      {confirming ? (
        <div className="hm-settings-page__confirm" role="group" aria-label={strings.app.settings.signOut}>
          <p className="hm-settings-page__text">{words.signOutQuestion}</p>
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
              {strings.app.settings.signOut}
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
          {leaving ? (
            <p className="hm-settings-page__text" role="status">
              {words.signingOut}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="hm-settings-page__actions">
          <Button variant="quiet" data-tone="danger" ref={signOutButton} onClick={() => setConfirming(true)}>
            <Icon name="signOut" size={18} />
            {strings.app.settings.signOut}
          </Button>
        </div>
      )}

      <p className="hm-set__hint">{words.signOutHint}</p>
    </SettingsPage>
  )
}
