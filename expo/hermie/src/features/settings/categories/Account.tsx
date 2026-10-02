/**
 * Settings → Account: who this device is signed in as, and the three ways of
 * leaving — sign out, change gateway, forget it.
 *
 * HERM-120 adds the picture and the email, both straight off `config` — the
 * same snapshot of `/api/auth/me` the "Signed in as" row already reads, taken
 * once at sign-in (`configFromDraft`). Neither is a second fetch: the picture
 * is `useOwnPictureUri` fetching and caching the bytes behind
 * `config.userPictureUrl`, and the email is `config.userEmail` shown as-is, or
 * not shown at all where the gateway sent none.
 */
import { useState } from 'react'
import { View } from 'react-native'

import { Avatar } from '../../../chat-ui'
import { useGateway } from '../../../gateway'
import { WEB_GATEWAY_BASE_URL } from '../../../gateway/web-config'
import { strings } from '../../../i18n/strings'
import { useOwnPictureUri } from '../../people/use-own-picture'
import { InsetButtonRow, InsetGroup, InsetValueRow } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { AVATAR_SIZE } from '../../../ui/tokens'
import { SettingsPage } from '../navigation/SettingsPage'

export function useSummary(): string {
  const { config } = useGateway()

  return (
    config?.userDisplayName ||
    (config?.authMode === 'session_token'
      ? strings.settings.authModeToken
      : (config?.providerDisplayName ?? config?.provider ?? strings.settings.categories.summary.signedOut))
  )
}

export function Page() {
  const theme = useTheme()
  const { config, signOut, changeGateway, forgetGateway } = useGateway()
  const pictureUri = useOwnPictureUri(config?.userPictureUrl)
  const [confirmingForget, setConfirmingForget] = useState(false)

  return (
    <SettingsPage route="Account">
      {config?.userDisplayName ? (
        <InsetGroup>
          <View
            style={{
              alignItems: 'center',
              flexDirection: 'row',
              gap: theme.space.md,
              paddingHorizontal: theme.space.lg,
              paddingVertical: theme.space.sm
            }}
          >
            <Avatar
              name={config.userDisplayName}
              size={AVATAR_SIZE.list}
              testID="settings-account-avatar"
              {...(pictureUri ? { uri: pictureUri } : {})}
            />
          </View>
          <InsetValueRow label={strings.settings.user} value={config.userDisplayName} />
          {/*
            Empty is the honest answer for a provider that never sent an email,
            or sent one unverified (`GatewayHttp.authMe` reads `email: ""`
            exactly the same as absent) — and a blank value row would read as a
            fault rather than as nothing to show.
          */}
          {config.userEmail ? <InsetValueRow label={strings.settings.email} value={config.userEmail} /> : null}
        </InsetGroup>
      ) : null}

      <InsetGroup>
        <InsetButtonRow
          detail={strings.settings.signOutHint}
          onPress={() => void signOut()}
          testID="settings-sign-out"
          title={strings.settings.signOut}
        />
        {/*
          Two rows where there was one, because they were one thing with two
          meanings. Changing gateway is the ordinary, reversible act — setup
          reopens on the address step with this address in it and nothing is
          dropped until a different one is saved — and forgetting is the
          destructive one that still asks.

          In a browser neither applies: Hermie Web fixes the gateway, and the
          wizard there has no address step to open.
        */}
        {WEB_GATEWAY_BASE_URL ? null : (
          <InsetButtonRow
            detail={strings.settings.changeGatewayHint}
            onPress={() => void changeGateway()}
            testID="settings-change-gateway"
            title={strings.settings.changeGateway}
          />
        )}
        {confirmingForget ? (
          <InsetButtonRow
            detail={strings.settings.changeGatewayConfirm}
            onPress={() => void forgetGateway()}
            testID="settings-forget-confirm"
            title={strings.settings.confirm}
            tone="danger"
          />
        ) : null}
        {confirmingForget ? (
          <InsetButtonRow onPress={() => setConfirmingForget(false)} title={strings.settings.keepIt} tone="text" />
        ) : (
          <InsetButtonRow
            detail={strings.settings.forgetGatewayHint}
            onPress={() => setConfirmingForget(true)}
            testID="settings-forget-gateway"
            title={strings.settings.forgetGateway}
            tone="danger"
          />
        )}
      </InsetGroup>
    </SettingsPage>
  )
}
