/**
 * The step after a working connection: ask now, or hand over two commands.
 *
 * It exists here rather than only in Settings because of when a permission
 * dialog can be asked for. iOS offers it once — a refusal is final until
 * somebody goes into system settings — so the moment to ask is the one where
 * the reader has just finished connecting a gateway on purpose and knows what
 * the app is for. A dialog raised later, by opening a settings screen they came
 * to for something else, is a dialog people say no to.
 *
 * **It is always skippable.** Continue is enabled whatever happens here, and
 * says so. Notifications are the one feature that is worth nothing if it is
 * imposed, and the person setting the app up on a train is not the person with
 * a shell open on the gateway.
 *
 * **Two faces, decided by the advert the connection test already read.** With
 * the plugin installed there is a switch to move; without it there is nothing
 * the app can do at all, and the screen's whole job becomes getting the install
 * commands to the machine running `hermes serve`.
 *
 * **The PushSync built here has no ports.** It exists to ask for permission and
 * mint an address, which is all `enable()` touches; the registration itself
 * reaches the gateway later, when `ChatRuntime` builds the real one and the
 * settings bridge flushes the section. A tap on a notification cannot arrive
 * during a wizard that has not saved a gateway yet, so the three ports a tap
 * needs are stubs rather than a reason to build the chat layer early.
 */
import { useCallback, useMemo, useState } from 'react'
import { View } from 'react-native'

import { strings } from '../../../i18n/strings'
import { usePushStore } from '../../../store/push'
import { Button, Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { pushPlatform } from '../../push/platform'
import { PluginInstall } from '../../push/PluginInstall'
import { PushSync, type PushEnableOutcome } from '../../push/push-sync'
import { pushProjectId, pushVapidUrl } from '../../push/where'
import { pushRegistrationState, pushRetryable, pushStatusText } from '../../push/status'
import type { PushPermission } from '../../push/platform-contract'
import type { OnboardingDraft } from '../draft'
import { StatusLine } from '../StatusLine'

export interface NotificationsStepProps {
  draft: OnboardingDraft
}

const NO_PORTS = {
  showChat: async (): Promise<void> => undefined,
  showConversation: async (): Promise<void> => undefined,
  canonicalSessionIds: (): readonly string[] => [],
  openApprovals: async (): Promise<[]> => [],
  respondApproval: async (): Promise<void> => undefined,
  // There is no list to switch within and no chat to open: this object exists
  // so the step can ask the platform for permission, and for nothing else.
  switchToGateway: async (): Promise<boolean> => false
}

export function NotificationsStep({ draft }: NotificationsStepProps) {
  const theme = useTheme()
  const text = strings.onboarding.notifications
  const enabled = usePushStore(state => state.enabled)
  const address = usePushStore(state => state.address)
  const failure = usePushStore(state => state.addressFailure)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<PushEnableOutcome | null>(null)
  const [permission, setPermission] = useState<PushPermission>('undetermined')

  const push = useMemo(
    () =>
      new PushSync({
        platform: pushPlatform,
        projectId: pushProjectId(),
        vapidUrl: pushVapidUrl(),
        // The gateway this would register on does not have an id yet — it is
        // written down on the last step. The switch lives in memory until then.
        namespace: null,
        ports: NO_PORTS
      }),
    []
  )

  const onEnable = useCallback(() => {
    if (busy) {
      return
    }

    setBusy(true)

    const settle = (result: PushEnableOutcome | null): void => {
      setOutcome(result)
      setBusy(false)
      void push.permission().then(setPermission)
    }

    void push
      .enable()
      .then(settle)
      .catch(() => settle(null))
  }, [busy, push])

  if (!draft.test?.plugin) {
    return <PluginInstall testID="onboarding-plugin-install" />
  }

  const registration = pushRegistrationState({
    available: pushPlatform.available,
    enabled,
    permission,
    address,
    failure
  })

  return (
    <View style={{ gap: theme.space.lg }}>
      {/*
        The Registration row, the same one Settings shows and computed by the
        same pure function. "Notifications are on" with no address behind it is
        the exact state that shipped once and could not be seen from inside the
        app, and a wizard is the worst place to start telling that lie.
      */}
      {enabled || outcome ? (
        <StatusLine
          testID="onboarding-push-status"
          tone={registration.kind === 'registered' ? 'ok' : pushRetryable(registration) ? 'checking' : 'error'}
        >
          {/*
            The same sentence Settings shows, from the same table. A second
            mapping here is how one of the two ends up saying "asking the
            platform for an address…" about a request that failed a minute ago.
          */}
          {registration.kind === 'registered'
            ? text.enabled
            : registration.kind === 'denied' || outcome === 'denied'
              ? text.denied
              : pushStatusText(registration)}
        </StatusLine>
      ) : null}

      {registration.kind === 'registered' ? null : (
        <Button
          busy={busy}
          disabled={busy || !pushPlatform.available}
          onPress={onEnable}
          testID="onboarding-push-enable"
          title={busy ? text.enabling : text.enable}
          /*
            Secondary, like the sign-in step's own action. The card's Continue
            is the accented one, and two full-width blue buttons stacked read as
            two ways forward rather than as an offer and a gate.
          */
          variant="secondary"
        />
      )}

      <Text color="textMuted" testID="onboarding-push-skip" variant="meta">
        {text.skip}
      </Text>
    </View>
  )
}
