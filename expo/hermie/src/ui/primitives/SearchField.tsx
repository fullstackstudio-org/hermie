/**
 * The app's search field: a sunk pill with a magnifier in it.
 *
 * It was `BotsScreen`'s own private component until the Settings sidebar grew a
 * field of its own, and a second copy of a control whose whole content is three
 * alignment rules would have been a second set of rules to keep in step. One
 * component, two callers, and each keeps its own `testID` so the suites that
 * know a field by name still find it.
 *
 * ## The rule for any field with a leading icon
 *
 * The icon and the placeholder have to sit on ONE centre line, and getting there
 * takes three things that all have to be said out loud:
 *
 *  - **The icon's SLOT is the text line's height, not the mark's size.** An
 *    `Icon size={15}` with no slot is a 15pt box; the text line beside it is 20pt.
 *    Two boxes of different heights, both centred in a 44pt row, centre at the same
 *    y — but only while nothing else moves either of them, which is what the next
 *    two points are about. Giving the icon the line's own box makes the alignment a
 *    property of the pair rather than a coincidence of the row.
 *  - **The line height is explicit.** Without it the field's text box is whatever
 *    the platform's font metrics make it, which is not the 20pt the icon was sized
 *    against and differs between iOS and Android.
 *  - **`paddingVertical: 0`.** iOS adds a vertical inset of its own to a
 *    `TextInput` on top of whatever the style asks for. That inset is not symmetric,
 *    and it is the whole reason the placeholder sat a point or two below the
 *    magnifier: the icon was centred and the text was centred-plus-an-inset. The
 *    44pt tap target moves to the ROW, where it belongs — it is a property of the
 *    control, not of the text inside it.
 */
import { TextInput, View, type StyleProp, type ViewStyle } from 'react-native'

import { Icon, ICON_SIZE } from '../Icon'
import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT } from '../tokens'
import { useFocusRing } from '../useFocusRing'

export interface SearchFieldProps {
  /** Placeholder and accessible name: they are the same words for a search box. */
  label: string
  value: string
  onChangeText: (value: string) => void
  /** Return in a search field opens the first match, where the caller has one. */
  onSubmit?: () => void
  inputRef?: React.RefObject<TextInput | null>
  /** The pill's own margins, which differ between a list header and a form column. */
  style?: StyleProp<ViewStyle>
  /** The INPUT's id. The pill takes `${testID}-field` and the mark `${testID}-icon`. */
  testID: string
}

export function SearchField({ label, value, onChangeText, onSubmit, inputRef, style, testID }: SearchFieldProps) {
  const theme = useTheme()
  // One token for the size AND its leading, so the icon's slot and the text's line
  // box cannot be derived from two different numbers.
  const line = theme.type.preview
  /*
    The ring belongs to the PILL, and that is the whole of the browser report.

    A browser rings the `<input>`, which here is a 20pt text line sitting inside
    a 44pt pill — so the focus indicator was a small square-cornered rectangle
    floating in the middle of the control, in the system's accent rather than
    the theme's. `useFocusRing` suppresses that one on the input and draws the
    app's own on this view; on iOS and Android both halves are no-ops.
  */
  const focus = useFocusRing()

  return (
    <View
      style={[
        {
          alignItems: 'center',
          backgroundColor: theme.tintSunk,
          borderColor: theme.hairlineSoft,
          borderRadius: theme.radii.pill,
          borderWidth: 1,
          flexDirection: 'row',
          gap: theme.space.sm,
          minHeight: CONTROL_MIN_HEIGHT,
          paddingHorizontal: theme.space.md,
          ...focus.ringStyle
        },
        style
      ]}
      testID={`${testID}-field`}
    >
      <Icon
        color={theme.colors.textFaint}
        name="search"
        size={ICON_SIZE.inline}
        slot={line.lineHeight}
        testID={`${testID}-icon`}
      />
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        onBlur={focus.fieldProps.onBlur}
        onChangeText={onChangeText}
        onFocus={focus.fieldProps.onFocus}
        placeholder={label}
        placeholderTextColor={theme.colors.textFaint}
        ref={inputRef}
        returnKeyType="go"
        style={[
          {
            /*
              The input fills the pill's HEIGHT as well as its width.

              `alignSelf: 'stretch'` with the text centred in it, rather than a
              20pt line box parked in the middle of a 44pt control: on the web a
              form control is a real hit target, and a 20pt one meant the bottom
              and top thirds of the search field did nothing when clicked. On
              iOS and Android the row was always the target, so this changes
              only where a pointer may land.
            */
            alignSelf: 'stretch',
            color: theme.colors.text,
            flex: 1,
            fontSize: line.fontSize,
            lineHeight: line.lineHeight,
            paddingVertical: 0
          },
          focus.fieldProps.style
        ]}
        testID={testID}
        value={value}
        {...(onSubmit ? { onSubmitEditing: onSubmit } : {})}
      />
    </View>
  )
}
