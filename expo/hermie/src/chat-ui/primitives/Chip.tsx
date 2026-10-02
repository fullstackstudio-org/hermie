/**
 * The small rounded label the transcript uses for a demoted item.
 *
 * `showBotToBot: false` never removes a DM — it collapses it to one of these,
 * because a bot's reply to a message you cannot see is unexplainable.
 *
 * A chip is a LEVEL-3 surface (§7.1): a tint and a hairline, no blur of its own,
 * whatever it sits on. That is the rule that keeps the two panels' glass from
 * being sampled a second time by everything inside them.
 */
import type { ReactNode } from 'react'
import { Pressable, View, type ViewStyle } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { TextColorRole } from '../../ui/tokens'

export interface ChipProps {
  label: string
  tone?: TextColorRole
  leading?: ReactNode
  onPress?: () => void
  /** Centres the chip in the transcript, the way a system notice sits. */
  centered?: boolean
  style?: ViewStyle
  testID?: string
}

export function Chip({ label, tone = 'textFaint', leading, onPress, centered = false, style, testID }: ChipProps) {
  const theme = useTheme()

  const body = (
    <View
      style={[
        {
          alignItems: 'center',
          alignSelf: centered ? 'center' : 'flex-start',
          backgroundColor: theme.tintSunk,
          borderColor: theme.hairlineSoft,
          borderRadius: theme.radii.pill,
          borderWidth: 1,
          flexDirection: 'row',
          gap: theme.space.xs,
          paddingHorizontal: theme.space.md,
          paddingVertical: theme.space.xs + 1
        },
        style
      ]}
      // On the body as well as on the Pressable: a chip without `onPress` has
      // no Pressable, and a testID that silently disappears is a test that
      // silently stops asserting.
      testID={onPress ? undefined : testID}
    >
      {leading}
      <Text color={tone} variant="meta">
        {label}
      </Text>
    </View>
  )

  if (!onPress) {
    return body
  }

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({ alignSelf: centered ? 'center' : 'flex-start', opacity: pressed ? 0.6 : 1 })}
      testID={testID}
    >
      {body}
    </Pressable>
  )
}
