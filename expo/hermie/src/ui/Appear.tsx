/**
 * A thing that arrives and leaves, rather than one that is suddenly there.
 *
 * Four surfaces in the app were conditional renders — `{open ? <X/> : null}` —
 * and every one of them is a surface a native app animates: the jump-to-latest
 * pill, the drop overlay, the slash-command list, a queued message's row. A hard
 * cut is not a neutral choice there. It is the specific thing that makes an app
 * read as a web page in a window: real controls do not blink into existence, and
 * a reader who did not see WHERE something came from has to find it again.
 *
 * The motion is deliberately small — a short fade with a few points of travel —
 * because these are not screens. §5 of the token document reserves animation for
 * things that need the reader, and all four of these are exactly that: each one
 * appears because something happened that the reader has to be told about.
 *
 * `rise` is the travel, in points, and its SIGN is the direction the surface
 * comes from: positive rises from below, negative drops from above. It is a prop
 * rather than a constant because a pill above the composer comes up out of it and
 * a popover over the composer comes down onto it, and a surface that arrives from
 * the wrong side reads as a glitch even when nobody can say why.
 *
 * It never moves what is around it. Opacity and transform only, on the native
 * driver, so the only thing this can ever cost is a compositor pass — no layout
 * runs, and the row heights an inverted transcript depends on do not change while
 * it plays.
 */
import { type ReactNode } from 'react'
import { Animated, type ViewStyle } from 'react-native'

import { usePresence, type MotionToken } from './motion'
import { useTheme } from './theme'

export interface AppearProps {
  visible: boolean
  /** Which duration. `chip` — 180ms — is the default and fits a pill or a popover. */
  token?: MotionToken
  /** Travel in points: positive rises from below, negative drops from above. */
  rise?: number
  /**
   * How it leaves. `fade` by default; `cut` removes it on the frame it stops
   * being visible.
   *
   * `cut` is not laziness, and it is not the same question as the arrival. Two
   * of these surfaces exist only while something is in flight — the drop overlay
   * while a file is over the window, the slash list while a caret is in a
   * command — and both stop being visible because that thing RESOLVED. An
   * overlay still fading over the reply a drop produced, or a list of
   * suggestions still fading under the words that replaced them, is a surface
   * outliving its own reason, and on the drop overlay that has already been
   * decided once: see the test that says so.
   */
  exit?: 'fade' | 'cut'
  style?: ViewStyle | ViewStyle[]
  /**
   * Passed through while visible; forced to `none` on the way out.
   *
   * A surface that is already leaving must not eat the tap that opens the next
   * thing — the same rule `PanelScrim` follows for the same reason.
   */
  pointerEvents?: 'auto' | 'box-none' | 'none'
  /**
   * The exit has finished and nothing is on screen any more.
   *
   * For the one caller that has to OUTLIVE its own data: a queued message stops
   * being queued the moment it is sent, so the strip that showed it has to be
   * kept alive by whoever draws it until this says the animation is over.
   * Without it there is no exit to watch — the row is simply not in the next
   * render.
   */
  onExited?: () => void
  testID?: string
  children: ReactNode
}

export function Appear({
  children,
  exit = 'fade',
  onExited,
  pointerEvents = 'auto',
  rise = 8,
  style,
  testID,
  token = 'chip',
  visible
}: AppearProps) {
  const theme = useTheme()
  const { present, progress } = usePresence(visible, {
    reduceMotion: theme.reduceMotion,
    token,
    ...(onExited ? { onExited } : {})
  })

  if (!present || (exit === 'cut' && !visible)) {
    return null
  }

  return (
    <Animated.View
      pointerEvents={visible ? pointerEvents : 'none'}
      style={[
        style,
        {
          opacity: progress,
          transform: [
            {
              translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [rise, 0] })
            }
          ]
        }
      ]}
      testID={testID}
    >
      {children}
    </Animated.View>
  )
}
