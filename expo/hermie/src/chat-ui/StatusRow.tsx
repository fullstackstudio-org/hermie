/**
 * A transient one-liner from `status.update` — compaction, lifecycle, a
 * background process.
 *
 * Centred and quiet: it is weather, not a message. The kind is the eyebrow and
 * the text is the line, in the micro/meta pair every machine row in the
 * transcript uses.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Chip } from './primitives/Chip'
import type { Presentation, StatusItem } from './types'

export interface StatusRowProps {
  item: StatusItem
  presentation?: Presentation
}

export function StatusRow({ item, presentation = 'chip' }: StatusRowProps) {
  const theme = useTheme()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  if (presentation === 'chip') {
    return <Chip centered label={item.text} testID={`status-${item.id}`} />
  }

  return (
    <View
      style={{ alignItems: 'center', gap: theme.space.xxs, paddingVertical: theme.space.xs }}
      testID={`status-${item.id}`}
    >
      <Text color="textFaint" variant="micro">
        {item.statusKind.replace(/[._-]+/g, ' ').toUpperCase()}
      </Text>
      <Text color="textMuted" style={{ textAlign: 'center' }} variant="meta">
        {item.text}
      </Text>
    </View>
  )
}
