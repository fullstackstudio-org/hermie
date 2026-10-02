/**
 * The circular initial the design board uses wherever a bot appears.
 *
 * The tint is derived from the name, so a bot keeps the same colour in the
 * chat list, the header and a forwarded DM without anyone persisting one.
 *
 * **The tint has to separate the circle from the PANEL, not only the initial
 * from the circle.** Those are two different measurements and only the second
 * one was ever made. The first palette cleared 5.4 : 1 for its letters and then
 * put the circle itself 1.02–1.20 : 1 from the glass behind it, so on an iPad
 * the avatars read as faint smudges with a letter floating in them — reported
 * as "washed out", and easy to mistake for a missing accent ring. It is not the
 * ring: §1.3 gives the ring to the eight per-chat colours and withholds it from
 * Default on purpose, so a Default chat correctly has none. The numbers below
 * are circle-against-panel (`elevation.e1`, the rung the sidebar panel sits on)
 * and initial-against-circle:
 *
 *   light  separation 1.38–1.51,  initial 5.73–6.47
 *   dark   separation 1.45–1.67,  initial 6.59–7.05
 *
 * `npm run contrast:check` does NOT cover these — it reads composited surfaces
 * out of `tokens.ts`, and an avatar tint is neither a surface nor a token — so
 * changing one means measuring it by hand.
 */
import { useEffect, useState } from 'react'
import { Image, View, type ImageStyle, type ViewStyle } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { initialFor, tintIndex } from '../format'

const LIGHT_TINTS = [
  { background: '#B9D8F7', foreground: '#0E477F' },
  { background: '#D6C4F3', foreground: '#53307B' },
  { background: '#B4DDD1', foreground: '#1A4E3B' },
  { background: '#EFCB9C', foreground: '#6B4113' }
]

const DARK_TINTS = [
  { background: '#2A4E76', foreground: '#CFE4FB' },
  { background: '#4A3975', foreground: '#E0CEFA' },
  { background: '#245244', foreground: '#BEE9D4' },
  { background: '#5C4222', foreground: '#F7DCBC' }
]

export interface AvatarProps {
  name: string
  size?: number
  style?: ViewStyle
  /**
   * The profile's own picture, as the data URL `profiles.get_asset` returns.
   * Absent or unloadable falls back to the derived initial, so a bot never
   * shows an empty circle while its asset is still being fetched.
   */
  uri?: string
  /**
   * What the circle's tint is keyed on, when that has to be something other
   * than `name`. Defaults to `name`, which is every caller before HERM-83: a
   * bot's own circle has always been keyed on the one name it is drawn with.
   *
   * A group-chat sender's avatar passes `author.id` instead — the identity,
   * not the display name a person can change — so a rename cannot recolour
   * their circle and two people who happen to share a name cannot share one
   * (D5). The circle's own 4-tint palette is untouched either way; only what
   * picks a slot from it moves.
   */
  tintKey?: string
  testID?: string
}

export function Avatar({ name, size = 40, style, uri, tintKey, testID }: AvatarProps) {
  const theme = useTheme()
  const palette = theme.scheme === 'dark' ? DARK_TINTS : LIGHT_TINTS
  const tint = palette[tintIndex(tintKey ?? name, palette.length)] ?? palette[0]
  const [broken, setBroken] = useState(false)

  useEffect(() => {
    setBroken(false)
  }, [uri])

  if (uri && !broken) {
    return (
      <Image
        accessibilityElementsHidden
        // `aria-hidden` is the web's spelling of the two props around it; react-native-web
        // honours neither of those. See `ui/Icon.tsx`.
        aria-hidden
        importantForAccessibility="no-hide-descendants"
        onError={() => setBroken(true)}
        source={{ uri }}
        style={[
          { backgroundColor: tint?.background, borderRadius: size / 2, height: size, width: size },
          style as ImageStyle
        ]}
        testID={testID}
      />
    )
  }

  return (
    <View
      accessibilityElementsHidden
      // `aria-hidden` is the web's spelling of the two props around it; react-native-web
      // honours neither of those. See `ui/Icon.tsx`.
      aria-hidden
      importantForAccessibility="no-hide-descendants"
      style={[
        {
          alignItems: 'center',
          backgroundColor: tint?.background,
          borderRadius: size / 2,
          height: size,
          justifyContent: 'center',
          width: size
        },
        style
      ]}
      testID={testID}
    >
      <Text style={{ color: tint?.foreground, fontSize: Math.round(size * 0.44), fontWeight: '600' }}>
        {initialFor(name)}
      </Text>
    </View>
  )
}
