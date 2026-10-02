/**
 * How full one memory file is.
 *
 * The numbers are the STORE's, straight off the `list` answer, and none of them
 * is recomputed here. That is the whole design note: a memory file's cost is
 * its entries joined by `"\n§\n"`, so a bar that summed the entries it had just
 * drawn would read a little lower than the file really is, and somebody would
 * delete an entry to make room that was never missing.
 *
 * A gateway that configured no limit sends `0`, and then there is no fraction
 * to draw — the row says what the file costs and stops, rather than drawing an
 * empty bar that implies a ceiling nobody set.
 */
import { View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { memoryStrings } from './strings'

export interface MemoryUsageBarProps {
  /** The label the accessible name uses, e.g. `MEMORY`. */
  label: string
  chars: number
  /** `0` means the gateway set no limit. */
  limit: number
  percent: number
  testID?: string
}

/** Past this, the bar turns to the warning ink: the file is nearly spent. */
const CROWDED_PERCENT = 85

export function MemoryUsageBar({ label, chars, limit, percent, testID }: MemoryUsageBarProps) {
  const theme = useTheme()
  const bounded = Math.max(0, Math.min(100, percent))
  const crowded = bounded >= CROWDED_PERCENT

  return (
    <View
      accessibilityLabel={limit ? memoryStrings.usageLabel(label, bounded) : undefined}
      style={{ gap: theme.space.xxs }}
      testID={testID}
    >
      <Text color={crowded ? 'dangerText' : 'textMuted'} variant="meta">
        {limit ? memoryStrings.usage(chars, limit) : memoryStrings.usageUnbounded(chars)}
      </Text>
      {limit ? (
        <View
          style={{
            backgroundColor: theme.tintSunk,
            borderRadius: theme.radii.pill,
            height: 4,
            overflow: 'hidden'
          }}
        >
          <View
            style={{
              backgroundColor: crowded ? theme.colors.danger : theme.accent().bubble,
              height: 4,
              // A file with one character in it still gets a sliver, because a
              // bar that is visibly empty reads as "this is not working".
              width: `${Math.max(bounded > 0 ? 2 : 0, bounded)}%`
            }}
            testID={testID ? `${testID}-fill` : undefined}
          />
        </View>
      ) : null}
    </View>
  )
}
