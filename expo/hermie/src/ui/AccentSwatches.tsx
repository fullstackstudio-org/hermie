/**
 * The per-chat colour, as nine swatches.
 *
 * Shared by the row's long-press menu and by the chat options sheet, because a
 * colour picked in one place has to be the same picker as the colour picked in
 * the other — two implementations of nine circles is two chances for the
 * selected ring to drift.
 *
 * Default is NOT drawn as a blue circle. A chat on the default colour has no
 * colour of its own, and painting the app's accent into the swatch would say it
 * does; the list's avatar ring makes the same distinction and the two have to
 * agree. It carries its NAME instead of being an empty ring — unlabelled, on a
 * dark sheet, it read as a hole where a swatch should be.
 *
 * Every swatch says whether it is the chosen one with a mark inside it, not only
 * with a thicker ring. A ring is a comparison; a check mark is a statement, and
 * it survives both themes and a screenshot.
 */
import { Pressable, View } from 'react-native'

import { strings } from '../i18n/strings'
import { contrastRatio, parseColor } from './contrast'
import { Text } from './primitives'
import { useTheme } from './theme'
import { ACCENT_ORDER, ACCENTS, CONTROL_MIN_HEIGHT, type AccentName } from './tokens'

/**
 * The mark's ink, chosen against the swatch it sits in.
 *
 * It used to be `onAccent` — white — for every swatch, which was true for as long
 * as every swatch was dark enough to carry white. The studio's lime is not: it is
 * a RING colour, brilliant on purpose, and a white check mark on it is about
 * 1.3 : 1 and simply not there. So the mark asks which of black and white reads
 * better on the fill, which is the same question for all eleven and needs no
 * table to keep in step.
 */
function markInk(fill: string): string {
  const rgb = parseColor(fill).rgb

  return contrastRatio('#FFFFFF', rgb) >= contrastRatio('#101010', rgb) ? '#FFFFFF' : '#101010'
}

export function AccentSwatches({
  accent,
  onSelect,
  testIDPrefix
}: {
  accent: AccentName
  onSelect: (accent: AccentName) => void
  /** `swatch-<prefix>-<name>`; the bot's name where there is one. */
  testIDPrefix: string
}) {
  const theme = useTheme()

  // Wrapped rather than scrolled: nine swatches that scroll hide the last two
  // behind a gesture nobody knows is there, and a colour you cannot see is a
  // colour you will not pick.
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm, paddingVertical: theme.space.xs }}>
      {ACCENT_ORDER.map(name => {
        const selected = name === accent
        const isDefault = name === 'default'

        return (
          <Pressable
            accessibilityLabel={strings.layout.accents[name]}
            accessibilityRole="button"
            aria-selected={selected}
            key={name}
            onPress={() => onSelect(name)}
            style={{
              alignItems: 'center',
              // A sunk well rather than nothing: an empty ring on a dark sheet
              // reads as a hole in the row, not as the ninth choice.
              backgroundColor: isDefault ? theme.tintSunk : ACCENTS[name].fill,
              borderColor: selected ? theme.colors.text : theme.hairline,
              borderRadius: CONTROL_MIN_HEIGHT / 2,
              borderWidth: selected ? 3 : 1,
              flexDirection: 'row',
              gap: theme.space.xs,
              height: CONTROL_MIN_HEIGHT,
              justifyContent: 'center',
              paddingHorizontal: isDefault ? theme.space.md : 0,
              width: isDefault ? undefined : CONTROL_MIN_HEIGHT
            }}
            testID={`swatch-${testIDPrefix}-${name}`}
          >
            {/*
              The ring alone said which one was selected only if you could see
              two swatches at once and compare their borders. A mark inside says
              it on its own, and on the default swatch it has to be the theme's
              ink rather than white — there is no fill under it to read against.
            */}
            {selected ? (
              <Text
                style={{ color: isDefault ? theme.colors.text : markInk(ACCENTS[name].fill), fontWeight: '700' }}
                variant="meta"
              >
                ✓
              </Text>
            ) : null}
            {isDefault ? (
              <Text color="text" variant="meta">
                {strings.layout.accents.default}
              </Text>
            ) : null}
          </Pressable>
        )
      })}
    </View>
  )
}
