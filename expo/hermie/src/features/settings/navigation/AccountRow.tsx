/**
 * Who this device is signed in as, at the top of the Settings list: a round
 * avatar, the person, and what they are signed in to underneath.
 *
 * ## The only way in
 *
 * It opens the Account category, and the category no longer keeps a row of its
 * own beside it — one destination, one row, on the phone's list and the
 * sidebar both. Two adjacent rows to the same place, with the bold and quiet
 * lines swapped between them, read as a bug rather than as two doors.
 *
 * ## Two lines, and which fact earns the bold one
 *
 * The bold line is the PERSON, because that is what a reader glances at first.
 * Only where there is no name at all does the row fall back, and the fallback
 * never repeats a fact between the two lines:
 *
 *  - name known → bold the name, quiet the host.
 *  - no name, a host known → bold the HOST, quiet the auth mode or provider
 *    ("Session token", the provider's own display name). Bolding the auth mode
 *    while the host sits under it says the same thing twice in the wrong
 *    order — a session token is not who signed in, a host is closer to it.
 *  - neither a name nor a host — a device that was never set up — keeps the
 *    plain signed-out wording, same as before.
 *
 * Read through `?.` for the reason `GatewayTitle` gives: Settings is rendered by
 * suites that stand in for the gateway context with the two or three fields they
 * care about, and a row at the top of the list is not worth a crash in any of
 * them.
 *
 * ## The picture (HERM-120)
 *
 * `config.userPictureUrl` is `/api/auth/me`'s own `picture_url`, captured at
 * sign-in alongside `userDisplayName`. `useOwnPictureUri` fetches and caches
 * the bytes behind it; while that is unresolved, or where the gateway never
 * sent one, `Avatar` draws the initial exactly as it always has — this row
 * never blocks on the picture to show a name.
 */
import { Pressable, View } from 'react-native'

import { Avatar } from '../../../chat-ui'
import { useGateway } from '../../../gateway'
import { describeGatewayAddress } from '../../../gateway/gateway-stop'
import { strings } from '../../../i18n/strings'
import { useOwnPictureUri } from '../../people/use-own-picture'
import { Icon, ICON_SIZE } from '../../../ui/Icon'
import { Text } from '../../../ui/primitives'
import { useTheme } from '../../../ui/theme'
import { AVATAR_SIZE, CONTROL_MIN_HEIGHT } from '../../../ui/tokens'

export interface AccountRowProps {
  onPress: () => void
}

export function AccountRow({ onPress }: AccountRowProps) {
  const theme = useTheme()
  const { config } = useGateway()
  const pictureUri = useOwnPictureUri(config?.userPictureUrl)
  const summary = strings.settings.categories.summary
  // The old single fallback: what the row said, in full, before there was a
  // host to prefer over it. Still exactly right for the one case that has
  // neither a name nor a host — a device that was never set up — which is why
  // it survives unchanged as that branch's bold line below.
  const providerOrTokenLabel =
    config?.authMode === 'session_token'
      ? strings.settings.authModeToken
      : config?.providerDisplayName || config?.provider || summary.signedOut
  // Empty rather than `describeGatewayAddress`'s own "Unknown" where there is no
  // address at all: a device that has never been set up has no gateway to name,
  // and "Unknown" under a name reads as a fault rather than as an absence.
  const host = config?.baseUrl ? describeGatewayAddress(config.baseUrl).host : ''

  let boldText: string
  let quietText: string

  if (config?.userDisplayName) {
    boldText = config.userDisplayName
    quietText = host || summary.signedOut
  } else if (host) {
    boldText = host
    quietText = providerOrTokenLabel
  } else {
    boldText = providerOrTokenLabel
    quietText = summary.signedOut
  }

  const size = AVATAR_SIZE.header

  return (
    <Pressable
      accessibilityLabel={boldText}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        borderRadius: theme.radii.card,
        cursor: 'pointer',
        marginHorizontal: theme.space.sm,
        opacity: pressed ? 0.7 : 1
      })}
      testID="settings-account-row"
    >
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.md,
          minHeight: CONTROL_MIN_HEIGHT,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.sm
        }}
      >
        {config?.userDisplayName ? (
          <Avatar name={config.userDisplayName} size={size} {...(pictureUri ? { uri: pictureUri } : {})} />
        ) : (
          <View
            style={{
              alignItems: 'center',
              backgroundColor: theme.tintSunk,
              borderColor: theme.hairline,
              borderRadius: size / 2,
              borderWidth: 1,
              height: size,
              justifyContent: 'center',
              width: size
            }}
          >
            <Icon color={theme.colors.textMuted} name="person" size={ICON_SIZE.control} slot={size} />
          </View>
        )}

        <View style={{ flex: 1, gap: theme.space.xxs, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontWeight: '600' }} testID="settings-account-name" variant="body">
            {boldText}
          </Text>
          <Text color="textMuted" numberOfLines={1} variant="meta">
            {quietText}
          </Text>
        </View>

        <Icon color={theme.colors.textMuted} name="chevronRight" size={ICON_SIZE.inline} />
      </View>
    </Pressable>
  )
}
