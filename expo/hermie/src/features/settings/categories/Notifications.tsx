/**
 * Settings → Notifications: `NotificationsSection`, as it was, on a page of its own.
 *
 * ADR-0017, and off until the reader says otherwise: nothing here asks for
 * permission or mints a token on mount.
 */
import { strings } from '../../../i18n/strings'
import { usePushStore } from '../../../store/push'
import { useChatRuntime } from '../../chats/ChatRuntime'
import { NotificationsSection } from '../../push/NotificationsSection'
import { pushPlatform } from '../../push/platform'
import { SettingsPage } from '../navigation/SettingsPage'

export function useSummary(): string {
  const enabled = usePushStore(state => state.enabled)
  const kinds = usePushStore(state => Object.values(state.types).filter(Boolean).length)
  const summary = strings.settings.categories.summary

  return enabled ? summary.notificationKinds(kinds) : summary.off
}

export function Page() {
  const runtime = useChatRuntime()

  return (
    <SettingsPage route="Notifications">
      <NotificationsSection available={pushPlatform.available} push={runtime?.push ?? null} />
    </SettingsPage>
  )
}
