/**
 * The grouped-row controls a settings sheet needs: a switch, a segmented
 * control and a disclosure row.
 *
 * They are built from `Pressable` and `Animated` rather than from the platform
 * `Switch`/`SegmentedControl`, for the same reason the bottom sheet is: iOS and
 * Android do not share one set of those, and a control that looks different on
 * each would undo the point of having tokens.
 */
import { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, View, type LayoutChangeEvent, type TextStyle } from 'react-native'

import { durationFor, easing } from '../motion'
import { Text } from '../primitives'
import { useTheme } from '../theme'
import { Icon, ICON_SIZE } from '../Icon'
import { CONTROL_MIN_HEIGHT } from '../tokens'

/**
 * §3's `.sw`: a 51 × 31 track and a 27pt knob sitting 2pt inside it.
 *
 * `inset` is 1 rather than 2 because the hairline is a real 1pt BORDER here and
 * the mockup's is an inset box-shadow, which costs no layout. Border plus
 * padding is the 2pt the mockup insets by, which is what keeps the travel at 20.
 */
const SWITCH = { width: 51, track: 31, knob: 27, inset: 1, travel: 20 } as const

export interface SwitchRowProps {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
  testID?: string
}

export function SwitchRow({ label, hint, value, onChange, disabled = false, testID }: SwitchRowProps) {
  const theme = useTheme()
  const knob = useRef(new Animated.Value(value ? 1 : 0)).current

  // The knob was the one animation in the app that ignored Reduce Motion, and the
  // one with no curve — a switch is a value moving between two states while
  // staying put, which is what `standard` is for. The driver stays on the
  // JavaScript side: the knob's travel is `left`, not a transform.
  useEffect(() => {
    const animation = Animated.timing(knob, {
      duration: durationFor('control', theme.reduceMotion),
      easing: easing.standard,
      toValue: value ? 1 : 0,
      useNativeDriver: false
    })

    animation.start()

    return () => animation.stop()
  }, [knob, theme.reduceMotion, value])

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="switch"
      aria-checked={value}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onChange(!value)}
      testID={testID}
    >
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.md,
          minHeight: CONTROL_MIN_HEIGHT,
          opacity: disabled ? 0.4 : 1,
          paddingHorizontal: theme.space.lg,
          paddingVertical: theme.space.sm
        }}
      >
        <View style={{ flex: 1 }}>
          <Text variant="body">{label}</Text>
          {hint ? (
            <Text color="textMuted" variant="meta">
              {hint}
            </Text>
          ) : null}
        </View>

        {/*
          Off is the SUNK tint with a hairline, not a grey fill (§3's `.sw`). A
          mid-grey track reads as a third state somewhere between on and
          disabled, and on a dark sheet it was the brightest thing in the row.
        */}
        <View
          style={{
            backgroundColor: value ? theme.colors.ok : theme.tintSunk,
            borderColor: value ? 'transparent' : theme.hairlineSoft,
            borderRadius: SWITCH.track / 2,
            borderWidth: 1,
            height: SWITCH.track,
            justifyContent: 'center',
            paddingHorizontal: SWITCH.inset,
            width: SWITCH.width
          }}
        >
          <Animated.View
            style={{
              backgroundColor: '#FFFFFF',
              borderRadius: SWITCH.knob / 2,
              height: SWITCH.knob,
              shadowColor: '#0A1E46',
              shadowOffset: { height: 2, width: 0 },
              shadowOpacity: 0.3,
              shadowRadius: 5,
              transform: [{ translateX: knob.interpolate({ inputRange: [0, 1], outputRange: [0, SWITCH.travel] }) }],
              width: SWITCH.knob
            }}
          />
        </View>
      </View>
    </Pressable>
  )
}

export interface SegmentedRowProps<T extends string> {
  label?: string
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
  /** Greyed out and unresponsive — a choice that another setting has made moot. */
  disabled?: boolean
  testID?: string
}

/**
 * `word-wrap: break-word` is React Native Web's own default for every `Text`
 * (`react-native-web/dist/exports/Text`) — native RN Text can break a word
 * mid-way to stay inside a fixed box, and the web target matches that. A
 * segment that falls back to a second line (HERM-125) wants the opposite: a
 * break at a SPACE if there is one, and otherwise a single word that overflows
 * rather than one split into "Standaa" / "rd".
 *
 * `wordWrap` — the property RNW's default sets — is not part of React
 * Native's own `TextStyle`; the value exists only on this platform. The cast
 * is the one `text-field-web.web.ts` already uses for `outlineStyle: 'none'`,
 * for the same reason: the web target's own wider value set, admitted once,
 * next to why.
 */
const KEEP_WORDS_WHOLE = { wordWrap: 'normal' } as unknown as TextStyle

/**
 * A segment's box at one line — `minHeight` below, and the floor a taller,
 * wrapped box is measured against.
 */
const SEGMENT_ONE_LINE_HEIGHT = 30

