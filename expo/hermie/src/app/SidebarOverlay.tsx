/**
 * The chat list as a temporary sheet over the chat, for a window too narrow to
 * hold both.
 *
 * ## Why the narrow window gets a different answer
 *
 * Below 900pt the reason the sidebar is collapsed is that the chat column needs
 * the width (docs/platform-notes.md, the 2026-09-20 portrait pass: at 834pt the
 * bubble cap lands around 335pt, which is about 38 characters). Asking for the
 * list back and getting the chat squeezed again would hand the reader exactly the
 * problem they collapsed it to avoid. So here the list arrives OVER the chat, and
 * leaves on the next tap — which is also what "temporary" should mean: picking a
 * chat closes it, because picking a chat is the whole errand.
 *
 * At 900pt and above the shell does not use this at all; Show simply widens the
 * sidebar back into place, because there is room for both.
 *
 * ## Escape, and the one animation
 *
 * It registers on the Escape stack (`src/ui/useEscapeKey.ts`), which delivers to
 * whatever registered LAST — so with a destination panel already open, Escape
 * closes whichever of the two the reader opened most recently and the other stays.
 * Nothing coordinates that; it falls out of mount order.
 *
 * The slide is the one motion the owner allowed outside the "needs input" pulse: a
 * short, static-feeling ease, and zero under Reduce Motion. It earns it by being an
 * overlay — something that appears over content with no transition reads as a
 * rendering fault rather than as an arrival. The IN-PLACE collapse at ≥ 900pt is
 * deliberately instant, because there the panel is not arriving, it is resizing,
 * and a resizing panel full of list rows is the most expensive thing in the app to
 * animate for the least reader benefit.
 */
import { type ReactNode } from 'react'
import { Animated, Pressable, StyleSheet } from 'react-native'

import { strings } from '../i18n/strings'
import { useSafeAreaInsets } from '../platform/safe-area'
import { GlassSurface } from '../ui/glass'
import { motion, usePresence } from '../ui/motion'
import { useTheme } from '../ui/theme'
import { SCRIM_COLOR, WINDOW_GAP } from '../ui/tokens'
import { useEscapeKey } from '../ui/useEscapeKey'
import { useHardwareBack } from '../ui/useHardwareBack'

/** Short enough to read as static, long enough not to read as a jump cut. */
export const SIDEBAR_OVERLAY_MOTION = motion.sidebar

export type SidebarOverlayProps = {
  visible: boolean
  width: number
  onClose: () => void
  children: ReactNode
}

export function SidebarOverlay({ children, onClose, visible, width }: SidebarOverlayProps) {
  /**
   * The panel's own window inset, applied here rather than inherited.
   *
   * Yoga positions an absolutely placed child against its parent's PADDING edge,
   * not its content edge — so inside the shell's padded row, `top: 0` is the top of
   * the window and not the top of the column it stands in for. Measured on an iPad
   * Pro 11": the list arrived under the clock while the rail beside it started
   * below it. The numbers are the shell's own window padding, which is what this
   * has to line up with.
   */
  const insets = useSafeAreaInsets()
  // Honouring Reduce Motion is not optional: §5 of the token document collapses
  // every duration in the app to zero under it, which `usePresence` does.
  const { reduceMotion } = useTheme()
  const { present, progress } = usePresence(visible, { reduceMotion, token: 'sidebar' })

  useEscapeKey(onClose, visible)
  /*
    NOT a `useShortcutScope`, although it looks like every other overlay.

    A modal scope means "the surface these shortcuts switch to is underneath
    something". This overlay IS that surface: it is the chat list, arrived over
    the chat because the window is too narrow to hold both. ⌘K has a field to
    land in here and ⌘1…9 have rows to open, so switching them off would take
    the shortcuts away at exactly the width that most needs them.
  */
  // Android's back button is the same question as Escape, and this is a plain view
  // rather than a `Modal`, so the press would otherwise reach the activity and
  // background the app with the list still open — the bug `OverlayPanel` had.
  useHardwareBack(onClose, visible)

  if (!present) {
    return null
  }

  return (
    <>
      <Animated.View
        pointerEvents={visible ? 'auto' : 'none'}
        style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM_COLOR, opacity: progress }]}
      >
        <Pressable
          accessibilityLabel={strings.layout.close}
          accessibilityRole="button"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID="sidebar-overlay-scrim"
        />
      </Animated.View>

      <Animated.View
        style={{
          bottom: WINDOW_GAP + insets.bottom,
          left: WINDOW_GAP + insets.left,
          position: 'absolute',
          top: WINDOW_GAP + insets.top,
          transform: [
            {
              // Off to the left by its own width plus the gap and the inset, so no
              // edge of it is left peeking at the window's own edge.
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [-(width + WINDOW_GAP * 2 + insets.left), 0]
              })
            }
          ],
          // Never wider than the window it covers: at the bottom of the band this
          // exists for, the sidebar's own width is a large share of it.
          maxWidth: '100%',
          width
        }}
        testID="sidebar-overlay"
      >
        <GlassSurface contentStyle={{ flex: 1 }} style={{ flex: 1 }} variant="panel">
          {children}
        </GlassSurface>
      </Animated.View>
    </>
  )
}
