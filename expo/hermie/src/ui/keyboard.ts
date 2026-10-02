/**
 * How a `KeyboardAvoidingView` behaves in this app: `padding`, everywhere.
 *
 * `padding` on Android too, deliberately. The old `Platform.OS === 'ios' ?
 * 'padding' : undefined` leaned on `android:windowSoftInputMode="adjustResize"`
 * to lift the window, and under the edge-to-edge layout Expo SDK 54 turns on by
 * default that resize no longer happens: the window frame stays the full screen
 * with the keyboard up, so nothing moved and the composer sat behind the
 * keyboard. `padding` makes React Native do the work itself, from the
 * `keyboardDidShow` metrics, which arrive on both platforms.
 *
 * One constant rather than the literal at each of the four call sites, because
 * the reason above is what a reader needs and it belongs in one place.
 */
export const KEYBOARD_AVOID_BEHAVIOR = 'padding' as const
