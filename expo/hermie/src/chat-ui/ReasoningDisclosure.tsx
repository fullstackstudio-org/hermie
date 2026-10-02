/**
 * `Thought for 4s` — one quiet line above a reply, and the thought under it.
 *
 * §6.4: thinking is a single muted line that expands to a short summary. It is
 * collapsed by default on purpose — reasoning is context for the answer, not the
 * answer, and the default verbosity hides it altogether.
 *
 * **It is not a ledger row and it is not a bubble.** It was a `LedgerRow`, which
 * gave it a glyph in a tinted well and put the expanded text on a `GlassSurface`
 * card — a panel the width of a bubble, sitting where a bubble sits, reading as a
 * second message the bot sent. The owner reported exactly that: the thought drawn
 * as a chat bubble. A ledger row is the right silhouette for a machine EVENT (a
 * tool call, a cron delivery) because an event is a thing that happened; a
 * thought is not an event, it is an aside about the reply underneath it. So it is
 * secondary text and nothing else: no well, no card, no background, the smaller
 * size and the muted ink, with a chevron to say the line opens.
 *
 * `inset` aligns it with the bubble's TEXT rather than with the row's edge, for
 * the reason the reply eyebrow gives: a line starting at the row edge reads as a
 * stray note in the margin instead of as this reply's own aside.
 *
 * The expanded state is keyed on the item's id and held above the list, so
 * scrolling an opened summary out of the window and back does not close it.
 */
import { Pressable, View } from 'react-native'

import { Icon, ICON_SIZE } from '../ui/Icon'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { TAP_SLOP } from '../ui/tokens'
import { useExpanded } from './expanded'
import { chatStrings } from './strings'

export interface ReasoningDisclosureProps {
  text: string
  /**
   * The transcript item this belongs to.
   *
   * Reasoning is drawn by the assistant bubble rather than being an item of its
   * own, so it borrows the bubble's id with a suffix — two disclosures on one
   * item would otherwise share one flag.
   */
  id?: string
  /** Wall-clock seconds the model spent thinking, when the gateway sent one. */
  durationS?: number
  /** Still arriving: the row says "Thinking" and shows no duration. */
  streaming?: boolean
  /**
   * How far in from the row's left edge the text starts, in points.
   *
   * The bubble's own gutter plus its horizontal padding — which is not one
   * number, because a long reply takes the wider reading padding. The caller
   * knows which; this only applies it.
   */
  inset?: number
  testID?: string
}

export function ReasoningDisclosure({
  text,
  id,
  durationS,
  streaming = false,
  inset = 0,
  testID
}: ReasoningDisclosureProps) {
  const theme = useTheme()
  const [expanded, toggle] = useExpanded(`reasoning:${id ?? testID ?? ''}`)

  if (!text.trim() && !streaming) {
    return null
  }

  const label = streaming
    ? chatStrings.assistant.thinking
    : chatStrings.assistant.thoughtFor(Math.max(1, Math.round(durationS ?? 0)))
  const openable = Boolean(text.trim())

  const header = (
    <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.xxs }}>
      <Text color="textFaint" numberOfLines={1} variant="meta">
        {label}
      </Text>

      {openable ? (
        <Icon color={theme.colors.textFaint} name={expanded ? 'chevronDown' : 'chevronRight'} size={ICON_SIZE.marker} />
      ) : null}
    </View>
  )

  return (
    <View style={{ gap: theme.space.xxs, marginLeft: inset, marginBottom: theme.space.xs }} testID={testID}>
      {openable ? (
        <Pressable
          accessibilityRole="button"
          aria-expanded={expanded}
          hitSlop={TAP_SLOP}
          // Wrapped: `toggle` takes the row's height change, and a Pressable would
          // hand it a gesture event instead. This row cannot measure one, so it
          // says nothing and the list holds the plain offset.
          onPress={() => toggle()}
          // `flex-start` so the tap target is the line, not the whole column
          // width — a thought is narrow and the bubble under it is not.
          style={({ pressed }) => ({ alignSelf: 'flex-start', opacity: pressed ? 0.6 : 1 })}
          testID={testID ? `${testID}-toggle` : undefined}
        >
          {header}
        </Pressable>
      ) : (
        header
      )}

      {expanded && openable ? (
        <Text color="textMuted" selectable testID={testID ? `${testID}-body` : undefined} variant="preview">
          {text}
        </Text>
      ) : null}
    </View>
  )
}
