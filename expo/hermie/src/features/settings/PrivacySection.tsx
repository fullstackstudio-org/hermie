/**
 * Privacy & security: today, the app lock and nothing else.
 *
 * The section exists as its own group rather than as a row under Appearance
 * because of what the next thing in it will be. A lock, what a notification
 * says on a locked screen, what a bot is told about the device — these are the
 * questions a reader comes to a settings screen looking for a single place to
 * answer, and a lock filed under "Chat" is a lock nobody finds.
 *
 * The control is a `DisclosureRow` to the `LockThreshold` picker (HERM-106,
 * owner: "Face id/touch id moet een select worden") rather than the five-
 * segment control it used to be — a segmented track has no room for five
 * readable labels on a phone, and picking a value there asked for nothing at
 * all. Authentication and the reasons a pick did not take now live on that
 * page, next to the list it is actually choosing from.
 */
import { strings } from '../../i18n/strings'
import { biometrics } from '../../platform/biometrics'
import { InsetGroup, InsetRow, Text } from '../../ui/primitives'
import { DisclosureRow } from '../../ui/sheets'
import { useLockStore } from '../lock'

export interface PrivacySectionProps {
  onOpenLockThreshold: () => void
}

export function PrivacySection({ onOpenLockThreshold }: PrivacySectionProps) {
  const threshold = useLockStore(state => state.machine.threshold)

  /*
    The browser says so and offers nothing.

    A plate drawn over this app's own DOM is not a lock: the page and the thing
    that would enforce it are the same JavaScript, and a tab is closed by the
    operating system rather than by us. Offering a row that cannot do what its
    name says is worse than the note. See `platform/biometrics.web.ts`.
  */
  if (!biometrics.available) {
    return (
      <InsetGroup header={strings.settings.privacy}>
        <InsetRow>
          <Text color="textMuted" variant="meta">
            {strings.settings.lock.web}
          </Text>
        </InsetRow>
      </InsetGroup>
    )
  }

  return (
    <InsetGroup header={strings.settings.privacy}>
      <DisclosureRow
        label={strings.settings.lock.label}
        onPress={onOpenLockThreshold}
        testID="settings-app-lock"
        value={strings.settings.lock.options[threshold]}
      />
    </InsetGroup>
  )
}
