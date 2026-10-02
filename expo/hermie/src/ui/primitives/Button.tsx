import { ActivityIndicator, Pressable, StyleSheet, type PressableProps, View } from 'react-native'

import { useTheme } from '../theme'
import { useHover } from '../useHover'
import { CONTROL_MIN_HEIGHT, withAlpha } from '../tokens'
import { Text } from './Text'

export type ButtonProps = Omit<PressableProps, 'children'> & {
  title: string
  variant?: 'primary' | 'secondary' | 'danger'
  /** Shows a spinner in place of the title and blocks presses. */
  busy?: boolean
}

export function Button({ title, variant = 'primary', busy = false, disabled, style, ...rest }: ButtonProps) {
  const theme = useTheme()
  const hover = useHover()
  const inactive = Boolean(disabled) || busy

  // `danger` is a TINT here, not the solid fill (§3's `.btn--danger`). A sheet
  // whose four answers include one saturated red block reads as a warning about
  // itself and fights its own primary; the readable ink beside the tint is
  // `dangerText`, which is the whole reason those two roles are separate.
  // Primary is the accent's BUBBLE, not its fill. The label is `onAccent` —
  // white — and the bubble is the one accent value white is measured against, so
  // a theme whose fill is a brilliant ring colour (Lime) still gets a button its
  // title can be read on. Same reasoning as the composer's send circle.
  const background =
    variant === 'primary' ? theme.accent().bubble : variant === 'danger' ? theme.dangerSoft : theme.elevation.e3c
  const label = variant === 'primary' ? 'onAccent' : variant === 'danger' ? 'dangerText' : 'text'
  const border = variant === 'primary' ? null : variant === 'danger' ? theme.colors.danger : theme.hairline

  return (
    <Pressable
      accessibilityRole="button"
      aria-busy={busy}
      aria-disabled={inactive}
      disabled={inactive}
      // Every button in the app is a button under a pointer, and a Mac says so with
      // the cursor. React Native 0.81 offers exactly two values, `auto` and
      // `pointer`, so a disabled button falls back to `auto` rather than to an
      // explicit arrow — a pointing hand over something that does nothing is a lie.
      style={[{ cursor: inactive ? 'auto' : 'pointer' }, style as never]}
      {...hover.props}
      {...rest}
    >
      {({ pressed }) => (
        <View
          style={{
            backgroundColor: background,
            borderRadius: theme.radii.inset,
            borderWidth: border ? 1 : 0,
            // The danger tint's own edge is the danger colour at low alpha: the
            // tint alone is too faint to read as a button on a light sheet.
            borderColor: border === theme.colors.danger ? withAlpha(theme.colors.danger, 0.34) : (border ?? undefined),
            minHeight: CONTROL_MIN_HEIGHT,
            paddingVertical: theme.space.md,
            paddingHorizontal: theme.space.lg,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: inactive ? 0.4 : pressed ? 0.85 : 1
          }}
        >
          {/*
            The pointer's answer to the cursor above.

            A WASH laid over whatever the button already is, rather than a second
            set of background colours per variant: the three variants are a
            saturated accent bubble, a danger tint and a neutral rung, and one
            hover colour that works on all three has to be translucent. It also
            keeps the button's own recipe in one place — a hovered primary is the
            primary, plus a film.

            Off while inactive, for the same reason the cursor is: a control that
            lights up under the pointer and then does nothing is a lie the cursor
            has already been taught not to tell.
          */}
          {hover.hovered && !inactive ? (
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, { backgroundColor: theme.tintHover, borderRadius: theme.radii.inset }]}
            />
          ) : null}

          {busy ? (
            <ActivityIndicator color={variant === 'primary' ? theme.colors.onAccent : theme.colors.text} />
          ) : (
            <Text variant="name" color={label}>
              {title}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  )
}
