/**
 * Settings → Appearance → Language.
 *
 * A column of rows rather than the segmented control the three settings above
 * it use, and the reason is measurable: the segmented track is one row wide
 * split evenly, which on a 375pt phone leaves roughly 80pt a segment. "Follow
 * device" does not fit in 80pt at 13pt semibold, and `numberOfLines={1}` would
 * clip it rather than wrap. A four-way choice where one label is two words is
 * the case a segmented control is not for.
 *
 * The three language names are NOT translated — see `LANGUAGE_ENDONYMS`. A
 * reader hunting for their own language is hunting for the word they use for
 * it; "Dutch" on a Dutch screen would be the one row a Dutch reader scrolls
 * past.
 */
import { Pressable, View } from 'react-native'

import { strings } from '../../i18n/strings'
import { LANGUAGE_ENDONYMS, LOCALES, type LanguageChoice } from '../../i18n/locales'
import { useLanguageStore } from '../../store/language'
import { InsetGroup, Text } from '../../ui/primitives'
import { CONTROL_MIN_HEIGHT } from '../../ui/tokens'
import { useTheme } from '../../ui/theme'

/** The rows, in order: the standing instruction first, then the three pins. */
function options(): { value: LanguageChoice; label: string }[] {
  return [
    { value: 'system', label: strings.settings.languageFollowDevice },
    ...LOCALES.map(locale => ({ value: locale as LanguageChoice, label: LANGUAGE_ENDONYMS[locale] }))
  ]
}

export function LanguageGroup() {
  const theme = useTheme()
  const choice = useLanguageStore(state => state.choice)
  const setChoice = useLanguageStore(state => state.setChoice)

  return (
    <InsetGroup
      accessibilityRole="radiogroup"
      footer={strings.settings.languageHint}
      header={strings.settings.language}
      testID="settings-language"
    >
      {options().map(option => {
        const selected = option.value === choice

        return (
          <Pressable
            accessibilityRole="radio"
            aria-checked={selected}
            key={option.value}
            onPress={() => setChoice(option.value)}
            testID={`settings-language-${option.value}`}
          >
            {({ pressed }) => (
              <View
                style={{
                  alignItems: 'center',
                  backgroundColor: pressed ? theme.elevation.e2 : 'transparent',
                  flexDirection: 'row',
                  gap: theme.space.md,
                  minHeight: CONTROL_MIN_HEIGHT,
                  paddingHorizontal: theme.space.lg,
                  paddingVertical: theme.space.sm
                }}
              >
                <Text style={{ flex: 1 }} variant="body">
                  {option.label}
                </Text>
                {/*
                  A tick rather than a filled radio, which is how the platform
                  marks the chosen row in a grouped list — and it is drawn in
                  the floored accent INK rather than the accent swatch, for the
                  reason `toneInk` exists: on Graphite the swatch is a grey
                  barely off the card under it.
                */}
                {selected ? (
                  <Text accessibilityElementsHidden color="accentText" variant="body">
                    ✓
                  </Text>
                ) : null}
              </View>
            )}
          </Pressable>
        )
      })}
    </InsetGroup>
  )
}
