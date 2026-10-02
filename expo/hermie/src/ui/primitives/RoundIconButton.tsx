/**
 * One round button with one mark in the middle of it.
 *
 * Every circular control in the app is this shape — the header's back, sidebar
 * and options, the chat list's new-cron, the composer's `+` and its send — and
 * before this they were five copies of it. The copies did not differ in
 * intention; they differed in how the mark was drawn, and that is exactly where
 * the defects were:
 *
 *  - two of them typed a CHARACTER (`+`, `↑`) instead of drawing a path, so the
 *    mark was centred by its line box while its ink sat wherever the font's
 *    ascent and descent put it. In a browser both read visibly low in their
 *    circles. `src/ui/Icon.tsx` has the longer version of this argument — it is
 *    the same one that took the glyphs out of the tab strip;
 *  - the circle and the pressable were sized independently in each copy, so
 *    "the mark is centred" was five separate claims rather than one.
 *
 * Here it is one claim: the `Pressable` IS the circle, it centres its child,
 * and the child is an `Icon`, which centres a path inside a square slot. There
 * is nothing left for a caller to get wrong, and nothing left to check five
 * times.
 *
 * Two fills, because there are two kinds of round button. `glass` is the
 * default — a `GlassSurface` that iOS 26 may merge with its neighbours — and
 * `solid` is the one primary action per surface, which carries a colour of its
 * own and a shadow to float it.
 */
import { Pressable, View } from 'react-native'

import { GlassSurface } from '../glass'
import { Icon, ICON_SIZE, type IconName } from '../Icon'
import { useTheme } from '../theme'
import { TAP_SLOP } from '../tokens'

export interface RoundIconButtonProps {
  icon: IconName
  /** Read out instead of the mark; the mark itself is decorative. */
  label: string
  onPress: () => void
  /** The circle's diameter. `CONTROL_SIZE.regular` or `.compact`. */
  size: number
  /** Glass by default; `solid` is the one primary action. */
  fill?: 'glass' | 'solid'
  /** The `solid` circle's colour. Ignored by `glass`. */
  color?: string
  /** The mark's colour. Defaults to the accent ink on glass, `onAccent` on solid. */
  tint?: string
  /**
   * Lay the control's solid rung under the glass, for a button that floats
   * over CONTENT rather than sitting on a panel.
   *
   * The chat's chrome is the case that needs it: the transcript scrolls
   * underneath, so the backdrop is whichever bubble is passing behind the
   * button at that moment, and at the control wash's own alpha that bubble's
   * words come through the circle. Same rule, same reason, as the header pill
   * and `AttachMenu`. Ignored by `solid`, which paints its own colour.
   */
  opaque?: boolean
  disabled?: boolean
  /** Announced on the button; a menu button is `expanded`. */
  expanded?: boolean
  testID?: string
}

export function RoundIconButton({
  icon,
  label,
  onPress,
  size,
  fill = 'glass',
  color,
  tint,
  opaque = false,
  disabled = false,
  expanded,
  testID
}: RoundIconButtonProps) {
  const theme = useTheme()
  const solid = fill === 'solid'
  const mark = tint ?? (solid ? theme.colors.onAccent : theme.colors.accentText)

  const button = (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      aria-disabled={disabled}
      // Absent rather than false when the button is not a disclosure: a button
      // that reports `aria-expanded="false"` claims to control something that
      // is currently closed, and most of these control nothing.
      {...(expanded === undefined ? {} : { 'aria-expanded': expanded })}
      disabled={disabled}
      hitSlop={TAP_SLOP}
      onPress={onPress}
      style={({ pressed }) => ({
        alignItems: 'center',
        borderRadius: size / 2,
        height: size,
        justifyContent: 'center',
        opacity: disabled ? 0.3 : pressed ? 0.6 : 1,
        width: size,
        ...(solid
          ? {
              backgroundColor: color ?? theme.accent().bubble,
              // No shadow while it is dimmed. Android draws an elevation shadow
              // BEHIND the view and clips nothing, so at a low opacity the fill
              // stops hiding it and the shadow's own octagonal outline reads
              // straight through the circle. A disabled control has nothing to
              // float above either way.
              ...(disabled ? {} : theme.shadows.card)
            }
          : {})
      })}
      testID={testID}
    >
      <Icon color={mark} name={icon} size={ICON_SIZE.control} slot={size} />
    </Pressable>
  )

  if (!solid) {
    return (
      <GlassSurface
        interactive
        opaque={opaque}
        radius={size / 2}
        shadow="card"
        style={{ height: size, width: size }}
        contentTestID={testID ? `${testID}-surface` : undefined}
        variant="control"
      >
        {button}
      </GlassSurface>
    )
  }

  // A plain wrapper so both fills present the same box to a row that lays them
  // out, whatever the glass variant decides to wrap itself in.
  return <View style={{ height: size, width: size }}>{button}</View>
}
