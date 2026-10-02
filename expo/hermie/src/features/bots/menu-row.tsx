/**
 * One tappable line in a menu sheet.
 *
 * Its own file because both the row menu and the divider menu use it, and a
 * shared row that lives inside one of them is a shared row that moves the next
 * time that one is edited.
 */
import { Pressable } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { useHover } from '../../ui/useHover'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'

export function Row({
  onPress,
  testID,
  title,
  tone = 'text'
}: {
  onPress: () => void
  testID: string
  title: string
  tone?: 'text' | 'danger'
}) {
  const theme = useTheme()
  const hover = useHover()

  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={{ cursor: 'pointer' }}
      testID={testID}
      {...hover.props}
    >
      {({ pressed }) => (
        <Text
          color={tone === 'danger' ? 'dangerText' : 'text'}
          style={{
            backgroundColor: pressed || hover.hovered ? theme.glass.row.solid : theme.tintSunk,
            borderRadius: theme.radii.inset,
            lineHeight: CONTROL_MIN_HEIGHT,
            paddingHorizontal: theme.space.lg
          }}
          variant="body"
        >
          {title}
        </Text>
      )}
    </Pressable>
  )
}
