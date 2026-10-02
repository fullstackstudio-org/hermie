/**
 * The window's floor: one flat colour the glass sits on.
 *
 * It used to be a diagonal ramp plus four or five corner washes, built to imitate
 * the mockup's radial blooms. The owner's verdict on the result was that it looks
 * generated, and the reference he set against it — iPadOS 26 Messages in dark
 * mode — is a near-black field with nothing painted on it at all: everything that
 * reads as depth there comes from the glass in FRONT of the floor, not from the
 * floor. So this is `theme.wallpaper.fill` and nothing else.
 *
 * Still no image assets, for the reason there never were any: a wallpaper shipped
 * as a PNG has to ship at every scale factor for every device, and this is one
 * colour.
 */
import { View, type ViewProps } from 'react-native'

import { useTheme } from '../theme'

/**
 * A plain `View` with the floor's colour under it, so a caller can measure it —
 * the wide shell's chat column is the wallpaper now, and `OverlayPanel` needs
 * that column's real frame rather than an arithmetic guess at it.
 */
export type WallpaperProps = ViewProps

export function Wallpaper({ style, ...rest }: WallpaperProps) {
  const theme = useTheme()

  return <View {...rest} style={[{ backgroundColor: theme.wallpaper.fill }, style]} />
}
