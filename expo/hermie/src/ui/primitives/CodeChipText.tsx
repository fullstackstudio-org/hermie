/**
 * A line of chrome copy that has a command in it.
 *
 * The wizard's cover says "the machine running `hermes serve`" and the session
 * token step says "printed by `hermes serve`" — both written with backticks,
 * because that is how everybody writes a command, and both drawn as plain text,
 * so both shipped with the backticks on screen. A reader sees punctuation where
 * the transcript, two taps away, draws a chip.
 *
 * This is deliberately NOT the Markdown renderer. That one lexes, splits into
 * blocks, measures its own line width to decide how a chip may break and
 * memoizes the result — everything a streaming reply needs and nothing a
 * fourteen-word label does. What is shared is the thing worth sharing: the
 * chip's own look comes from the same tokens `markdown/Inline.tsx` builds it
 * from, so the two cannot drift apart.
 *
 * Backticks only, and no other markup. A label with emphasis in it is a label
 * that wants rewriting.
 */
import { Fragment } from 'react'
import { type TextStyle } from 'react-native'

import { MONOSPACE } from '../../markdown/context'
import { useTheme } from '../theme'
import { type TextColorRole } from '../tokens'
import { Text } from './Text'

/**
 * The chip's fake padding, and it has to be NON-BREAKING.
 *
 * `markdown/Inline.tsx` carries the long version: React Native will not apply
 * padding to a `Text` nested inside a `Text`, so the padding is characters, and
 * an ordinary space at a chip's edge can end up as a line's trailing whitespace
 * — which a nested `Text` paints its background across, producing a grey bar to
 * the end of the line with nothing in it.
 */
const PAD = ' '

export interface CodeChipTextProps {
  /** The copy, with any command in single backticks. */
  children: string
  color?: TextColorRole
  variant?: 'meta' | 'preview' | 'micro'
  style?: TextStyle
  testID?: string
}

export function CodeChipText({ children, color = 'textMuted', variant = 'preview', style, testID }: CodeChipTextProps) {
  const theme = useTheme()
  const size = theme.type[variant].fontSize

  const chip: TextStyle = {
    backgroundColor: theme.tintSunk,
    color: theme.colors.text,
    fontFamily: MONOSPACE,
    // The same step down the transcript's chip takes, with the same floor: a
    // chip two points under an 11pt label would be unreadable.
    fontSize: Math.max(11, size - 2)
  }

  return (
    <Text color={color} style={style} testID={testID} variant={variant}>
      {splitOnCode(children).map((run, index) =>
        run.code ? (
          <Text key={index} style={chip}>
            {PAD + run.text + PAD}
          </Text>
        ) : (
          <Fragment key={index}>{run.text}</Fragment>
        )
      )}
    </Text>
  )
}

/**
 * Split a string into plain and backticked runs.
 *
 * An unmatched backtick is plain text, which is the only sane answer: a label
 * that opens a chip and never closes it is a typo, and swallowing the rest of
 * the sentence into a grey box is a worse way to report it than showing the
 * character the author typed.
 */
export function splitOnCode(source: string): { text: string; code: boolean }[] {
  const runs: { text: string; code: boolean }[] = []
  let rest = source

  while (rest.length > 0) {
    const open = rest.indexOf('`')
    const close = open === -1 ? -1 : rest.indexOf('`', open + 1)

    if (open === -1 || close === -1) {
      runs.push({ text: rest, code: false })

      break
    }

    if (open > 0) {
      runs.push({ text: rest.slice(0, open), code: false })
    }

    runs.push({ text: rest.slice(open + 1, close), code: true })
    rest = rest.slice(close + 1)
  }

  return runs
}
