/**
 * A text field for a value that should not sit on screen in plain sight — a
 * session token, a proxy header's value — with a reveal control beside it.
 *
 * It was born as a workaround: on react-native-macos a `secureTextEntry`
 * `TextInput` rendered the dots but never fired `onChangeText`, so masking had
 * to be switched off there and the toggle was the replacement. That platform is
 * gone (ADR-0011) and masking is on everywhere again, but the toggle stays: a
 * token pasted into a field you cannot read is a token you cannot check, and
 * whether it is on screen should be the reader's call rather than the form's.
 *
 * Any new masked field goes through here. A bare `secureTextEntry` is a field
 * with no way to check what landed in it.
 *
 * The toggle is a `Pressable` with a word in it, not an icon button: the app
 * ships no vector icon set, and a word is unambiguous in a form.
 */
import { forwardRef, useState } from 'react'
import { Pressable, type TextInput, View } from 'react-native'

import { useTheme } from '../theme'
import { Text } from './Text'
import { TextField, type TextFieldProps } from './TextField'

export type SecretFieldProps = Omit<TextFieldProps, 'secureTextEntry'> & {
  /** Label for the reveal control, e.g. "Show token". */
  revealLabel: string
  /** Label once revealed, e.g. "Hide token". */
  concealLabel: string
}

export const SecretField = forwardRef<TextInput, SecretFieldProps>(function SecretField(
  { revealLabel, concealLabel, ...rest },
  ref
) {
  const theme = useTheme()
  const [revealed, setRevealed] = useState(false)

  return (
    <View style={{ gap: theme.space.xs }}>
      <TextField {...rest} ref={ref} secureTextEntry={!revealed} />
      <Pressable
        accessibilityRole="button"
        aria-checked={revealed}
        hitSlop={8}
        onPress={() => setRevealed(current => !current)}
        style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}
        testID={rest.testID ? `${rest.testID}-reveal` : 'secret-reveal'}
      >
        <Text color="accentText" variant="meta">
          {revealed ? concealLabel : revealLabel}
        </Text>
      </Pressable>
    </View>
  )
})
