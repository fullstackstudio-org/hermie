/**
 * "↳ 1 message queued · …" — the backend parked a prompt behind the running
 * turn. It sits under the composer, where the design board puts it.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { clipInline } from './format'
import { chatStrings } from './strings'

export interface QueuedChipProps {
  text: string
  testID?: string
}

export function QueuedChip({ text, testID }: QueuedChipProps) {
  const theme = useTheme()

  if (!text.trim()) {
    return null
  }

  return (
    <View style={{ paddingHorizontal: theme.space.xs, paddingVertical: theme.space.xs }} testID={testID}>
      <Text color="textMuted" numberOfLines={1} style={{ fontSize: 11 }}>
        {chatStrings.composer.queued(clipInline(text, 48))}
      </Text>
    </View>
  )
}
