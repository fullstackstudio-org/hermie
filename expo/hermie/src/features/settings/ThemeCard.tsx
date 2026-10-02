/**
 * One theme, as the thing it is rather than as its name.
 *
 * A row reading "Graphite" tells a reader nothing they can check: the only
 * question anybody has in front of a theme picker is what the window will look
 * like, and the honest answer is a picture of the window. So each card paints the
 * theme's floor, a panel of its own glass over it, and a PAIR of bubbles — an
 * incoming one off its elevation ladder and an outgoing one in its accent — which
 * between them contain every decision a preset makes.
 *
 * The card resolves its own theme through `resolveThemeFace`, the same function
 * `buildTheme` uses, rather than being handed colours. That is what keeps the
 * preview honest: there is no second description of a theme that could disagree
 * with the first.
 *
 * The scheme shown is the one that is ON, not both. A picker showing every theme
 * in both faces is twelve tiles and a decision nobody was asked to make; the
 * segmented control above it is what chooses the face, and the cards follow it.
 */
import { Pressable, View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { glassFor, resolveThemeFace, type ThemeChoice, type UserTheme } from '../../ui/themes'
import { HAIRLINE_SOFT, radii, space, withAlpha, type Scheme } from '../../ui/tokens'

export const THEME_CARD = { width: 148, preview: 92 } as const

export interface ThemeCardProps {
  label: string
  choice: ThemeChoice
  scheme: Scheme
  selected: boolean
  onPress: () => void
  userThemes: readonly UserTheme[]
  testID?: string
}

export function ThemeCard({ label, choice, scheme, selected, onPress, userThemes, testID }: ThemeCardProps) {
  const theme = useTheme()
  const face = resolveThemeFace(choice, scheme, userThemes)
  const glass = glassFor(scheme, face.elevation)

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="radio"
      // A radio reports `aria-checked`; `aria-selected` is not a property this
      // role has, and a browser ignores it.
      aria-checked={selected}
      onPress={onPress}
      style={{ gap: space.sm, width: THEME_CARD.width }}
      testID={testID}
    >
      <View
        style={{
          backgroundColor: face.background,
          // The selected card is ringed in the app's own ink rather than in the
          // theme's accent: the ring has to be legible against SIX different
          // floors, and the one colour guaranteed to read on all of them is the
          // one the surrounding screen is already using for its words.
          borderColor: selected ? theme.colors.text : theme.hairline,
          borderRadius: radii.card,
          borderWidth: selected ? 3 : 1,
          gap: space.sm,
          height: THEME_CARD.preview,
          justifyContent: 'center',
          overflow: 'hidden',
          padding: space.sm
        }}
        testID={testID ? `${testID}-preview` : undefined}
      >
        {/* The panel, so the card shows the ladder and not only the floor. */}
        <View
          style={{
            backgroundColor: glass.panel.solid,
            borderColor: HAIRLINE_SOFT[scheme],
            borderRadius: radii.md,
            borderWidth: 1,
            gap: 6,
            padding: space.sm
          }}
        >
          <View
            style={{
              alignSelf: 'flex-start',
              backgroundColor: glassFor(scheme, face.elevation).card.solid,
              borderRadius: radii.sm,
              height: 12,
              width: '62%'
            }}
          />
          <View
            style={{
              alignSelf: 'flex-end',
              backgroundColor: face.accentSwatch.bubble,
              borderRadius: radii.sm,
              height: 12,
              width: '46%'
            }}
          />
        </View>

        {/* The ring colour, which is the half of the accent the bubbles never show. */}
        <View
          style={{
            alignSelf: 'flex-start',
            backgroundColor: withAlpha(face.accentSwatch.fill, 1),
            borderRadius: 5,
            height: 10,
            width: 10
          }}
        />
      </View>

      <Text color={selected ? 'text' : 'textMuted'} numberOfLines={1} variant="meta">
        {label}
      </Text>
    </Pressable>
  )
}