export function SegmentedRow<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  testID
}: SegmentedRowProps<T>) {
  const theme = useTheme()

  /**
   * Whether ANY segment has wrapped onto a second line.
   *
   * HERM-125's last resort, not the common case now that a segment is sized
   * to its own label rather than splitting the row evenly (the Pressable's
   * `flexBasis` below) — "Klein" gives room to "Standaard" instead of both
   * getting a quarter of the row regardless of what they say.
   *
   * Measured with `onLayout` rather than `onTextLayout`: react-native-web
   * does not implement `onTextLayout` at all, so a check built on it would
   * never fire on the web target and the control would never square off
   * there. A box's HEIGHT growing past the one-line floor is the same fact
   * on every platform `onLayout` runs on.
   *
   * The whole control's radius adapts together, rather than one squared-off
   * segment sitting next to three still fully round ones — a segmented
   * control reads as one object, and a row of mismatched corners would read
   * as two controls glued together.
   */
  const wrappedSegments = useRef<Set<T>>(new Set())
  const [wrapped, setWrapped] = useState(false)

  const handleSegmentLayout = (optionValue: T) => (event: LayoutChangeEvent) => {
    const isWrapped = event.nativeEvent.layout.height > SEGMENT_ONE_LINE_HEIGHT + 1
    const segments = wrappedSegments.current

    if (isWrapped === segments.has(optionValue)) {
      return
    }

    if (isWrapped) {
      segments.add(optionValue)
    } else {
      segments.delete(optionValue)
    }

    setWrapped(segments.size > 0)
  }

  // `radii.inset` — the token the design system itself names for "a field, a
  // segment, a tab slot" — rather than the fully round `radii.pill`: a pill
  // whose box has grown taller for a second line stops reading as a pill and
  // starts reading as an egg, one segment at a time. Squaring the corners off
  // is the fix that stays a rectangle at any height.
  const radius = wrapped ? theme.radii.inset : theme.radii.pill

  return (
    <View
      style={{
        gap: theme.space.sm,
        opacity: disabled ? 0.4 : 1,
        paddingHorizontal: theme.space.lg,
        paddingVertical: theme.space.sm
      }}
    >
      {label ? (
        <Text color="textMuted" variant="meta">
          {label}
        </Text>
      ) : null}

      {/*
        §3's `.seg`: a sunk track with a hairline, and the SELECTED segment
        raised onto `e4` — the control rung — with its own hairline and a small
        shadow. The selected label is `text`, not the accent: an accent-coloured
        segment on a raised slab says "link" twice and left the unselected ones
        looking disabled by comparison.
      */}
      <View
        accessibilityRole="radiogroup"
        style={{
          backgroundColor: theme.tintSunk,
          borderColor: theme.hairlineSoft,
          borderRadius: radius,
          borderWidth: 1,
          flexDirection: 'row',
          gap: 2,
          padding: 2
        }}
        testID={testID}
      >
        {options.map(option => {
          const selected = option.value === value

          return (
            <Pressable
              accessibilityRole="radio"
              aria-checked={selected}
              aria-disabled={disabled}
              disabled={disabled}
              key={option.value}
              onPress={() => onChange(option.value)}
              // HERM-125: sized to the LABEL, not to an equal quarter of the
              // row. `flexBasis: 'auto'` is the label's own rendered width —
              // "Klein" asks for less than "Standaard" does — `flexGrow: 1`
              // still hands out whatever room is left over evenly, so the row
              // keeps filling edge to edge, and `flexShrink: 1` means a real
              // squeeze takes width from the LONGEST labels first (shrink is
              // proportional to basis), which is the one order that keeps
              // "Klein" whole the longest.
              style={{ flexBasis: 'auto', flexGrow: 1, flexShrink: 1 }}
              testID={testID ? `${testID}-${option.value}` : undefined}
            >
              <View
                onLayout={handleSegmentLayout(option.value)}
                style={{
                  alignItems: 'center',
                  backgroundColor: selected ? theme.elevation.e4 : 'transparent',
                  borderColor: selected ? theme.hairlineSoft : 'transparent',
                  borderRadius: radius,
                  borderWidth: 1,
                  justifyContent: 'center',
                  minHeight: SEGMENT_ONE_LINE_HEIGHT,
                  ...(selected ? theme.shadows.card : {})
                }}
              >
                {/*
                  HERM-125: a label that still does not fit — after content
                  sizing has already given it all the room its neighbours can
                  spare — wraps onto a second line as the LAST resort, rather
                  than the fixed single line that clipped "Standaard" to
                  "Standaa…". `KEEP_WORDS_WHOLE` keeps that wrap at a space:
                  without it, "Extra groot" could wrap correctly while a
                  single word too wide for its box — the case with no space to
                  break at — would still be split mid-word instead of
                  overflowing whole.
                */}
                <Text
                  color={selected ? 'text' : 'textMuted'}
                  numberOfLines={2}
                  style={[{ fontSize: 13, fontWeight: '600', lineHeight: 17, textAlign: 'center' }, KEEP_WORDS_WHOLE]}
                >
                  {option.label}
                </Text>
              </View>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

export interface DisclosureRowProps {
  label: string
  value?: string
  onPress: () => void
  testID?: string
}

export function DisclosureRow({ label, value, onPress, testID }: DisclosureRowProps) {
  const theme = useTheme()

  return (
    <Pressable accessibilityRole="button" onPress={onPress} testID={testID}>
      {({ pressed }) => (
        <View
          style={{
            alignItems: 'center',
            backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
            flexDirection: 'row',
            gap: theme.space.sm,
            minHeight: CONTROL_MIN_HEIGHT,
            paddingHorizontal: theme.space.lg,
            paddingVertical: theme.space.sm
          }}
        >
          <Text style={{ flex: 1 }}>{label}</Text>
          {value ? (
            <Text color="textMuted" numberOfLines={1} style={{ maxWidth: '55%' }}>
              {value}
            </Text>
          ) : null}
          <Icon color={theme.colors.textMuted} name="chevronRight" size={ICON_SIZE.inline} />
        </View>
      )}
    </Pressable>
  )
}
