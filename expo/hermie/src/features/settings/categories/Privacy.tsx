/**
 * Settings → Privacy & security: the app lock. Per device, and never carried to
 * another one by ADR-0016's sync.
 *
 * HERM-106 turns the row `PrivacySection` draws into a `DisclosureRow` that
 * pushes the `LockThreshold` picker, which is why this is a page of its own
 * already.
 */
import { useNavigation, type NavigationProp } from '@react-navigation/native'

import { strings } from '../../../i18n/strings'
import { biometrics } from '../../../platform/biometrics'
import { useLockStore } from '../../lock'
import type { SettingsParamList } from '../navigation/route-names'
import { SettingsPage } from '../navigation/SettingsPage'
import { PrivacySection } from '../PrivacySection'

export function useSummary(): string {
  const threshold = useLockStore(state => state.machine.threshold)

  return biometrics.available
    ? strings.settings.lock.options[threshold]
    : strings.settings.categories.summary.lockBrowser
}

export function Page() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()

  return (
    <SettingsPage route="Privacy">
      <PrivacySection onOpenLockThreshold={() => navigation.navigate('LockThreshold')} />
    </SettingsPage>
  )
}
