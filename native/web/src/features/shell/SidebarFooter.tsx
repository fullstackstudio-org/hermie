/**
 * The foot of the sidebar: who is signed in, the way out, and which client this
 * is. Signing out is the entry module's business (stop the chats, stop the
 * client, end the gateway's session, clear this person's stored state, go to
 * the sign-in page); this only asks for it, once.
 */
import { type ReactElement, useState } from 'react'

import { strings } from '../../generated/strings'
import { buildLabel } from '../../build-info'
import { useLocale } from '../../i18n/use-locale'
import { webStrings } from '../../i18n/web-strings'
import { Icon } from '../../ui/icons'
import { Button } from '../../ui/primitives'

export interface SidebarFooterProps {
  /** Who is signed in: the display name, else the email, else the id; empty when the gateway named nobody. */
  user: string
  onSignOut: () => void
}

export function SidebarFooter({ user, onSignOut }: SidebarFooterProps): ReactElement {
  useLocale()

  const [leaving, setLeaving] = useState(false)

  return (
    <>
      <p className="hm-sidebar__who">
        {user ? strings.app.onboarding.signIn.signedInAs({ user }) : strings.app.onboarding.signIn.signedIn}
      </p>
      <Button
        variant="quiet"
        disabled={leaving}
        onClick={() => {
          setLeaving(true)
          onSignOut()
        }}
      >
        <Icon name="signOut" size={18} />
        {strings.app.onboarding.signIn.signOutOfSession}
      </Button>
      <p className="hm-sidebar__version">{webStrings.shell.version({ version: buildLabel })}</p>
    </>
  )
}
