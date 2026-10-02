/**
 * The connection, in one line, on every layout.
 *
 * There used to be two of these: a permanent gateway card at the foot of the
 * wide sidebar, and this line on the phone. They said overlapping things in
 * different words, and the card spent a row of the sidebar on "Connected" —
 * which is the state it is in every second of every day, so nobody read it. The
 * card is gone; this is the only place the global connection speaks.
 *
 * Three rules it keeps:
 *
 *  - **Connected is silent.** The presence bead on every row already says a bot
 *    can be reached. A line that only ever says "yes" is a line that is never
 *    looked at, and it costs the list a row.
 *  - **It is static.** The bead is the hollow offline ring in every state it
 *    draws, and signed-out is carried by the word and by amber text. The pulse
 *    belongs to a bot's "needs input" presence and to nothing else, because that
 *    one is a request aimed at the reader.
 *  - **Signed out is the one state you can act on**, so here it is a button. It
 *    does not replace the `SignedOutPanel` — that still takes the content column
 *    and explains itself — but the sidebar stays usable while the panel is up,
 *    and the reader is looking at the sidebar.
 */
import type { ConnectionStatus } from '@hermie/gateway-client'
import { Pressable, View } from 'react-native'

import { useGateway } from '../../gateway'
import { useReauth } from '../../gateway/reauth'
import { strings } from '../../i18n/strings'
import { PresenceBead } from '../../ui/PresenceBead'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { BEAD_SIZE } from '../../ui/tokens'

export interface ConnectionLineProps {
  /**
   * Show this state instead of the live one.
   *
   * Development only: the four states that are not `ready` are each a network
   * condition, and a gallery that could not name one would leave the line as the
   * only surface in the app nobody has seen in more than one state. A real
   * sidebar never passes it.
   */
  status?: ConnectionStatus
}

export function ConnectionLine({ status: forced }: ConnectionLineProps = {}) {
  const theme = useTheme()
  const gateway = useGateway()
  const status = forced ?? gateway.status
  const reauth = useReauth()

  if (status === 'ready') {
    return null
  }

  const signedOut = status === 'needs_signin'
  const label = signedOut
    ? strings.signedOut.title
    : (strings.connection.status[status as keyof typeof strings.connection.status] ?? status)

  const body = (
    // A SUNK tint, not a raised chip. The first build of this used the glass
    // chip recipe, and on the light theme that is a near-white pill on a
    // near-white panel: the words floated with no shape around them. The mockup
    // draws it sunk with a hairline, which is the one treatment that reads on
    // both themes, and it keeps the line at level 3 rather than opening a fourth
    // surface inside the panel.
    <View
      style={{
        alignItems: 'center',
        backgroundColor: theme.tintSunk,
        borderColor: theme.hairlineSoft,
        borderRadius: theme.radii.pill,
        borderWidth: 1,
        flexDirection: 'row',
        gap: theme.space.sm,
        paddingHorizontal: theme.space.md,
        paddingVertical: 6
      }}
    >
      <PresenceBead size={BEAD_SIZE.inline} state="offline" />
      <Text color={signedOut ? 'warnText' : 'textMuted'} testID="connection-state" variant="meta">
        {label}
      </Text>
    </View>
  )

  return (
    <View
      style={{
        marginBottom: theme.space.md,
        marginHorizontal: theme.space.lg
      }}
      testID="connection-line"
    >
      {signedOut ? (
        <Pressable
          accessibilityHint={strings.signedOut.signIn}
          accessibilityLabel={label}
          accessibilityRole="button"
          onPress={reauth.signIn}
          testID="connection-sign-in"
        >
          {body}
        </Pressable>
      ) : (
        body
      )}

      {/* Rendered by whichever component owns the action, once. */}
      {signedOut ? reauth.webView : null}
    </View>
  )
}
