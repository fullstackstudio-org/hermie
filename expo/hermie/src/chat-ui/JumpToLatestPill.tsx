/**
 * The floating pill that appears once the transcript is scrolled away from the
 * bottom, carrying the count of messages that arrived meanwhile.
 *
 * §6.10 and §7.1: a GLASS pill, centred above the composer. It sits over the
 * transcript rather than in it, which is the one place in the chat column where a
 * floating surface is the right answer — it has to be legible over whatever bubble
 * happens to be under it, and a solid accent block over a reading bubble reads as
 * a banner rather than as a control.
 */
import { Pressable, View } from 'react-native'

import { GlassSurface } from '../ui/glass'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { chatStrings } from './strings'

export interface JumpToLatestPillProps {
  onPress: () => void
  /** Messages that arrived while you were reading further up. */
  count?: number
  testID?: string
}

export function JumpToLatestPill({ onPress, count = 0, testID = 'jump-to-latest' }: JumpToLatestPillProps) {
  const theme = useTheme()
  const accent = theme.accent()

  return (
    <GlassSurface radius={theme.radii.pill} shadow="float" style={{ alignSelf: 'center' }} variant="float">
      <Pressable
        accessibilityLabel={
          count > 0
            ? `${chatStrings.transcript.jumpToLatest}, ${chatStrings.transcript.newMessages(count)}`
            : chatStrings.transcript.jumpToLatest
        }
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
        testID={testID}
      >
        <View
          style={{
            alignItems: 'center',
            flexDirection: 'row',
            gap: theme.space.xs + 2,
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.sm + 1
          }}
        >
          <Text style={{ color: accent.text, fontSize: 13, lineHeight: 16 }}>{'↓'}</Text>

          {/* The count is the accent's own fill, so an unread number is the one
              thing on the pill that carries colour. */}
          {count > 0 ? (
            <View
              style={{
                backgroundColor: accent.fill,
                borderRadius: theme.radii.pill,
                paddingHorizontal: theme.space.sm,
                paddingVertical: 1
              }}
            >
              <Text color="onAccent" variant="micro">
                {String(count)}
              </Text>
            </View>
          ) : null}

          <Text style={{ color: accent.text, fontWeight: '600' }} variant="meta">
            {chatStrings.transcript.jumpToLatest}
          </Text>
        </View>
      </Pressable>
    </GlassSurface>
  )
}
