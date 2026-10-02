/**
 * Three dots, and the bubble they start life in.
 *
 * §6.2 is one sentence with a lot in it: **one bubble from start to finish.**
 * While the turn is pending the bubble is compact and holds the dots; when tokens
 * arrive the dots are replaced by text in the SAME bubble. No placeholder box, no
 * grey rectangle, no swapping one view for another.
 *
 * The previous build broke that in two places at once. It drew this component as
 * its own bubble at the bottom of the list, AND the assistant bubble rendered
 * itself as soon as it existed — with empty text — so a turn showed a bubble of
 * dots under an empty grey rectangle with a timestamp in it. That rectangle is
 * the "grey box inside the bot bubble" the owner reported. The fix is here and in
 * two other places: `AssistantBubble` draws the dots itself while it has no text,
 * and `TranscriptList` stops drawing a standalone typing bubble the moment a
 * streaming assistant item exists.
 *
 * Dots DO animate. §5 reserves animation for things that need the reader and then
 * makes exactly this exception: typing dots are streaming content, not status.
 */
import { useEffect, useRef } from 'react'
import { Animated, View } from 'react-native'

import { motion, NATIVE_DRIVER } from '../ui/motion'
import { useTheme } from '../ui/theme'
import { Bubble } from './primitives/Bubble'
import { chatStrings } from './strings'

export interface TypingIndicatorProps {
  testID?: string
}

const DOTS = [0, 1, 2]

/** Just the dots, for use inside a bubble that already exists. */
export function TypingDots({ testID = 'typing-dots' }: TypingIndicatorProps) {
  const theme = useTheme()
  const values = useRef(DOTS.map(() => new Animated.Value(0.35))).current

  useEffect(() => {
    if (theme.reduceMotion) {
      values.forEach(value => value.setValue(0.6))

      return
    }

    const loops = values.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * motion.dotStagger),
          Animated.timing(value, { duration: motion.dot, toValue: 1, useNativeDriver: NATIVE_DRIVER }),
          Animated.timing(value, { duration: motion.dot, toValue: 0.35, useNativeDriver: NATIVE_DRIVER }),
          Animated.delay((DOTS.length - index - 1) * motion.dotStagger)
        ])
      )
    )

    loops.forEach(loop => loop.start())

    return () => loops.forEach(loop => loop.stop())
  }, [theme.reduceMotion, values])

  return (
    <View
      accessibilityLabel={chatStrings.replying}
      accessibilityRole="progressbar"
      style={{ alignItems: 'center', flexDirection: 'row', gap: 5, paddingVertical: 3 }}
      testID={testID}
    >
      {values.map((value, index) => (
        <Animated.View
          key={index}
          style={{
            backgroundColor: theme.colors.textMuted,
            borderRadius: 4,
            height: 8,
            opacity: value,
            width: 8
          }}
        />
      ))}
    </View>
  )
}

/**
 * The dots in their own bubble.
 *
 * Only for the gap before the assistant item exists at all. Once it does, the
 * item's own bubble holds the dots — which is the point of §6.2.
 */
export function TypingIndicator({ testID = 'typing-indicator' }: TypingIndicatorProps) {
  return (
    <Bubble side="other" tail testID={testID} variant="in">
      <TypingDots testID={`${testID}-dots`} />
    </Bubble>
  )
}
