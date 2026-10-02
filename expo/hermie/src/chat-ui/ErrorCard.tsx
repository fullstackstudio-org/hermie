/**
 * A failed turn.
 *
 * Two different failures wear different clothes, and conflating them is the
 * bug this card exists to avoid:
 *   - `retryable` means the turn is gone and resubmitting is the user's call.
 *   - `recoverable` means the backend still holds the turn and a resume will
 *     replay it, so the card says "Reconnecting…" and offers no button —
 *     pressing Retry there would duplicate the turn.
 */
import { View } from 'react-native'

import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { useLedgerWidth } from './primitives/Bubble'
import { chatStrings } from './strings'

export interface ErrorCardProps {
  message: string
  retryable?: boolean
  recoverable?: boolean
  onRetry?: () => void
  testID?: string
}

export function ErrorCard({ message, retryable = false, recoverable = false, onRetry, testID }: ErrorCardProps) {
  const theme = useTheme()
  const maxWidth = useLedgerWidth()

  return (
    <View
      accessibilityRole="alert"
      style={{
        backgroundColor: theme.elevation.e3c,
        borderColor: theme.colors.danger,
        borderRadius: theme.radii.xl,
        borderWidth: 1,
        gap: theme.space.sm,
        // §6.4's column rule, the same one every other ledger card takes: inside
        // a transcript the cap is the bubble's, and the margin keeps the card off
        // the gutter where the cap is the whole of a narrow column. Outside one
        // `useLedgerWidth` is undefined and the card fills its box, which is what
        // a gallery section and the Activity timeline want.
        marginRight: 26,
        marginVertical: theme.space.sm,
        maxWidth,
        padding: theme.space.md
      }}
      testID={testID}
    >
      <Text color="dangerText" variant="name">
        {chatStrings.assistant.errorTitle}
      </Text>
      <Text color="text" selectable style={{ fontSize: 15, lineHeight: 21 }}>
        {message}
      </Text>

      {recoverable ? (
        <Text color="textMuted" variant="meta">
          {chatStrings.assistant.reconnecting}
        </Text>
      ) : null}

      {retryable && !recoverable && onRetry ? (
        <Button
          onPress={onRetry}
          // Content width, not the card's. A one-word action stretched across a
          // 600pt card reads as the card's own bottom edge rather than as a
          // button, and the mockup's `.btn` is sized by its label. The 44pt
          // minimum lives on `Button`'s inner view, so capping the Pressable
          // here narrows it without shortening it.
          style={{ alignSelf: 'flex-start' }}
          testID={`${testID ?? 'error-card'}-retry`}
          title={chatStrings.assistant.retry}
        />
      ) : null}
    </View>
  )
}
