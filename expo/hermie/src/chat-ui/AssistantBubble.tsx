/**
 * The bot's reply.
 *
 * Three things the mockup asks for and one it forbids:
 *
 *  - A short reply is a frosted glass bubble (`bubbleIn`). A LONG one takes the
 *    reading treatment (`bubbleInRead`): a near-opaque wash, looser leading,
 *    wider padding. §7.1 is explicit that this is not a stylistic variant — it is
 *    how body-text contrast stops depending on the wallpaper behind the bubble.
 *  - Past roughly fourteen lines the body folds, with the state held above the
 *    list so virtualisation cannot reset it — WHILE the reply streams, not once
 *    it seals. See `Fold`: a reply that is dumped out at full length and then
 *    collapses is the lurch this rule exists to prevent.
 *  - One bubble from start to finish (§6.2): while the turn has no text this
 *    bubble holds the typing dots itself. It must not render as an empty box —
 *    that box, under a separate bubble of dots, is the grey rectangle the owner
 *    reported.
 *  - Forbidden: a blur view of its own. §7.4 — no per-bubble blur in a
 *    virtualised list, and none at all on Android. `Bubble` composites the recipe.
 */
import { View } from 'react-native'

import { prettyModelName } from '@hermie/transcript'

import { Markdown, markdownLeading, type MarkdownImageSource } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { ErrorCard } from './ErrorCard'
import { ReasoningDisclosure } from './ReasoningDisclosure'
import { TypingDots } from './TypingIndicator'
import { Bubble, bubblePaddingX, TAIL_REACH, useBubbleContentWidth } from './primitives/Bubble'
import { Fold, useFoldBlocks } from './primitives/Fold'
import { MetaLine } from './primitives/MetaLine'
import { useExpanded } from './expanded'
import { formatClock, formatCount, formatDuration, needsReadingTreatment } from './format'
import { chatStrings } from './strings'
import type { AssistantItem, Presentation } from './types'

export interface AssistantBubbleProps {
  item: AssistantItem
  presentation?: Presentation
  /** Usage and duration under the bubble. Off for an interim note. */
  showFooter?: boolean
  onRetry?: () => void
  /** Links inside the reply; defaults to the platform's own handler. */
  onLinkPress?: (href: string) => void
  /** Where a gateway-relative image resolves, and what its request carries. */
  images?: MarkdownImageSource
  /** Last bubble of a run — the one that carries the tail. */
  tail?: boolean
  grouped?: boolean
}

/**
 * The line under a finished reply: how long it took, what it cost, on what.
 *
 * A duration NEVER stands alone. `0.1s` under a bubble is a loose number with
 * nothing to attach it to — it reads as a stray artifact rather than as part of
 * the reply — so the clock only appears next to something that explains it. A
 * gateway that reports no usage therefore shows no footer at all, which is the
 * honest outcome.
 */
function footerParts(item: AssistantItem): string[] {
  const parts: string[] = []
  const input = item.usage?.input
  const output = item.usage?.output

  if (typeof input === 'number' || typeof output === 'number') {
    parts.push(chatStrings.assistant.tokens(formatCount(input ?? 0), formatCount(output ?? 0)))
  }

  if (item.usage?.model) {
    // The maker's own spelling rather than the wire id: this line is read, not
    // typed, and `claude-haiku-4-5-20251001` under a reply is a receipt number.
    parts.push(prettyModelName(item.usage.model))
  }

  if (!parts.length) {
    return parts
  }

  const duration = formatDuration(item.durationS)

  return duration ? [duration, ...parts] : parts
}

