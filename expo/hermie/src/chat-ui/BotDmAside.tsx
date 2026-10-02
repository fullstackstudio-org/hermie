/**
 * Bot-to-bot traffic, drawn as an ASIDE — the same silhouette as a reply's
 * thoughts.
 *
 * The owner's rule, and the whole reason this file replaced a line component and
 * a bubble component: *bot-to-bot messages must not be seen as chat bubbles. The
 * message to another bot must simply sit on the left and be expandable — same
 * design as thoughts. The replies too.*
 *
 * So both directions share one shape:
 *
 *  - **No bubble, no tail, no card.** An inbound DM used to be a tinted bubble
 *    with a tail, which said "somebody spoke to you here"; an outgoing one was a
 *    line whose expanded body sat on a `GlassSurface`, which is a panel the width
 *    of a bubble sitting where a bubble sits. Both read as speech. Bot-to-bot
 *    traffic is not the conversation the reader is in — it is an aside about it,
 *    exactly as a thought is an aside about the reply under it, and it gets the
 *    same treatment: muted ink, the smaller size, no background, a chevron.
 *  - **Collapsed at every verbosity.** `ReasoningDisclosure` opens for nobody
 *    either. The reader taps to open one, and `useExpanded` keeps that choice
 *    against the item's id — so scrolling an opened aside out of a virtualised
 *    window and back does not close it.
 *  - **Left, always.** An outgoing message is still the bot's own, but drawing it
 *    on the right would put it in the owner's column, and the owner did not send
 *    it. Side is about WHO SPOKE to the reader, and in both directions the answer
 *    is "not you and not the bot you are reading".
 *
 * What survives from the line it replaces, because §6.6 was right about it: the
 * reply marker is ALWAYS present on an outgoing row — replied, waiting, or failed
 * — since a row with nothing on its right would read as "delivered and answered",
 * the one state the reader cannot verify. And nothing animates: waiting is a
 * hollow dot, not a blink (§5).
 *
 * `showBotToBot: false` still collapses the row to a chip rather than hiding it
 * (ADR-0009): hiding a DM makes the bot's own reply unexplainable.
 */
import { Pressable, View } from 'react-native'

