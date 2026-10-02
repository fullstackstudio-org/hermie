import { View, type ViewProps } from 'react-native'

import { useSafeAreaInsets } from '../../platform/safe-area'
import { useGlassDepth } from '../glass/GlassSurface'
import { useTheme } from '../theme'

export type ScreenProps = ViewProps & {
  /** Skip the top safe-area inset when a navigation header already covers it. */
  edgeToEdgeTop?: boolean
  padded?: boolean
}

/**
 * A full screen: the background, and the padding that clears the system's own
 * furniture.
 *
 * **Both of those are a phone's problem, and inside a glass panel they are
 * actively wrong.** Measured on an iPad Pro 13" simulator, dark theme: the chat
 * column sampled `#0A1830`, which is `elevation.e0` — the WALLPAPER rung — while
 * the sidebar beside it sampled `#1B2744`, the panel rung it should have. The
 * two panels are the same `GlassSurface` with the same variant, so the
 * difference was not the panel: it was this component, filling the whole column
 * with `colors.bg` on top of the glass. Every wide-layout destination goes
 * through here — the chat, Settings, Activity, Crons — so every one of them was
 * painting the wallpaper's own colour over the material that was supposed to
 * refract it, which is exactly why dark mode read as one flat field instead of
 * as an elevation ladder.
 *
 * The inset half is the same mistake in the other direction, and `RegularShell`
 * already documents the rule it breaks: the safe-area padding is applied ONCE,
 * to the row holding both panels, and neither panel adds any of its own. A
 * `Screen` inside a panel added a second copy of the top inset.
 *
 * So both are conditional on the glass depth. At depth 0 — a phone screen, the
 * onboarding wizard, a full-screen web view — nothing changes.
 */
export function Screen({ edgeToEdgeTop = false, padded = true, style, ...rest }: ScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const inPanel = useGlassDepth() > 0

  return (
    <View
      {...rest}
      style={[
        {
          flex: 1,
          backgroundColor: inPanel ? 'transparent' : theme.elevation.e0,
          paddingTop: inPanel || edgeToEdgeTop ? 0 : insets.top,
          paddingBottom: inPanel ? 0 : insets.bottom,
          paddingLeft: (inPanel ? 0 : insets.left) + (padded ? theme.space.lg : 0),
          paddingRight: (inPanel ? 0 : insets.right) + (padded ? theme.space.lg : 0)
        },
        style
      ]}
    />
  )
}
