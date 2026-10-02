/**
 * The pinned bar under the chat header: "3 agents working · 0:42 · Show".
 *
 * It lives at the TOP of the transcript, not above the composer, because that
 * is where the design board pins it and because a bar that moves with the
 * composer fights the keyboard.
 *
 * §5's `.agents`: a slim FLOATING glass pill inset from the panel edge, not a
 * full-width strip with a bottom rule. The strip read as a second header and
 * made the transcript start one hairline lower than the mockup's does; the pill
 * reads as something laid on top, which is what it is — it appears and
 * disappears with the run. Three pips at the left stand for the children, and
 * they are STATIC: agents working is information, and the only thing in the app
 * allowed to animate is "needs input".
 */
import { useEffect, useState } from 'react'
import { Pressable, View } from 'react-native'

import { MONOSPACE } from '../markdown/context'
import { GlassSurface } from '../ui/glass'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { formatElapsedClock } from './format'
import { chatStrings } from './strings'

/** §5: three 5pt dots at falling opacity. More than three is a crowd, not a count. */
const PIP_OPACITY = [1, 0.7, 0.45] as const

export interface AgentsBarProps {
  /** How many children are queued or running. Zero hides the bar. */
  count: number
  /**
   * Epoch MILLISECONDS the oldest running child started; the bar ticks from it.
   *
   * Named for its unit on purpose. `Subagent.startedAt` is milliseconds — the
   * agents sheet already treats it as such — and this prop used to be seconds,
   * so the screen handed it a number a thousand times too large and the clock
   * read `0s` for the whole run.
   */
  startedAtMs?: number
  /** Overrides the ticking clock — the gallery and the tests pass a fixed value. */
  elapsedSeconds?: number
  onPress: () => void
  testID?: string
}

export function AgentsBar({ count, startedAtMs, elapsedSeconds, onPress, testID = 'agents-bar' }: AgentsBarProps) {
  const theme = useTheme()
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (elapsedSeconds !== undefined || !startedAtMs || count === 0) {
      return
    }

    const timer = setInterval(() => setNow(Date.now()), 1000)

    return () => clearInterval(timer)
  }, [count, elapsedSeconds, startedAtMs])

  if (count <= 0) {
    return null
  }

  const elapsed = elapsedSeconds ?? (startedAtMs ? Math.max(0, (now - startedAtMs) / 1000) : 0)

  return (
    <Pressable
      accessibilityLabel={chatStrings.subagents.working(count, formatElapsedClock(elapsed))}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        marginBottom: theme.space.sm,
        marginHorizontal: theme.space.sm + 2,
        opacity: pressed ? 0.7 : 1
      })}
      testID={testID}
    >
      <GlassSurface
        contentStyle={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.sm,
          minHeight: 32,
          paddingHorizontal: theme.space.md,
          paddingVertical: 6
        }}
        radius={theme.radii.pill}
        variant="float"
      >
        <View
          accessibilityElementsHidden
          // `aria-hidden` is the web's spelling of the two props around it; react-native-web
          // honours neither of those. See `ui/Icon.tsx`.
          aria-hidden
          importantForAccessibility="no-hide-descendants"
          style={{ flexDirection: 'row', gap: 3 }}
        >
          {PIP_OPACITY.map(opacity => (
            <View
              key={opacity}
              style={{ backgroundColor: theme.presence.working, borderRadius: 2.5, height: 5, opacity, width: 5 }}
            />
          ))}
        </View>

        <Text style={{ fontSize: 13, fontWeight: '600', lineHeight: 17 }}>{chatStrings.subagents.barCount(count)}</Text>
        <Text color="textFaint" variant="meta">
          {'·'}
        </Text>
        <Text color="textMuted" style={{ flex: 1, fontFamily: MONOSPACE, fontSize: 12, lineHeight: 17 }}>
          {formatElapsedClock(elapsed)}
        </Text>
        <Text color="accentText" style={{ fontSize: 13, fontWeight: '600', lineHeight: 17 }}>
          {chatStrings.subagents.barOpen}
        </Text>
      </GlassSurface>
    </Pressable>
  )
}