import { Markdown } from '../markdown'
import { Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { Icon, ICON_SIZE } from '../ui/Icon'
import { TAP_SLOP, type TextColorRole } from '../ui/tokens'
import { hasReply } from './dm-rollup'
import { useExpanded } from './expanded'
import { formatClock, previewLine } from './format'
import { chatStrings } from './strings'
import { Chip } from './primitives/Chip'
import { useLedgerWidth } from './primitives/Bubble'
import type { DmCounterpartQuery } from './TranscriptList'
import type { BotDmInItem, BotDmOutItem, DispatchStatus, Presentation } from './types'

export type BotDmItem = BotDmInItem | BotDmOutItem

export interface BotDmAsideProps {
  item: BotDmItem
  presentation?: Presentation
  /**
   * The ONE place a DM aside navigates: the secondary link inside the open body,
   * never the row itself.
   *
   * Tapping the row expands it. It used to navigate to the other bot's chat,
   * which loses the conversation the reader is in to show them a message they
   * were already looking at.
   */
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
  /** Links inside an expanded body. */
  onLinkPress?: (href: string) => void
  /**
   * The recipient's chat is live and its turn is running RIGHT NOW.
   *
   * Only a caller holding both chats can know this — the dispatch says nothing
   * about what happened to it. It refines the WAITING marker rather than adding a
   * fourth one.
   */
  targetTyping?: boolean
  /**
   * This bot has replied to an inbound DM.
   *
   * Only the caller can know: the answer is a later assistant item, and a row
   * cannot see its neighbours. `attributeBotReplies` in the engine is what
   * decides it, so the marker is not guessed at here.
   */
  answered?: boolean
  testID?: string
}

type Marker = { label: string; tone: TextColorRole; hollow: boolean }

/**
 * The reply indicator on an outgoing dispatch, which is never absent.
 *
 * Three outcomes, three shapes. Kept exported: the gallery and the tests read it
 * directly rather than scraping the rendered row for a string.
 */
export function markerFor(item: BotDmOutItem, targetTyping = false): Marker {
  if (item.dispatch.status === 'failed' || item.reply?.error) {
    return { hollow: false, label: chatStrings.botDm.marker.failed, tone: 'dangerText' }
  }

  if (hasReply(item)) {
    return { hollow: false, label: chatStrings.botDm.marker.replied, tone: 'accentText' }
  }

  if (targetTyping) {
    return { hollow: true, label: chatStrings.botDm.targetTyping(item.targetHandle || item.target), tone: 'textFaint' }
  }

  return { hollow: true, label: chatStrings.botDm.marker.waiting, tone: 'textFaint' }
}

function statusLabel(status: DispatchStatus): string {
  switch (status) {
    case 'sending':
      return chatStrings.botDm.sending
    case 'queued':
      return chatStrings.botDm.queued
    case 'failed':
      return chatStrings.botDm.failed
    case 'ambiguous':
      return chatStrings.botDm.ambiguous
    default:
      return chatStrings.botDm.unknown
  }
}

/** A still, hollow dot. The shape §5 gives to waiting, instead of motion. */
function HollowDot({ color }: { color: string }) {
  return <View style={{ borderColor: color, borderRadius: 4, borderWidth: 1.5, height: 8, width: 8 }} />
}

/**
 * The handle this aside is about: the target of a dispatch, the sender of an
 * inbound message.
 */
export function dmHandleOf(item: BotDmItem): string {
  return item.kind === 'bot_dm_out'
    ? item.targetHandle || item.target
    : (item.senderHandle ?? item.senderName.toLowerCase())
}

/**
 * What to look for on the far side of this row.
 *
 * A dispatch's counterpart is an INBOUND row in the target's chat carrying the
 * same body, and an inbound message's counterpart is the sender's own OUTBOUND
 * dispatch. The stamps are close but never identical — the delivery process
 * queues between the two — so the text is what the far chat matches on.
 */
function counterpart(item: BotDmItem): DmCounterpartQuery {
  return item.kind === 'bot_dm_out'
    ? { kind: 'bot_dm_in', ...(item.ts ? { at: item.ts } : {}), text: item.message }
    : { kind: 'bot_dm_out', ...(item.ts ? { at: item.ts } : {}), text: item.text }
}

export function BotDmAside({
  item,
  presentation = 'collapsed',
  onOpenBot,
  onLinkPress,
  targetTyping = false,
  answered = false,
  testID
}: BotDmAsideProps) {
  const theme = useTheme()
  const maxWidth = useLedgerWidth()
  const [expanded, toggle] = useExpanded(item.id)

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const out = item.kind === 'bot_dm_out' ? item : undefined
  const handle = dmHandleOf(item)

  if (presentation === 'chip') {
    return (
      <Chip
        centered
        label={out ? chatStrings.botDm.chip(out.target) : chatStrings.botDm.inChip((item as BotDmInItem).senderName)}
        onPress={onOpenBot ? () => onOpenBot(handle, counterpart(item)) : undefined}
        testID={out ? `bot-dm-out-chip-${item.id}` : `bot-dm-in-chip-${item.id}`}
      />
    )
  }

  const body = out ? out.message : (item as BotDmInItem).text
  const header = out ? chatStrings.botDm.asideTo(handle) : chatStrings.botDm.asideFrom(handle)
  const marker = out ? markerFor(out, targetTyping) : answered ? ANSWERED_MARKER() : undefined
  const time = formatClock(item.ts)
  const root = testID ?? `bot-dm-aside-${item.id}`

  return (
    <View style={{ gap: theme.space.xxs, maxWidth }} testID={root}>
      <Pressable
        accessibilityHint={header}
        accessibilityRole="button"
        aria-expanded={expanded}
        hitSlop={TAP_SLOP}
        // Wrapped: `toggle` takes the row's height change, and a Pressable would
        // hand it a gesture event instead. This row cannot measure one, so it
        // says nothing and the list holds the plain offset.
        onPress={() => toggle()}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        testID={`${root}-toggle`}
      >
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.sm, minHeight: 22 }}>
          <Text color="textMuted" numberOfLines={1} style={{ flexShrink: 0 }} variant="meta">
            {header}
          </Text>

          {/* The preview is the one part the row can afford to lose: it is a
              truncation of text the open body shows in full. It yields first, and
              `minWidth: 0` is what lets it actually shrink inside a row rather
              than forcing the row wider. */}
          <Text
            color="textFaint"
            numberOfLines={1}
            style={{ flexGrow: 1, flexShrink: 100, minWidth: 0 }}
            variant="meta"
          >
            {previewLine(body, 60)}
          </Text>

          {time ? (
            <Text color="textFaint" numberOfLines={1} style={{ flexShrink: 0 }} variant="meta">
              {time}
            </Text>
          ) : null}

          {marker?.hollow ? <HollowDot color={theme.colors.textFaint} /> : null}

          {marker ? (
            <Text
              color={marker.tone}
              numberOfLines={1}
              style={{ flexShrink: 1 }}
              testID={out && targetTyping && marker.hollow ? `bot-dm-out-typing-${item.id}` : undefined}
              variant="meta"
            >
              {marker.label}
            </Text>
          ) : null}

          <Icon
            color={theme.colors.textFaint}
            name={expanded ? 'chevronDown' : 'chevronRight'}
            size={ICON_SIZE.marker}
          />
        </View>
      </Pressable>

      {expanded ? (
        <View style={{ gap: theme.space.sm }} testID={`${root}-body`}>
          {/* Markdown rather than characters: the other bot wrote prose, and a
              thought's body is read the same way. `selectable` because the reason
              a reader opens one of these is usually to copy something out. */}
          <Markdown
            color="textMuted"
            fontSize={theme.type.preview.fontSize}
            linkColor={theme.accent().text}
            onLinkPress={onLinkPress}
            selectable
            text={body}
          />

          {out ? (
            <Text color={out.dispatch.status === 'failed' ? 'dangerText' : 'textFaint'} variant="meta">
              {statusLabel(out.dispatch.status)}
            </Text>
          ) : null}

          {out?.dispatch.error ? (
            <Text color="dangerText" variant="meta">
              {out.dispatch.error}
            </Text>
          ) : null}

          {out?.reply ? (
            <View style={{ gap: theme.space.xs }} testID={`bot-dm-aside-reply-${item.id}`}>
              <Text color="textFaint" variant="micro">
                {chatStrings.botDm.reply.toUpperCase()}
              </Text>

              {out.reply.error ? (
                <Text color="dangerText" variant="preview">
                  {out.reply.error}
                </Text>
              ) : (
                <Markdown
                  color="textMuted"
                  fontSize={theme.type.preview.fontSize}
                  linkColor={theme.accent().text}
                  onLinkPress={onLinkPress}
                  selectable
                  text={out.reply.text}
                />
              )}
            </View>
          ) : null}

          {onOpenBot ? (
            <Pressable
              accessibilityRole="link"
              hitSlop={TAP_SLOP}
              onPress={() => onOpenBot(handle, counterpart(item))}
              testID={`bot-dm-aside-open-${item.id}`}
            >
              <Text color="accentText" variant="meta">
                {chatStrings.botDm.openChat(handle)}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

/**
 * The inbound row's own marker: `↩︎ answered`, once this bot has replied.
 *
 * A function rather than a constant because `chatStrings` is a locale-aware
 * proxy — reading it at module load would freeze the language the app started
 * in.
 */
const ANSWERED_MARKER = (): Marker => ({ hollow: false, label: chatStrings.botDm.answered, tone: 'accentText' })
