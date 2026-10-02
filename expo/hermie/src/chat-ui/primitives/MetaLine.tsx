/**
 * The clock that sits ON a bubble's last line, and on the owner's own bubble the
 * delivery ticks beside it.
 *
 * It is INSIDE the bubble, and as of this round it is on the body's last line
 * rather than on a line of its own underneath it — which is what kept a one-word
 * message twice as tall as its text. Where exactly it lands is `Bubble`'s
 * `metaRow`, not this component's: this one is a row of ink with no margins and no
 * alignment of its own, so the two cases (inline, or wrapped and right-aligned)
 * have one owner.
 *
 * Every bubble carries one. The previous rule — one clock per run, on the bubble
 * that ends it — was the right call for a stacked metadata LINE, where three
 * repetitions cost three extra rows; it is the wrong call for a clock that costs
 * nothing because it shares a line that was already there, and it left a reader
 * unable to time any message but the last of a run.
 *
 * The receipt's WORD is not repeated next to the tick — the tick is the word, and
 * `Delivered ✓` on every bubble is noise — but the accessibility label says it,
 * because a tick is not readable.
 */
import { View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { chatStrings } from '../strings'
import type { Receipt } from '../types'
import { Ticks } from './Ticks'

export interface MetaLineProps {
  time: string
  /** Only the last own bubble carries one. */
  receipt?: Receipt
  /** True inside an outgoing bubble, where the ink is white. */
  onAccent?: boolean
  /** A trailing marker the mockup puts on this line: `↩ answered`. */
  marker?: string
  testID?: string
}

export function MetaLine({ time, receipt, onAccent = false, marker, testID }: MetaLineProps) {
  const theme = useTheme()

  if (!time && !receipt && !marker) {
    return null
  }

  const ink = onAccent ? theme.colors.onAccent : theme.colors.textFaint

  return (
    <View
      accessibilityLabel={receipt ? `${time} ${chatStrings.receipt[receipt]}` : undefined}
      // No margin and no `alignSelf`: this row is placed by the slot it is handed
      // to. A `marginTop` here is what used to push it onto a line of its own even
      // when there was room for it beside the text.
      style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xs }}
      testID={testID}
    >
      {marker ? (
        <Text style={{ color: ink, opacity: onAccent ? 0.85 : 1 }} variant="meta">
          {marker}
        </Text>
      ) : null}

      {time ? (
        <Text style={{ color: ink, opacity: onAccent ? 0.85 : 1 }} variant="meta">
          {time}
        </Text>
      ) : null}

      {receipt ? <Ticks color={ink} receipt={receipt} /> : null}
    </View>
  )
}