export function AssistantBubble({
  item,
  presentation = 'full',
  showFooter = false,
  onRetry,
  onLinkPress,
  images,
  tail = true,
  grouped = false
}: AssistantBubbleProps) {
  const theme = useTheme()
  const foldBlocks = useFoldBlocks()
  const [expanded, toggle] = useExpanded(item.id)
  // Hooks run before the early return and before `reading` is known, so both
  // paddings are asked for and the branch picks one below.
  const readingWidth = useBubbleContentWidth(true)
  const plainWidth = useBubbleContentWidth(false)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const time = formatClock(item.ts)
  const parts = showFooter && !item.interim ? footerParts(item) : []
  const body = item.text
  const hasBody = Boolean(body.trim())
  const reading = hasBody && needsReadingTreatment(body)
  const variant = reading ? 'inRead' : 'in'
  const recipe = theme.bubbles[variant]
  const bodyInset = bubblePaddingX(theme.space, reading)
  const contentWidth = reading ? readingWidth : plainWidth

  return (
    <View testID={`assistant-${item.id}`}>
      {/*
        The eyebrow, and only on the FIRST bubble of the run it heads: a heading
        repeated over every bubble of one turn is not a heading. `grouped` is the
        run's own fact, and `speakerKey` keys a reply-to-bot by its handle, so a
        second reply to the same teammate continues the run and stays bare.

        Indented to the bubble's TEXT, not to its outer edge. The bubble's body
        starts `TAIL_REACH` (the tail's own gutter) plus the bubble's horizontal
        padding in from this row's left edge, and an eyebrow that starts at the
        row edge instead reads as a stray line in the margin rather than as this
        bubble's label.
      */}
      {item.replyToBotHandle && !grouped ? (
        <Text
          color="textFaint"
          style={{ marginBottom: theme.space.xs, marginLeft: TAIL_REACH + bodyInset }}
          variant="micro"
        >
          {chatStrings.assistant.replyTo(item.replyToBotHandle).toUpperCase()}
        </Text>
      ) : null}

      {/*
        The thought, aligned with the bubble's TEXT on the same rule as the
        eyebrow above it — see `ReasoningDisclosure`, which is deliberately
        secondary text rather than a bubble or a ledger row.
      */}
      {item.reasoning ? (
        <ReasoningDisclosure
          durationS={item.durationS}
          id={item.id}
          inset={TAIL_REACH + bodyInset}
          streaming={item.streaming && !hasBody}
          testID={`reasoning-${item.id}`}
          text={item.reasoning}
        />
      ) : null}

      {hasBody || item.streaming ? (
        <Bubble
          grouped={grouped}
          /*
            Every reply carries its clock, on the last line of its body. Nothing
            while the turn is still only dots: a timestamp beside a bubble that has
            said nothing yet is a time for an event that has not happened.
          */
          {...(hasBody ? { meta: <MetaLine testID={`assistant-meta-${item.id}`} time={time} /> } : {})}
          side="other"
          // An interim note is mid-turn commentary, not the answer: the design
          // mutes it rather than giving it a different shape. A reply addressed at
          // a teammate bot is muted less far — it IS the answer, just not one the
          // human asked for.
          style={item.interim ? { opacity: 0.72 } : item.replyToBotHandle ? { opacity: 0.9 } : undefined}
          tail={tail}
          variant={variant}
        >
          {hasBody ? (
            <Fold
              // The leading and the block geometry are what let the cut land on a
              // line boundary and step over a table or a code block.
              blocks={foldBlocks.blocks}
              bleed={reading ? theme.space.lg : theme.space.md + 2}
              expanded={expanded}
              fadeTo={recipe.tail}
              lineHeight={markdownLeading(theme.type.body.fontSize)}
              onToggle={toggle}
              testID={`assistant-fold-${item.id}`}
            >
              <Markdown
                fontSize={theme.type.body.fontSize}
                {...(images ? { images } : {})}
                // The same colour the fold fades into, for the same reason: a
                // table's cells are transparent and only the bubble knows what
                // is behind its last column.
                fadeTo={recipe.tail}
                linkColor={theme.accent().text}
                // What a table or a listing may occupy before it has to scroll.
                // Nothing under the bubble's body can work this out for itself.
                maxContentWidth={contentWidth}
                onBlockLayout={foldBlocks.onBlockLayout}
                onLinkPress={onLinkPress}
                text={body}
              />
            </Fold>
          ) : (
            // The turn is running and nothing has arrived. Same bubble, dots
            // instead of text — never an empty box with a timestamp in it.
            <TypingDots testID={`assistant-typing-${item.id}`} />
          )}
        </Bubble>
      ) : null}

      {item.error ? (
        <ErrorCard
          message={item.error.message}
          onRetry={onRetry}
          recoverable={item.error.recoverable}
          // A partial reply is worth keeping, so the turn stays retryable only
          // when the backend is not holding it for us.
          retryable={!item.error.recoverable}
          testID={`assistant-error-${item.id}`}
        />
      ) : null}

      {parts.length ? (
        <Text color="textFaint" style={{ marginLeft: theme.space.md, marginTop: theme.space.xxs }} variant="meta">
          {chatStrings.assistant.footer(parts)}
        </Text>
      ) : null}
    </View>
  )
}
