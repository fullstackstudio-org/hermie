/**
 * Settings → About → Licences, as a route. The screen draws its own frame
 * (a virtualised list rather than the usual form column), so all this does is
 * hand it the stack's back control.
 */
import { LicencesScreen } from '../LicencesScreen'
import { useSettingsBack } from './SettingsPage'

export function LicencesPage() {
  const back = useSettingsBack('Licences')

  return <LicencesScreen {...(back ? { back } : {})} />
}
