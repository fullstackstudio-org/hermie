import { classifyHost, type HostPrivacy } from '@hermie/gateway-client'
import { Pressable, View } from 'react-native'

import { strings } from '../i18n/strings'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'

export interface TransportNoticeProps {
  /** The resolved address, scheme included. Anything but `http://` says nothing. */
  baseUrl: string | null | undefined
  /**
   * Offered where the address can still be changed. Omitted in Settings, where
   * changing it means going through setup again.
   */
  onUseHttps?: () => void
  testID?: string
}

/** Which sentence a host's privacy class earns. */
/*
 * Built on CALL rather than at import.
 *
 * A module-level literal would freeze whatever language was active when the
 * bundle loaded, which on a cold start is always English — see
 * `i18n/catalogue.ts`. The list is three entries and it is rebuilt per render;
 * the alternative is a screen that keeps its old language until it is remounted.
 */
const sentence = (): Record<HostPrivacy, string> => ({
  loopback: strings.transport.httpLoopback,
  private: strings.transport.httpLocalNetwork,
  link_local: strings.transport.httpLocalNetwork,
  local_name: strings.transport.httpLocalNetwork,
  cgnat: strings.transport.httpTailnet,
  tailnet: strings.transport.httpTailnet,
  public: strings.transport.httpExposed
})

/**
 * One line about a cleartext gateway — never a block.
 *
 * Plain `http://` is the ordinary, correct setup for a gateway on a tailnet or
 * on the same machine, and telling that user they have done something wrong is
 * how a warning gets trained out of people. The host decides the tone: a
 * private address gets a statement of fact, and a public one gets the warning
 * it deserves, with the way out next to it.
 */
export function TransportNotice({ baseUrl, onUseHttps, testID }: TransportNoticeProps) {
  const theme = useTheme()

  if (!baseUrl || !baseUrl.trim().toLowerCase().startsWith('http://')) {
    return null
  }

  const { privacy, isPrivate } = classifyHost(baseUrl)

  return (
    <View style={{ gap: theme.space.xs }}>
      <Text variant="meta" color={isPrivate ? 'textMuted' : 'warnText'} testID={testID}>
        {sentence()[privacy]}
      </Text>
      {!isPrivate && onUseHttps ? (
        <Pressable accessibilityRole="button" onPress={onUseHttps} hitSlop={8}>
          <Text variant="meta" color="accentText">
            {strings.transport.useHttps}
          </Text>
        </Pressable>
      ) : null}
    </View>
  )
}
