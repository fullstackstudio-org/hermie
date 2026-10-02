import { View } from 'react-native'

import { GatewayAddressRow } from '../../../gateway/GatewayAddressRow'
import { RefreshNotice } from '../../../gateway/RefreshNotice'
import { strings } from '../../../i18n/strings'
import { InsetGroup, InsetValueRow } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { authModeOf, type OnboardingDraft } from '../draft'
import { StatusLine } from '../StatusLine'

export interface DoneStepProps {
  draft: OnboardingDraft
  error: string | null
}

export function DoneStep({ draft, error }: DoneStepProps) {
  const theme = useTheme()
  const authMode = authModeOf(draft.probe)

  return (
    <View style={{ gap: theme.space.md }}>
      <InsetGroup header={strings.onboarding.done.gateway}>
        <GatewayAddressRow baseUrl={draft.baseUrl} />
        <InsetValueRow
          label={strings.settings.provider}
          value={
            authMode === 'session_token'
              ? strings.settings.authModeToken
              : (draft.provider?.displayName ?? strings.settings.unknown)
          }
        />
        <InsetValueRow label={strings.settings.version} value={draft.probe?.version || strings.settings.unknown} />
        {draft.test?.userDisplayName ? (
          <InsetValueRow label={strings.settings.user} value={draft.test.userDisplayName} />
        ) : null}
      </InsetGroup>

      {/*
        Said here rather than only in Settings, because this is the last screen
        where the owner is still thinking about the sign-in they just did. The
        draft's own token set is what answers it — nothing has been written to
        the keychain yet at this point in the wizard.
      */}
      <RefreshNotice canRefresh={!draft.tokens || Boolean(draft.tokens.refreshToken)} testID="done-no-refresh" />

      {error ? (
        <StatusLine testID="done-error" tone="error">
          {error}
        </StatusLine>
      ) : null}
    </View>
  )
}
