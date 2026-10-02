/**
 * Settings → Privacy & security → Require unlock, as a pushed picker rather
 * than the five-segment control it used to be (HERM-106; the owner's own
 * words: "Face id/touch id moet een select worden" — a row like the model
 * picker, not a row of segments).
 *
 * The one rule that makes this page more than a paint job: EVERY pick — Off
 * included — authenticates before it takes. `useLockStore.changeThreshold`
 * does the asking; this page only decides what to show while that promise is
 * out and afterwards. Picking the value already in force is not a change and
 * costs no prompt at all — it just goes back, the way dismissing an already-
 * correct choice does everywhere else in Settings.
 */
import { useNavigation, type NavigationProp } from '@react-navigation/native'
import { useEffect, useState } from 'react'

import type { PickerOption } from '../../../chat-ui/types'
import { strings } from '../../../i18n/strings'
import type { BiometricEnrolment } from '../../../platform/platform-contracts'
import { PickerList } from '../../../ui/sheets'
import { LOCK_THRESHOLDS, type LockThreshold, useLockStore } from '../../lock'
import type { SettingsParamList } from './route-names'
import { SettingsPage } from './SettingsPage'

const OPTIONS: PickerOption[] = LOCK_THRESHOLDS.map(value => ({
  value,
  label: strings.settings.lock.options[value]
}))

/** Why a pick did not take. `null` outside of a refusal. */
type Refusal = 'none' | 'unavailable' | 'refused'

/** Why the row still shows the old value, or — absent a refusal — what the current one means. */
function footerFor(refusal: Refusal | null, enrolment: BiometricEnrolment | null, threshold: LockThreshold): string {
  switch (refusal) {
    case 'none':
      return strings.settings.lock.noEnrolment
    case 'unavailable':
      return strings.settings.lock.unavailable
    case 'refused':
      return strings.settings.lock.refused
    default:
      if (enrolment === 'passcode') {
        return strings.settings.lock.passcodeOnly
      }

      return threshold === 'off' ? strings.settings.lock.hint : strings.settings.lock.hintOn
  }
}

export function LockThresholdPage() {
  const navigation = useNavigation<NavigationProp<SettingsParamList>>()
  const threshold = useLockStore(state => state.machine.threshold)
  const enrolment = useLockStore(state => state.enrolment)
  const checkEnrolment = useLockStore(state => state.checkEnrolment)
  const changeThreshold = useLockStore(state => state.changeThreshold)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [pending, setPending] = useState(false)

  // Asked here rather than at launch, same reason `PrivacySection` used to ask
  // it: a native round trip nobody needs until this page is open, and an
  // answer that can change between launches (a passcode is a thing people add
  // and remove).
  useEffect(() => {
    void checkEnrolment()
  }, [checkEnrolment])

  const handlePick = (option: PickerOption) => {
    const next = option.value as LockThreshold

    // The value already in force is not a change, and does not cost a prompt:
    // this is the same "picking the current choice just closes the picker"
    // rule the model and reasoning panes already follow.
    if (next === threshold || pending) {
      navigation.goBack()

      return
    }

    setRefusal(null)
    setPending(true)

    void changeThreshold(next).then(accepted => {
      setPending(false)

      if (accepted) {
        navigation.goBack()

        return
      }

      const current = useLockStore.getState().enrolment

      // Two different refusals read very differently: one is fixable in this
      // device's settings and says so, the other is "that wasn't you" and
      // invites another try. `changeThreshold` only ever checks enrolment for
      // a non-off target, so a refusal on `off` is always the second kind.
      setRefusal(next !== 'off' && (current === 'none' || current === 'unavailable') ? current : 'refused')
    })
  }

  return (
    <SettingsPage route="LockThreshold">
      <PickerList
        footer={footerFor(refusal, enrolment, threshold)}
        onPick={handlePick}
        options={OPTIONS}
        value={threshold}
      />
    </SettingsPage>
  )
}
