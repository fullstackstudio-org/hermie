/**
 * One line of status inside the wizard's card: a static dot and a sentence.
 *
 * Every waiting state in this app is STATIC — `design/liquid-glass-tokens.md`
 * §5 reserves animation for "needs input" and for streaming content, and a
 * probe that has not answered yet is neither. So `checking` is a hollow ring in
 * the accent rather than a spinner: the same shape the offline presence bead
 * uses, for the same reason.
 *
 * The shape carries the meaning as well as the colour — filled for an answer,
 * hollow for a question still open — so the line reads for someone who cannot
 * tell the green from the red.
 *
 * ## It also has to be HEARD
 *
 * Every one of these lines appears where nothing else on the screen moves:
 * "That user name and password were not accepted." replaces nothing, takes no
 * focus and is drawn below the button that was just pressed. A reader was told
 * nothing at all — the press appeared to do nothing, twice, which is how
 * somebody concludes their password is wrong when it is not.
 *
 * So the line announces itself. An ERROR is `alert`, which is assertive:
 * something the visitor asked for has failed and the next thing they do
 * depends on knowing it. Progress and outcomes are polite, so "Checking the
 * session…" and "Signed in as …" are read when the reader is between
 * utterances rather than over the top of one. A `pending` line is neither — it
 * is a step that has not started, and it is on screen before anything happens.
 *
 * All of this works because the line is MOUNTED when its moment arrives:
 * inserting a node into a live region is what a reader announces, and a region
 * that was always there with its text swapped is the version that goes quiet.
 */
import { View } from 'react-native'

import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import type { TextColorRole } from '../../ui/tokens'

export type StatusTone = 'pending' | 'checking' | 'ok' | 'error'

const INK: Record<StatusTone, TextColorRole> = {
  pending: 'textMuted',
  checking: 'textMuted',
  ok: 'okText',
  error: 'dangerText'
}

/** The dot's size, matching the inline presence bead so the two rhyme. */
const DOT = 9

export function StatusDot({ tone }: { tone: StatusTone }) {
  const theme = useTheme()

  const color =
    tone === 'ok'
      ? theme.colors.ok
      : tone === 'error'
        ? theme.colors.danger
        : tone === 'checking'
          ? theme.colors.accentText
          : theme.colors.textMuted

  const filled = tone === 'ok' || tone === 'error'

  return (
    <View
      style={{
        backgroundColor: filled ? color : 'transparent',
        borderColor: color,
        borderRadius: DOT / 2,
        borderWidth: filled ? 0 : 1.5,
        height: DOT,
        // The dot sits on the first line's optical centre rather than on the
        // top of a box that may wrap to three lines.
        marginTop: (theme.type.meta.lineHeight - DOT) / 2,
        width: DOT
      }}
    />
  )
}

export type StatusLineProps = {
  tone: StatusTone
  children: string
  testID?: string
}

export function StatusLine({ tone, children, testID }: StatusLineProps) {
  const theme = useTheme()

  return (
    <View
      {...(tone === 'error'
        ? { accessibilityRole: 'alert' as const }
        : tone === 'pending'
          ? {}
          : { 'aria-live': 'polite' as const })}
      style={{ flexDirection: 'row', gap: theme.space.sm }}
    >
      <StatusDot tone={tone} />
      <Text color={INK[tone]} style={{ flex: 1 }} testID={testID} variant="meta">
        {children}
      </Text>
    </View>
  )
}
