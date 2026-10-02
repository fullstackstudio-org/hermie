/**
 * The chat list's title, and — once there is more than one gateway — the switch.
 *
 * ## Why the switch is here and not in the chat
 *
 * The owner could add a second gateway and then could not get to it. Adding one
 * works; the only way across was Settings → Gateways, three taps deep, and the
 * chat header that might have carried the switch has a name, a subtitle, a
 * presence bead, a context ring and an options button in it already. There was
 * no room, and a chat is the wrong place for the control anyway: a chat belongs
 * to ONE gateway, and switching would close the conversation the button is drawn
 * on.
 *
 * The chat LIST is the thing that changes. Every row in it belongs to one
 * gateway, so "which gateway" is the list's own title, in the same place Mail
 * puts a mailbox name — the big word, a chevron, and the screen's own name on the
 * small line under it.
 *
 * ## With one gateway there is nothing to switch
 *
 * Then the title is the screen's name, plainly, with no chevron and nothing to
 * press: a control whose menu has one row in it is a control that teaches the
 * reader to stop pressing things. The condition lives here rather than in
 * `BotsScreen` so that the head row gains exactly one element.
 */
import { useState } from 'react'
import { Pressable, View } from 'react-native'

import { gatewayLabel, gatewaysInOrder, useGateway } from '../../gateway'
import { strings } from '../../i18n/strings'
import { Appear } from '../../ui/Appear'
import { GlassSurface } from '../../ui/glass'
import { Icon, ICON_SIZE } from '../../ui/Icon'
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../../ui/tokens'
import { useEscapeKey } from '../../ui/useEscapeKey'

export interface GatewayTitleProps {
  /** The wide shell's title is a size up, exactly as the plain title's was. */
  sidebar?: boolean
  testID?: string
}

export function GatewayTitle({ sidebar = false, testID = 'bots-gateway' }: GatewayTitleProps) {
  const theme = useTheme()
  /*
    Read through `?.`: this hangs off the chat list's title, which a dozen suites
    render with a stand-in gateway context carrying only the fields they care
    about. "Nothing is known about the list" and "there is one gateway" want the
    same answer anyway, which is the plain title.
  */
  const { gateway, registry, switchGateway } = useGateway()
  const gateways = registry ? gatewaysInOrder(registry) : []
  const [open, setOpen] = useState(false)

  useEscapeKey(() => setOpen(false), open)

  const title = (
    /*
      One line, always. Without it the title is a `flex: 1` column next to
      controls that do not compress, and at the narrow sidebar's width "Chats"
      wrapped to one character per line. Eliding is the honest failure: the word
      is the screen's name, and a reader who sees "Cha…" has still been told
      which screen this is.
    */
    <Text accessibilityRole="header" aria-level={1} numberOfLines={1} variant={sidebar ? 'titleWide' : 'title'}>
      {strings.bots.title}
    </Text>
  )

  if (gateways.length < 2 || !gateway) {
    return title
  }

  return (
    <View>
      <Pressable
        accessibilityHint={strings.bots.switchGatewayHint}
        accessibilityLabel={strings.bots.switchGateway(gatewayLabel(gateway))}
        accessibilityRole="button"
        // `aria-expanded`, not `accessibilityState`: react-native-web drops the
        // object spelling on the floor. See `accessibility-state.test.tsx`.
        aria-expanded={open}
        hitSlop={TAP_SLOP}
        onPress={() => setOpen(current => !current)}
        style={{ alignItems: 'center', cursor: 'pointer', flexDirection: 'row', gap: theme.space.xs }}
        testID={`${testID}-switch`}
      >
        <Text numberOfLines={1} style={{ flexShrink: 1 }} variant={sidebar ? 'titleWide' : 'title'}>
          {gatewayLabel(gateway)}
        </Text>
        {/* Decorative: the row says its own state through `aria-expanded`. */}
        <Icon color={theme.colors.accentText} name="chevronDown" size={ICON_SIZE.inline} />
      </Pressable>

      {/*
        The screen's own name, on the small line. It moves rather than
        disappearing: the gateway's name answers "whose list is this" and says
        nothing about which of the app's screens the reader is on.
      */}
      <Text accessibilityRole="header" aria-level={1} color="textMuted" numberOfLines={1} variant="meta">
        {strings.bots.title}
      </Text>

      <Appear
        rise={-6}
        style={{
          position: 'absolute',
          left: 0,
          // Clear of the pressable rather than measured off it, exactly as the
          // `…` menu does it: a surface overlapping what opened it takes that
          // thing's next tap.
          top: CONTROL_MIN_HEIGHT,
          zIndex: 2
        }}
        visible={open}
      >
        {/*
          `opaque`, for the reason `AttachMenu` gives: a text-heavy surface takes
          the solid rung under its wash, so its contrast is a fixed number rather
          than a function of whatever is behind it — and what is behind this one
          is a list of names at the same weight.
        */}
        <GlassSurface contentStyle={{ minWidth: 220, paddingVertical: theme.space.xxs }} opaque variant="float">
          {gateways.map(entry => {
            const active = entry.id === gateway.id

            return (
              <Pressable
                accessibilityRole="button"
                aria-selected={active}
                key={entry.id}
                onPress={() => {
                  setOpen(false)

                  if (!active) {
                    void switchGateway(entry.id)
                  }
                }}
                style={({ pressed }) => ({
                  alignItems: 'center',
                  backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
                  cursor: 'pointer',
                  flexDirection: 'row',
                  gap: theme.space.sm,
                  minHeight: CONTROL_MIN_HEIGHT,
                  paddingHorizontal: theme.space.md
                })}
                testID={`${testID}-choice-${entry.id}`}
              >
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} variant="preview">
                    {gatewayLabel(entry)}
                  </Text>
                  <Text color="textMuted" numberOfLines={1} variant="micro">
                    {entry.address}
                  </Text>
                </View>

                {/* The tick, on the one row that needs no press. */}
                {active ? (
                  <Icon
                    color={theme.colors.accentText}
                    name="check"
                    size={ICON_SIZE.inline}
                    testID={`${testID}-active-${entry.id}`}
                  />
                ) : null}
              </Pressable>
            )
          })}
        </GlassSurface>
      </Appear>
    </View>
  )
}
