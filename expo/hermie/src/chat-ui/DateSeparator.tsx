/**
 * `Today`, `Yesterday`, `Tue 16 September` — the date stamp between two days of
 * conversation.
 *
 * Centred, in the micro type (uppercase, tracked out), on nothing: a pill behind
 * it would be a fourth surface in the transcript and the stamp is read once per
 * screenful at most. Which stamp goes where is `grouping.ts`'s answer, not this
 * component's.
 *
 * It takes the same rhythm as the other things that head a bubble — the reply
 * eyebrow, the sender chip: the author-change gap above it and 4pt below, so the
 * stamp belongs to the day it opens rather than floating between two of them. And
 * it brings that gap WITH it: `TranscriptList` drops the row's own margin on a row
 * that carries a stamp, or the two would stack into a hole in the column.
 */
import { View } from 'react-native'

import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { BUBBLE_GAP } from '../ui/tokens'

export interface DateSeparatorProps {
  label: string
  testID?: string
}

export function DateSeparator({ label, testID }: DateSeparatorProps) {
  const theme = useTheme()

  return (
    <View
      accessibilityRole="header"
      // Level 2, and stated. A heading with no level is an `<h1>` on the web,
      // so a transcript's day stamps were the only first-level headings in the
      // document — a reader navigating by heading got a list of dates and
      // nothing to say which conversation they belonged to. The screen's own
      // title is the `<h1>`; a day is a section of it.
      aria-level={2}
      style={{ alignItems: 'center', paddingBottom: theme.space.xs, paddingTop: BUBBLE_GAP.separate }}
      testID={testID}
    >
      <Text color="textFaint" variant="micro">
        {label.toUpperCase()}
      </Text>
    </View>
  )
}
