/**
 * The dim a destination panel lays over what it covers — INSIDE each panel rather
 * than over the window.
 *
 * ## Why it is not one scrim over everything
 *
 * It was, and the result was wrong in both directions at once. A
 * `StyleSheet.absoluteFill` over the shell dims the WALLPAPER GAP between the two
 * panels and around them — a 14pt dark frame with nothing behind it to dim — while
 * the sidebar it is drawn over stays bright, because the sidebar used to be
 * deliberately outside the scrim. So the reader saw a darkened window edge and an
 * undimmed list: exactly backwards from what the dim is for, which is to say that
 * the panels behind this one are not the thing to read.
 *
 * Rendered as a child of each panel instead, the dim is the panel's own shape. Its
 * corners cannot disagree with the panel's corners, because they are the same
 * rounded rectangle, and it cannot reach the gap, because the gap is not inside
 * anything. That the sidebar is also no longer INTERACTIVE while an overlay is open
 * is the same decision seen from the other side: a list you can see through a dim
 * and still click is a dim that means nothing.
 *
 * The radius is passed rather than assumed. Both panels are `variant="panel"` today
 * and both therefore take `radii.panel`, but a scrim whose radius is a guess at its
 * parent's is a 1pt bright arc at four corners the day one of them changes — and at
 * the Mac's scaling a 1pt arc is visible.
 */
import { Animated, Pressable, StyleSheet } from 'react-native'

import { strings } from '../i18n/strings'
import { usePresence } from '../ui/motion'
import { useTheme } from '../ui/theme'
import { SCRIM_COLOR } from '../ui/tokens'

export type PanelScrimProps = {
  /** An overlay is open over this panel. */
  open: boolean
  /** Tapping the dim closes ONE level, which is the same answer Escape gives. */
  onPress: () => void
  /** The radius of the panel this is inside. Not a default: see above. */
  radius: number
  testID: string
}

export function PanelScrim({ onPress, open, radius, testID }: PanelScrimProps) {
  const theme = useTheme()
  // Kept mounted for the fade-out — the same reason the panels themselves are: a
  // scrim that unmounts on the first frame of its own exit does not fade, it
  // vanishes, and a panel sliding out over an undimmed list reads as two
  // unrelated events. It moves at the panel's duration for the same reason.
  const { present, progress } = usePresence(open, { reduceMotion: theme.reduceMotion, token: 'panel' })

  if (!present) {
    return null
  }

  return (
    <Animated.View
      // `none` on the way out, so a panel already sliding away does not eat the
      // tap that opens the next thing.
      pointerEvents={open ? 'auto' : 'none'}
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: SCRIM_COLOR, borderRadius: radius, opacity: progress, overflow: 'hidden' }
      ]}
      // The dim itself, separately reachable from the pressable inside it: the
      // radius and the fill are what a test has to be able to state, and the
      // pressable is what it has to be able to tap.
      testID={`${testID}-dim`}
    >
      <Pressable
        accessibilityLabel={strings.layout.close}
        accessibilityRole="button"
        onPress={onPress}
        style={StyleSheet.absoluteFill}
        testID={testID}
      />
    </Animated.View>
  )
}
