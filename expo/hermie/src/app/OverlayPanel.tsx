/**
 * Activity, Crons and Settings on the wide layout: a glass panel that slides in
 * over the CHAT COLUMN from the right while both panels behind it are dimmed.
 *
 * These destinations are things you consult, not places you go, and replacing the
 * chat with them costs the reader their place; covering it and leaving the list
 * where it is does not.
 *
 * ### It is exactly the content panel's frame
 *
 * Not "roughly over the chat column": the same top edge, the same bottom edge, the
 * same right edge and the same corner radius, so the two read as one panel with a
 * new face rather than as a card floating on a card. The frame is MEASURED and
 * handed in (`frame`) rather than derived from the window, which is what it used to
 * be — window insets plus a gap, guessed at from the outside. On the Mac that guess
 * was visibly wrong at the bottom: the panel ran past the chat panel's rounded
 * corner and met the window's own edge, square. A measured box cannot be wrong
 * about a box it measured.
 *
 * Before the first layout there is no measurement, and the fallback is the parent's
 * own fill — which is the same box, because the panel is a sibling of the content
 * panel inside a container both of them fill. So the first frame is right too; the
 * measurement is what keeps it right if that ever stops being true.
 *
 * ### The dim is not here
 *
 * It is inside each panel it covers (`PanelScrim`), including the sidebar. A single
 * scrim over the window dimmed the wallpaper GAP — a dark frame around two bright
 * panels — and left the sidebar undimmed. See `PanelScrim` for the whole argument.
 *
 * ### Escape goes back one level
 *
 * The panel registers on the Escape stack in `src/ui/useEscapeKey.ts`, which
 * delivers to whatever registered LAST. A sub page inside the panel — a cron's
 * detail, a run transcript, the connection test — registers its own handler when
 * it opens, which is after this one, so the first Escape pops the sub page and
 * the panel stays; a second Escape closes the panel. Nothing here coordinates
 * that: it falls out of mount order, which is exactly why the stack is a stack.
 *
 * ### It draws no title row of its own any more (HERM-102, HERM-108)
 *
 * It used to: a title and a round close button, the same shape repeated for
 * Activity, Crons and Settings. That was a second header — the page inside
 * already draws its own `PageChrome` — so a panel read as "Settings" twice.
 * The title and the close both come from the page now: `PageChrome`'s `title`
 * names it, and a `trailing` close (X) closes it, handed in by whichever shell
 * mounted the page. This component is left with exactly the thing an overlay
 * actually is — where it sits, what it dims, and what closes it.
 */
import { type ReactNode } from 'react'
import { Animated, StyleSheet, View } from 'react-native'

import { GlassSurface } from '../ui/glass'
import { usePresence } from '../ui/motion'
import { useTheme } from '../ui/theme'
import { OVERLAY_MAX_WIDTH, WINDOW_GAP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { useHardwareBack } from '../ui/useHardwareBack'
import { useShortcutScope } from '../ui/useShortcut'

/** A measured box, in the coordinates of the container the panel is placed in. */
export type PanelFrame = { x: number; y: number; width: number; height: number }

export type OverlayPanelProps = {
  visible: boolean
  onClose: () => void
  /**
   * The content panel's measured frame, from its own `onLayout`.
   *
   * Absent until the first layout pass, which falls back to filling the parent.
   */
  frame?: PanelFrame
  children: ReactNode
}

export function OverlayPanel({ children, frame, onClose, visible }: OverlayPanelProps) {
  const theme = useTheme()
  // `present` trails `visible` by one slide-out: see `usePresence`.
  const { present, progress } = usePresence(visible, { reduceMotion: theme.reduceMotion, token: 'panel' })

  useEscapeKey(onClose, visible)
  // Open over another surface: a shortcut that switches to that surface is off
  // while it is. See `useShortcutScope`.
  useShortcutScope(visible)
  // Android's back button is the same question as Escape, and this panel is the
  // one surface that never heard either: a sheet is a `Modal`, which consumes
  // the press and answers `onRequestClose`, but this is a plain view, so the
  // press reached the activity and backgrounded the app with the panel still
  // open. Measured on an emulator — back on Settings left for the launcher.
  useHardwareBack(onClose, visible)

  if (!present) {
    return null
  }

  return (
    /*
      The measured frame, as a box that does nothing but hold the panel against the
      content panel's edges. `pointerEvents="box-none"` because this box covers the
      whole column: the chat's own dim is inside the chat panel and must keep
      receiving the taps that land beside the 520pt panel.
    */
    <View
      pointerEvents="box-none"
      style={
        frame
          ? { height: frame.height, left: frame.x, position: 'absolute', top: frame.y, width: frame.width }
          : StyleSheet.absoluteFill
      }
      testID="overlay-frame"
    >
      <Animated.View
        style={{
          // Flush with the content panel on all three edges it shares with it. The
          // 14pt window gap does NOT appear here: that gap is between the panels
          // and the window, and this panel's edges are the chat panel's edges.
          bottom: 0,
          position: 'absolute',
          right: 0,
          top: 0,
          transform: [
            {
              // Off to the right by its own width plus the window gap, so no part
              // of it is left peeking past the panel it slides out of.
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [OVERLAY_MAX_WIDTH + WINDOW_GAP, 0]
              })
            }
          ],
          // Its own width, but never wider than the column it covers — on a
          // window only just past the wide threshold that column is narrow.
          maxWidth: '100%',
          width: OVERLAY_MAX_WIDTH
        }}
        testID="overlay-panel"
      >
        {/*
          The radius is named rather than left to the variant, so that "the same
          radius as the panel underneath" is a fact in the code and not a
          coincidence between two lookup tables. `PanelScrim` is handed the same
          number.
        */}
        <GlassSurface contentStyle={{ flex: 1 }} radius={theme.radii.panel} style={{ flex: 1 }} variant="panel">
          {children}
        </GlassSurface>
      </Animated.View>
    </View>
  )
}
