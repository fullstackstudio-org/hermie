import { forwardRef } from 'react'
import { TextInput, type TextInputProps, View } from 'react-native'

import { INVALID_FIELD, NO_USER_AGENT_FOCUS_RING } from '../../platform/text-field-web'
import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT } from '../tokens'
import { useInsetRow } from './InsetGroup'
import { Text } from './Text'

export type TextFieldProps = TextInputProps & {
  /** Quiet label above the input, inside the row. */
  label?: string
  /**
   * Shown under the input in the danger colour, and marks the input invalid.
   *
   * The colour is not the whole message: `INVALID_FIELD` puts `aria-invalid` on
   * the control where the platform has such a thing, so a reader is told the
   * field is wrong rather than being shown a red line it cannot see.
   */
  error?: string | null
}

/**
 * The app's one text field.
 *
 * It draws the sunk well the design board gives every editable thing — a level
 * tint, a hairline and the inset radius — because without it a field on a sheet
 * is placeholder text floating on glass, which is exactly how the cron editor's
 * Name, Instructions and Every fields read on a device. The hairline is the part
 * that says "editable": the tint alone is nearly invisible on the light panel.
 *
 * Inside an `InsetRow` it draws none of that, because the row IS the chrome and
 * two boxes around one input is worse than none. That is read from the row
 * rather than passed, so a caller cannot forget it in either direction.
 *
 * A plain `TextInput` underneath — no masking, no formatting — so every caller
 * keeps control of `autoCapitalize`, `keyboardType` and `textContentType`, which
 * the platform uses to decide what keyboard and which autofill to offer.
 */
export const TextField = forwardRef<TextInput, TextFieldProps>(function TextField(
  { label, error, style, ...rest },
  ref
) {
  const theme = useTheme()
  const inset = useInsetRow()

  return (
    <View style={{ gap: theme.space.xxs }}>
      {label ? (
        <Text variant="meta" color="textMuted">
          {label}
        </Text>
      ) : null}
      <TextInput
        ref={ref}
        /*
         * No `?? ''` at the end of this chain. An `aria-label=""` REMOVES a
         * name rather than falling through to whatever the browser would have
         * computed, so a field with neither label nor placeholder shipped with
         * its name deliberately erased. `undefined` leaves the attribute off.
         */
        accessibilityLabel={label ?? rest.accessibilityLabel ?? rest.placeholder}
        placeholderTextColor={theme.colors.textMuted}
        style={[
          /*
           * No ring around the field, on any platform.
           *
           * The document's own rule exempts every input from `:focus-visible`
           * already, so this is the second of two — and it is here rather than
           * only there because a component that decides how a field looks
           * should be where somebody reads what it decided. A caret is the
           * focus indication a text box has; see `ui/useFocusRing.ts` for the
           * whole argument, and for why buttons and links still ring.
           */
          NO_USER_AGENT_FOCUS_RING,
          {
            color: theme.colors.text,
            fontSize: theme.type.body.fontSize,
            lineHeight: theme.type.body.lineHeight,
            minHeight: CONTROL_MIN_HEIGHT - theme.space.lg,
            paddingVertical: theme.space.xs
          },
          inset
            ? null
            : {
                backgroundColor: theme.tintSunk,
                borderColor: error ? theme.colors.danger : theme.hairline,
                borderRadius: theme.radii.inset,
                borderWidth: 1,
                minHeight: CONTROL_MIN_HEIGHT - theme.space.sm,
                paddingHorizontal: theme.space.sm,
                paddingVertical: theme.space.sm
              },
          style
        ]}
        {...(error ? INVALID_FIELD : null)}
        {...rest}
      />
      {error ? (
        <Text variant="meta" color="dangerText">
          {error}
        </Text>
      ) : null}
    </View>
  )
})
