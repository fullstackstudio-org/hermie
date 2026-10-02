/**
 * The name over the first bubble of a group-chat sender's run.
 *
 * Real text, in reading order ahead of the bubble it names — not a caption on
 * an image, so a screen reader says the name and then the message on its own,
 * with nothing extra to wire up (D7). `Avatar` beside it is `aria-hidden` by
 * design; this is the whole of the attribution a reader who cannot see the
 * circle gets.
 *
 * One line, truncated rather than wrapped: a bubble's own width already
 * follows its text, and a name that wrapped to a second line would make the
 * bubble below it look like it belongs to a shorter one.
 */
import { Text } from '../../ui/primitives'
import { useTheme } from '../../ui/theme'
import { senderInk } from '../format'

export interface SenderLabelProps {
  /** Shown as-is — already resolved and sanitised by the caller (D4). */
  name: string
  /** The identity the ink is keyed on. Never the name; see `senderInk` (D5). */
  authorId: string
  style?: { marginLeft?: number; marginBottom?: number }
  testID?: string
}

export function SenderLabel({ name, authorId, style, testID }: SenderLabelProps) {
  const theme = useTheme()
  const ink = senderInk(authorId, theme.scheme)

  return (
    <Text numberOfLines={1} style={[{ color: ink, fontWeight: '600' }, style]} testID={testID} variant="meta">
      {name}
    </Text>
  )
}
