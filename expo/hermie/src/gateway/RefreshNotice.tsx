import { Linking, Pressable, View } from 'react-native'

import { strings } from '../i18n/strings'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'

/**
 * Where the scope is explained. The runbook is the only place that says which
 * `hermes config set` line to change, which is the entire fix.
 */
export const REFRESH_DOCS_URL =
  'https://github.com/fullstackstudio-org/hermie/blob/main/docs/test-gateway.md#refresh-tokens-and-offline_access'

export interface RefreshNoticeProps {
  /** Nothing is said unless this is explicitly false. */
  canRefresh: boolean
  testID?: string
}

/**
 * One line about a sign-in that cannot be renewed.
 *
 * It is not an error and it does not block anything: the sign-in worked and the
 * session is live. What it has is an expiry nobody was told about — when the
 * access token runs out there is no refresh token to rotate it with, and Hermie
 * drops to the sign-in screen with no explanation that points anywhere useful.
 *
 * The cause is entirely upstream of this app: the gateway's OIDC client was
 * registered without `offline_access`, so the provider never issues one. So the
 * sentence names the scope and links to the line that sets it, rather than
 * apologising for something the app could have done differently.
 */
export function RefreshNotice({ canRefresh, testID }: RefreshNoticeProps) {
  const theme = useTheme()

  if (canRefresh) {
    return null
  }

  return (
    <View style={{ gap: theme.space.xs }}>
      <Text color="warnText" testID={testID} variant="meta">
        {strings.auth.noRefreshToken}
      </Text>

      <Pressable
        accessibilityRole="link"
        hitSlop={8}
        onPress={() => void Linking.openURL(REFRESH_DOCS_URL).catch(() => undefined)}
        testID={testID ? `${testID}-link` : undefined}
      >
        <Text color="accentText" variant="meta">
          {strings.auth.noRefreshTokenLink}
        </Text>
      </Pressable>
    </View>
  )
}
