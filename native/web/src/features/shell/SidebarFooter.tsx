/**
 * The foot of the sidebar: who is signed in (and, when the gateway did not say,
 * that it did not: `IdentityNote`; on a gateway without sign-in, that there is
 * none), the way to Settings, the way out (there: forgetting the session token),
 * and which client this is. Signing out is the entry module's business (stop the chats, stop the
 * client, end the gateway's session, clear this person's stored state, go to
 * the sign-in page); this only asks for it, once.
 *
 * The person's own picture sits before their name when the gateway named who they are: the picture
 * the gateway holds (`picture_url`), else their initial. It is decoration: the name beside it says
 * who it is.
 */
import { type ReactElement, useState } from 'react'
import { useStore } from 'zustand'

import { strings } from '../../generated/strings'
import { buildLabel } from '../../build-info'
import { ownAuthorId, ownAuthorStore } from '../../core/chats/own-author'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { Icon } from '../../ui/icons'
import { Button } from '../../ui/primitives'
import { PersonAvatar } from '../chat/PersonAvatar'
import { IdentityNote } from '../notices/IdentityNote'
import { preloadSettingsHost } from '../settings/load'
import { formatRoute } from './router'

export interface SidebarFooterProps {
  /** Who is signed in: the display name, else the email, else the id; empty when the gateway named nobody. */
  user: string
  /** Where the gateway holds the reader's picture (`/api/auth/me`'s `picture_url`); empty when it holds none. */
  pictureUrl?: string
  /** Sign out; on a gateway without sign-in, forget the session token instead. */
  onSignOut: () => void
  /** False on a gateway without sign-in: nobody is named, and the way out forgets the token. */
  gated?: boolean
}

export function SidebarFooter({ user, pictureUrl = '', onSignOut, gated = true }: SidebarFooterProps): ReactElement {
  useLocale()

  const [leaving, setLeaving] = useState(false)
  const ownId = useStore(ownAuthorStore, ownAuthorId)

  return (
    <>
      <div className="hm-sidebar__person">
        {ownId && user ? <PersonAvatar id={ownId} name={user} path={pictureUrl} skip={!pictureUrl} /> : null}
        <p className="hm-sidebar__who">
          {!gated
            ? webStrings.tokenMode.noSignIn
            : user
              ? strings.app.onboarding.signIn.signedInAs({ user })
              : strings.app.onboarding.signIn.signedIn}
        </p>
      </div>
      {/* Without sign-in the line above already says nobody is named; the note would say it twice. */}
      {gated ? <IdentityNote /> : null}
      {/* The Settings chunk is asked for as soon as a pointer or the focus reaches the link. */}
      <a
        className="hm-sidebar__settings"
        href={formatRoute({ name: 'settings' })}
        onPointerEnter={preloadSettingsHost}
        onFocus={preloadSettingsHost}
      >
        <Icon name="settings" size={18} />
        {strings.app.settings.title}
      </a>
      <Button
        variant="quiet"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          onSignOut()
        }}
      >
        <Icon name="signOut" size={18} />
        {gated ? strings.app.onboarding.signIn.signOutOfSession : webStrings.tokenMode.forget}
      </Button>
      <p className="hm-sidebar__version">{webStrings.shell.version({ version: buildLabel })}</p>
    </>
  )
}
