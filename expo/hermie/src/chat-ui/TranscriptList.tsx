/**
 * The transcript itself.
 *
 * An INVERTED `FlatList`: the newest item is index 0, which is what makes "stick
 * to the bottom while streaming" free — the bottom is offset 0, and a list that is
 * already at 0 stays there when content grows. Together with
 * `maintainVisibleContentPosition` it also means a page of older history landing at
 * the far end does not shove the reader up the screen.
 *
 * Rows are memoized on `(id, version, presentation, receipt, layout)`. The engine
 * bumps `version` on every mutation, so that tuple is an exact change key: during
 * a streaming turn only the assistant row re-renders, and inside it only the last
 * Markdown block.
 *
 * Three whole-list facts are computed here rather than in the rows, because a row
 * cannot see its neighbours:
 *
 *  - **Grouping** (`grouping.ts`) — which bubbles continue a run, which one is
 *    last and therefore carries the tail, and where a date stamp goes.
 *  - **Bot-to-bot roll-ups** (`dm-rollup.ts`) — more than three consecutive
 *    outgoing DMs collapse into one summary.
 *  - **Disclosure state** (`expanded.tsx`) — every fold, card and roll-up keeps
 *    its open/closed flag in one set keyed by item id. In a virtualised list a
 *    row's own `useState` is a bug with a delay on it: scroll an opened card out
 *    of the window and `FlatList` unmounts it, so scrolling back re-mounts it
 *    collapsed. Nothing the reader did.
 *
 * Nothing here scrolls in response to a disclosure opening. That is not an
 * omission, it is the requirement: expanding a tool row, a cron card or a DM
 * exchange must leave the viewport exactly where it was. At the bottom of an
 * inverted list that is free — offset 0 is the newest row and an older row
 * growing happens further down the content, where the reader is not.
 *
 * The agents bar is a pinned sibling rather than a list header. The design board
 * pins it under the chat header, and a header inside an inverted list would scroll
 * away with the oldest message.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode
} from 'react'
import {
  FlatList,
  Keyboard,
  Platform,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type ViewStyle
} from 'react-native'

import { traceBlankRow, traceItems, traceRow, traceScroll, TRACING } from '../dev/trace-scroll'
import { useFollowsLocale } from '../i18n/use-locale'
import type { MarkdownImageSource } from '../markdown'
import { copyToClipboard } from '../platform/clipboard'
import { ContextMenuHost } from '../platform/context-menu'
import { applyDirectTouchPan } from '../platform/pointer-drag'
import { RUNS_ON_MAC } from '../platform/runs-on-mac'
import { ANCHORS_GROWTH_ITSELF } from '../platform/scroll-anchor'
import { PlainScrollEdges } from '../platform/scroll-edges'
import { GlassSurface } from '../ui/glass'
import { Button, Text } from '../ui/primitives'
import { useTheme } from '../ui/theme'
import { BUBBLE_GAP, DM_LINE_GAP } from '../ui/tokens'
import { AssistantBubble } from './AssistantBubble'
import { BotDmAside } from './BotDmAside'
import { BotDmRollup, useRollupExpanded } from './BotDmRollup'
import { CronDeliveryCard } from './CronDeliveryCard'
import { DateSeparator } from './DateSeparator'
import { Appear } from '../ui/Appear'
import { JumpToLatestPill } from './JumpToLatestPill'
import { NoticePill } from './NoticePill'
import type { GalleryAttachment } from './AttachmentGallery'
import { ImageViewer } from './ImageViewer'
import { SelectTextOverlay } from './SelectTextOverlay'
import { StatusRow } from './StatusRow'
import { SubagentGroupCard } from './SubagentGroupCard'
import { ToolCard } from './ToolCard'
import { TypingIndicator } from './TypingIndicator'
import { UserBubble } from './UserBubble'
import { useLedgerWidth } from './primitives/Bubble'
import { BubbleColumn } from './primitives/BubbleColumn'
import { Chip } from './primitives/Chip'
import { ExpandedProvider, useExpanded } from './expanded'
import { isDmRow, rollupDmRuns, type DmRowRole } from './dm-rollup'
import { clipInline, senderLabel } from './format'
import { messageMenuItems, parseMessageMenuAction } from './message-menu'
import { layoutRows, type RowLayout } from './grouping'
import { chatStrings } from './strings'
import type {
  ApprovalItem,
  ClarifyItem,
  CronDeliveryItem,
  MessageAuthor,
  Presentation,
  Receipt,
  Subagent,
  ToolItem,
  TranscriptItem,
  UserItem,
  VisibleItem
} from './types'

/** What to look for in the chat being opened; see `TranscriptContext.onOpenBot`. */
export interface DmCounterpartQuery {
  kind: 'bot_dm_in' | 'bot_dm_out'
  at?: number
  text?: string
}

export interface TranscriptContext {
  subagents?: Record<string, Subagent>
  /**
   * Handles whose chat is live and mid-turn right now, so a pending dispatch can
   * say "@writer is writing…". A set rather than a flag per card: the screen knows
   * this once, the cards read it many times.
   */
  typingHandles?: readonly string[]
  /**
   * Open another bot's chat.
   *
   * Reached from ONE place now: the `Open @writer's chat` link inside an expanded
   * bot-to-bot exchange. Tapping a DM line itself expands it in place (§6.6), so
   * the counterpart query the old card passed is gone — the reader is not being
   * sent somewhere to see a message they are already looking at.
   */
  onOpenBot?: (handle: string, counterpart?: DmCounterpartQuery) => void
  onRetry?: (itemId: string) => void
  onOpenTranscript?: (subagentId: string) => void
  /** Re-opens the sheet for a question still sitting in the transcript. */
  onOpenRequest?: (item: ApprovalItem | ClarifyItem) => void
  /**
   * Answer an approval without leaving the transcript (ADR-0010, amended).
   *
   * The sheet is still how a question ARRIVES. This is how one is answered by
   * a reader who has already scrolled to it and read the arguments — for them
   * the sheet is a second surface asking something they have finished thinking
   * about. Absent leaves the `Answer` button as the only way through, which is
   * what the developer gallery gets.
   */
  onRespondApproval?: (item: ApprovalItem, choice: string) => void
  /**
   * Which open approval belongs to a tool card, if the host can say.
   *
   * The host's answer because the gateway's approval carries a tool NAME and
   * no tool-call id, so nothing in the transcript can resolve it on its own —
   * see docs/platform-notes.md. A host that cannot tell answers `undefined`
   * and the card draws no buttons, which is the right failure: the sheet is
   * still there.
   */
  approvalForTool?: (item: ToolItem) => ApprovalItem | undefined
  onLinkPress?: (href: string) => void
  /**
   * Something `Image` can load for an attachment reference, or `undefined`.
   *
   * The host's answer, because only it knows which attachments it still holds
   * bytes for — a reference is a path on the gateway's disk and no endpoint
   * serves one back. Absent means every attachment draws as a chip.
   */
  attachmentUri?: (reference: string) => string | undefined
  /**
   * Open an attachment. Supplied by `TranscriptList` itself for a picture, the
   * same way `onSelectText` is: the viewer is a `Modal`, and a modal mounted
   * from a virtualised cell goes with the cell the moment it recycles.
   */
  onOpenAttachment?: (attachment: GalleryAttachment) => void
  /**
   * Open the "Select text" panel over this message's markdown.
   *
   * Supplied by `TranscriptList` itself rather than by the host, and absent from
   * `TranscriptListProps` for that reason: the panel is a `Modal`, and a modal
   * mounted from a virtualised cell goes with the cell the moment it recycles.
   * The list holds the state; a row only asks.
   */
  onSelectText?: (markdown: string) => void
  /** The cron card's two actions, where the host can provide them. */
  onOpenCron?: (jobName: string) => void
  /**
   * Whether THIS card's job name resolves to exactly one cron.
   *
   * A card carries a name, and a name is not an identity — two profiles may hold
   * a cron called the same thing. The host is the only one that can resolve it,
   * so it answers per card and an unresolvable one draws no action rather than a
   * link that opens the wrong cron. Absent means "always", for a host that has
   * nothing to disambiguate.
   */
  canOpenCron?: (jobName: string) => boolean
  onRunCron?: (jobName: string) => void
  /**
   * Put one of the reader's own turns back in the composer.
   *
   * The text and the attachment REFERENCES the turn holds — never the bytes,
   * which this device no longer has. The host owns the field, exactly as it does
   * for a `prefill` directive out of a slash command, so nothing here reaches
   * into it.
   */
  onEditResend?: (text: string, attachments: readonly string[]) => void
  /**
   * Run the last reply again.
   *
   * No argument: there is only ever one row this can be offered on, and the
   * screen already knows which turn it is repeating. Whether that is the
   * gateway's `/retry` or the previous prompt sent again is the screen's
   * decision and depends on the catalogue.
   */
  onRegenerate?: () => void
  /**
   * Fork the conversation at this row.
   *
   * The row's ID travels, not a position. `session.branch` needs a count of the
   * parent's MESSAGES and a transcript item is not a message — one persisted row
   * projects onto several items — so turning "this row" into a number is a
   * question about the gateway's `row_id`s, which is `branchCountFor`'s job and
   * not this list's. The text goes with it so the branch can be named after the
   * row; see `branchTitle`.
   *
   * Absent where there is no gateway to fork against, which drops the menu line
   * rather than disabling it.
   */
  onBranch?: (itemId: string, text: string) => void
  /**
   * The id of the newest assistant reply, or absent.
   *
   * Computed once by the list rather than by each row: a row is one item and has
   * no idea whether anything came after it, and asking every row to search the
   * list would be a scan per open menu per row.
   */
  lastAssistantId?: string
  /**
   * Whether the user turn `Regenerate` would resend is the reader's own, or
   * carries no author at all (HERM-83).
   *
   * The host's answer, not this list's: only it can walk `items` backwards
   * past `lastAssistantId` to find the prompt a retry would repeat, and only
   * it knows the reader's own identity. Absent means "yes" — a personal chat,
   * a host that predates this flag, or the developer gallery all draw exactly
   * as before `author` existed. `false` is the one case that matters: the
   * newest turn in the group chat is a colleague's, and offering `Regenerate`
   * there would let the reader resend a colleague's words under their own
   * name (see `regenerate.ts`'s `lastPrompt`, which refuses the same turn for
   * the same reason).
   */
  regeneratePromptIsOwn?: boolean
  /** A turn is running on this chat, so the two turn-starting lines are greyed. */
  turnRunning?: boolean
  /**
   * Say this reply out loud, or stop saying it.
   *
   * The MARKDOWN is handed over, not the words: flattening for speech is the
   * voice feature's decision (`features/voice/speech-text.ts`) and the transcript
   * kit has no business knowing that a code block becomes a sentence. Absent
   * means the platform cannot speak, and the line is not drawn.
   */
  onReadAloud?: (id: string, markdown: string) => void
  /**
   * The rows that are being read or are queued to be.
   *
   * An array rather than a predicate because it is part of a memo key: a
   * function prop would be a new identity on every render of the screen and
   * would rebuild every row's menu with it.
   */
  readingItemIds?: readonly string[]
  /** The chat's outgoing bubble fill, from `useChatAccent`. */
  accent?: string
  /**
   * Where a gateway-relative Markdown image resolves, and what its request
   * carries. Must be a stable object; it is part of the row memo's key.
   */
  images?: MarkdownImageSource
  /**
   * Whether this is the canonical GROUP chat, never a personal sub-chat, a
   * branch or a retired conversation (HERM-83, D6, gate 1).
   *
   * The predicate is the host's, read off the same canonical-chat-key work
   * the sub-chats feature already maintains — this list invents no second
   * lookup. Absent (the default `ConversationViewScreen` leaves it at, for a
   * branch or a retired conversation) draws every `user` row exactly as it
   * always has: no name, no avatar, own silhouette, whatever `author` says.
   */
  groupChat?: boolean
  /**
   * The reader's own identity, `<provider>:<user_id>` exactly as the gateway
   * spelled it — the value a row's `author.id` is compared against to decide
   * own versus somebody else's (D3). Absent — including while `/api/auth/me`
   * has not answered yet — is the safe default and draws every row as the
   * reader's own, unchanged from before `author` existed.
   */
  ownAuthorId?: string
  /**
   * Name a foreign sender beyond what the row itself carries.
   *
   * D4's rung 1 — the `context.users` directory a teammate's own client
   * writes when they share their display name — needs state this list does
   * not hold, so it is the host's to supply (HERM-83 Task 4). Absent, or
   * returning an empty string, falls back to rungs 2 and 3: the gateway's own
   * stamped name, or the identity with its provider prefix stripped.
   */
  resolveSenderName?: (author: MessageAuthor) => string
  /**
   * A colleague's picture, fetched by `author.id` (HERM-120) — READ only.
   *
   * Called while a row renders, so it must start nothing: asking for the
   * picture is `requestSenderPicture`'s job. `undefined` — no host, not asked,
   * still loading, a 404, any error, or a gateway that never sent the endpoint
   * — draws the tinted initial exactly as `UserBubble` always has; nothing
   * here distinguishes those cases from one another, because `Avatar` draws the
   * same fallback for all of them.
   */
  resolveSenderPictureUri?: (author: MessageAuthor) => string | undefined
  /** Ask for a colleague's picture. Called from an effect, never during render. */
  requestSenderPicture?: (author: MessageAuthor) => void
  /**
   * Hear when any picture changes, so a row showing one can re-read its own
   * and repaint — rows are memoised on this context's identity, which a
   * picture arriving does not change.
   */
  subscribeSenderPictures?: (listener: () => void) => () => void
}

// `onSelectText` is omitted rather than inherited: it is the list's own wiring to
// its own modal, and a host that passed one would be overriding the only thing
// that can keep that modal mounted.
export interface TranscriptListProps extends Omit<TranscriptContext, 'onSelectText'> {
  items: VisibleItem[]
  /** Pinned above the list — the `AgentsBar` slot. */
  header?: ReactNode
  /** A turn is running but no text has arrived: shows the typing bubble. */
  typing?: boolean
  /**
   * One row lit up for a moment, because something outside the chat pointed at it.
   *
   * A flat wash behind the row rather than anything on the bubble itself: the
   * bubbles carry the chat's accent and the roles' own colours, and repainting
   * one of those to mean "here" would say something about the message instead of
   * about the reader's arrival at it.
   */
  highlightItemId?: string
  /** Messages that landed while the reader was scrolled away. */
  newMessageCount?: number
  onScrolledAwayFromBottom?: (away: boolean) => void
  /** Older history: fired at the far (visually top) end. */
  onEndReached?: () => void
  /** A page of older history is in the air: draw the row that says so. */
  loadingOlder?: boolean
  /** Receipt on the last own bubble's metadata line. */
  receipt?: Receipt
  contentStyle?: ViewStyle
  testID?: string
}

/** What a screen may ask the list to do; see `scrollToItem`. */
export interface TranscriptListHandle {
  /**
   * Bring one item into view.
   *
   * This is how Activity's "open chat at message" deep link lands on the row it
   * names rather than at the bottom of the chat. Returns false when that item is
   * not in the visible set — a chat filtered to Quiet genuinely does not show
   * every row, and silently scrolling somewhere else would be a lie.
   */
  scrollToItem: (itemId: string) => boolean
  scrollToLatest: () => void
}

interface RowProps {
  entry: VisibleItem
  context: TranscriptContext
  receipt?: Receipt
  layout: RowLayout
  dmRole?: DmRowRole
}

/**
 * The receipt an answered question leaves behind.
 *
 * `Allowed once · rm -rf ./build` — the decision AND what it was about, on one
 * line, truncated so a long command cannot push the decision off the row. A
 * question the user answered somewhere else says so instead; a withdrawn one says
 * that.
 */
function outcomeLabel(item: ApprovalItem | ClarifyItem): string {
  if (item.state === 'cancelled') {
    return chatStrings.approval.answeredElsewhere
  }

  if (item.kind === 'clarify') {
    const answered = Object.keys(item.answers).length

    return chatStrings.clarify.outcome(answered, item.questions.length)
  }

  const decision = chatStrings.approval.outcomes[item.answer ?? ''] ?? chatStrings.approval.answered(item.answer ?? '')
  const command = clipInline(item.command, 48)

  return command ? `${decision} · ${command}` : decision
}

function RequestRow({
  item,
  presentation,
  onOpen,
  onRespond
}: {
  item: ApprovalItem | ClarifyItem
  presentation: Presentation
  onOpen?: (item: ApprovalItem | ClarifyItem) => void
  onRespond?: (item: ApprovalItem, choice: string) => void
}) {
  const theme = useTheme()
  const maxWidth = useLedgerWidth()

  if (presentation === 'hidden-placeholder') {
    return null
  }

  const approval = item.kind === 'approval'
  const title = approval ? chatStrings.approval.title : chatStrings.clarify.title

  // An answered question stays in the transcript as a one-line receipt, in the
  // place the question was asked. "Answered: once" alone said nothing about WHAT
  // was allowed, which is the only part worth keeping afterwards.
  if (item.state !== 'open') {
    return (
      <Chip
        centered
        label={outcomeLabel(item)}
        testID={`request-${item.id}`}
        tone={
          item.state === 'answered' && item.kind === 'approval' && item.answer === 'deny' ? 'dangerText' : 'textFaint'
        }
      />
    )
  }

  return (
    <GlassSurface
      contentStyle={{ gap: theme.space.sm, padding: theme.space.md }}
      style={{ borderColor: theme.accent().fill, maxWidth }}
      testID={`request-${item.id}`}
      variant="card"
    >
      <Text variant="name">{title}</Text>
      <Text color="textMuted" numberOfLines={2} variant="preview">
        {approval ? (item as ApprovalItem).command : ((item as ClarifyItem).questions[0]?.question ?? '')}
      </Text>
      {/*
        The choices, here, in the server's order.

        An approval is a closed question — the gateway said exactly which
        answers it will accept — so there is nothing the sheet can ask that this
        card cannot. A clarify is not: it can be several questions, some of them
        free text, so it keeps the `Answer` button and the sheet that can hold a
        stepper.
      */}
      {approval && onRespond ? (
        <View style={{ gap: theme.space.sm }}>
          {(item as ApprovalItem).choices.map(choice => (
            <Button
              key={choice}
              onPress={() => onRespond(item as ApprovalItem, choice)}
              style={{ alignSelf: 'flex-start' }}
              testID={`request-choice-${item.id}-${choice}`}
              title={chatStrings.approval.choices[choice] ?? choice.replace(/_/gu, ' ')}
              variant={choice === 'deny' ? 'danger' : choice === 'once' ? 'primary' : 'secondary'}
            />
          ))}
        </View>
      ) : null}

      {onOpen ? (
        // Content width, not card width. The card is capped at the ledger's, and
        // on a wide window that cap is 640pt — an `Answer` running all of it
        // reads as the card's own footer rather than as one control in it.
        // `Button` has no width of its own, so the caller states it, the way
        // `AttachMenu` and `ClarifySheet` do.
        <Button
          onPress={() => onOpen(item)}
          style={{ alignSelf: 'flex-start' }}
          testID={`request-open-${item.id}`}
          title={chatStrings.transcript.answer}
          variant={approval && onRespond ? 'secondary' : 'primary'}
        />
      ) : null}
    </GlassSurface>
  )
}

function groupChildren(item: TranscriptItem, subagents: Record<string, Subagent>): Subagent[] {
  if (item.kind !== 'subagent_group') {
    return []
  }

  return item.rootIds.map(id => subagents[id]).filter((child): child is Subagent => Boolean(child))
}

/** The cron card, wired to the shared disclosure store. */
function CronRow({ item, context }: { item: CronDeliveryItem; context: TranscriptContext }) {
  const [expanded, toggle] = useExpanded(item.id)

  return (
    <CronDeliveryCard
      body={item.body}
      expanded={expanded}
      // The projection flags a name that came back as the redactor's placeholder.
      // Titling a card with `[REDACTED - redaction failed]` would read as the job's
      // actual name, so the card says nothing about the name instead.
      name={item.nameRedacted ? chatStrings.cron.unnamed : item.jobName}
      onLinkPress={context.onLinkPress}
      {...(context.onOpenCron && (context.canOpenCron?.(item.jobName) ?? true)
        ? { onOpenCron: () => context.onOpenCron?.(item.jobName) }
        : {})}
      {...(context.onRunCron ? { onRunNow: () => context.onRunCron?.(item.jobName) } : {})}
      onToggle={toggle}
      testID={`cron-delivery-${item.id}`}
      {...(item.ts !== undefined ? { ts: item.ts } : {})}
    />
  )
}

/**
 * Does this row put anything on the screen at all?
 *
 * The wrapper that carries the gap is rendered for EVERY row, including the ones
 * that draw nothing, so the gap has to know. A run of five dispatches swallowed
 * by a collapsed roll-up is one line by the time the reader sees it, and it used
 * to cost one turn gap per swallowed row — fifty points of nothing between the
 * roll-up and the next bubble.
 *
 * `cron_delivery` is the one kind whose card ignores `hidden-placeholder` and
 * draws either way, so the first rule does not cover it.
 */
function rowDraws(entry: VisibleItem, dmRole: DmRowRole | undefined, runExpanded: boolean): boolean {
  if (entry.presentation === 'hidden-placeholder' && entry.item.kind !== 'cron_delivery') {
    return false
  }

  return dmRole?.role !== 'rollupMember' || runExpanded
}

/**
 * One bot-to-bot aside, either direction, which may be swallowed by a roll-up.
 *
 * One component for both, because the reader sees one row: a dispatch and the
 * answer to it are the same silhouette, they roll up into the same run, and the
 * only difference between them is the header and whether there is a delivery
 * marker to show.
 *
 * A member of a collapsed run renders NOTHING — not a hidden view, nothing at all
 * — so the run really is one line tall until it is opened. `TranscriptRowFrame`
 * asks the same question a second time, because the gap around a row that draws
 * nothing must go with it.
 */
function DmAsideRow({ entry, context, role }: { entry: VisibleItem; context: TranscriptContext; role?: DmRowRole }) {
  const runId = role?.role === 'rollupMember' ? role.runId : role?.role === 'rollupHead' ? role.run.id : ''
  const runExpanded = useRollupExpanded(runId)
  const item = entry.item

  if (!isDmRow(item)) {
    return null
  }

  const line = (
    <BotDmAside
      // An inbound message gains "↩︎ answered" once this bot has replied.
      // `answersOurDispatch` is the engine's own attribution pass
      // (`attributeBotReplies`), so the marker is not guessed at here.
      answered={item.kind === 'bot_dm_in' && (item.answersOurDispatch ?? false)}
      item={item}
      onLinkPress={context.onLinkPress}
      {...(context.onOpenBot ? { onOpenBot: context.onOpenBot } : {})}
      presentation={entry.presentation}
      targetTyping={item.kind === 'bot_dm_out' && (context.typingHandles?.includes(item.targetHandle) ?? false)}
    />
  )

  if (role?.role === 'rollupHead') {
    return (
      // Expanded, the summary sits above the run's own first line, and §6.6's
      // nine points separate them exactly as they separate the lines below.
      <View style={runExpanded ? { gap: DM_LINE_GAP } : undefined}>
        <BotDmRollup run={role.run} />
        {runExpanded ? line : null}
      </View>
    )
  }

  if (role?.role === 'rollupMember') {
    return runExpanded ? line : null
  }

  return line
}

/**
 * Is this row the READER'S OWN message?
 *
 * True unless three things all hold: the host says this is the group chat,
 * the host knows the reader's own identity, and the row's `author` names
 * somebody else (HERM-83, D3). Any one of those missing is the safe default —
 * a personal sub-chat, a branch, a retired conversation, an identity not yet
 * loaded, or a row with no `author` at all all draw exactly as they did before
 * `author` existed: the reader's own, right-aligned, in the chat's accent.
 */
function isOwnUserItem(item: UserItem, context: TranscriptContext): boolean {
  if (!context.groupChat || !context.ownAuthorId || !item.author) {
    return true
  }

  return item.author.id === context.ownAuthorId
}

const NO_PICTURES = (): (() => void) => () => undefined

/**
 * This row's colleague's picture, and a repaint when it arrives (HERM-120).
 *
 * Subscribed per row, so one picture landing repaints the rows that show THAT
 * person and no others, and asked for from an effect rather than during render.
 * `author` is `undefined` for everything that is not a colleague's `user` row,
 * which reads nothing and asks for nothing.
 */
function useSenderPicture(author: MessageAuthor | undefined, context: TranscriptContext): string | undefined {
  const { requestSenderPicture, resolveSenderPictureUri, subscribeSenderPictures } = context
  // Only a colleague's row listens at all: a reply or a tool card has no
  // picture to wait for, and a transcript mounts dozens of them.
  const uri = useSyncExternalStore((author && subscribeSenderPictures) || NO_PICTURES, () =>
    author && resolveSenderPictureUri ? resolveSenderPictureUri(author) : undefined
  )
  const authorId = author?.id

  useEffect(() => {
    if (authorId && requestSenderPicture) {
      requestSenderPicture({ id: authorId })
    }
  }, [authorId, requestSenderPicture])

  return uri
}

function RowView({ entry, context, receipt, layout, dmRole }: RowProps) {
  const { item, presentation } = entry
  const own = item.kind === 'user' && isOwnUserItem(item, context)
  const colleague = item.kind === 'user' && !own ? item.author : undefined
  const senderPictureUri = useSenderPicture(colleague, context)

  switch (item.kind) {
    case 'user': {
      const sender =
        !own && item.author
          ? {
              authorId: item.author.id,
              name: senderLabel(item.author, context.resolveSenderName),
              ...(senderPictureUri ? { pictureUri: senderPictureUri } : {})
            }
          : undefined

      return (
        <UserBubble
          {...(context.accent ? { accent: context.accent } : {})}
          {...(context.attachmentUri ? { attachmentUri: context.attachmentUri } : {})}
          grouped={layout.grouped}
          item={item}
          onLinkPress={context.onLinkPress}
          {...(context.onOpenAttachment ? { onOpenAttachment: context.onOpenAttachment } : {})}
          own={own}
          presentation={presentation}
          receipt={receipt}
          {...(sender ? { sender } : {})}
          tail={layout.tail}
        />
      )
    }

    case 'assistant':
      return (
        <AssistantBubble
          grouped={layout.grouped}
          item={item}
          {...(context.images ? { images: context.images } : {})}
          onLinkPress={context.onLinkPress}
          onRetry={context.onRetry ? () => context.onRetry?.(item.id) : undefined}
          presentation={presentation}
          showFooter={presentation === 'full' && !item.streaming}
          tail={layout.tail}
        />
      )

    case 'tool': {
      /*
        A question waiting on THIS call, if the host can say which call it is.

        `approvalForTool` is the host's, because the gateway's approval names a
        tool and carries no call id — see the note on `TranscriptContext`. The
        responder is the same one the request card uses, so an answer given
        here and an answer given there are one code path.
      */
      const waiting = context.approvalForTool?.(item)
      const respond = context.onRespondApproval

      return (
        <ToolCard
          {...(waiting && respond
            ? { approval: { choices: waiting.choices, onRespond: (choice: string) => respond(waiting, choice) } }
            : {})}
          item={item}
          presentation={presentation}
        />
      )
    }

    case 'bot_dm_in':
    case 'bot_dm_out':
      return <DmAsideRow context={context} entry={entry} role={dmRole} />

    case 'subagent_group':
      return (
        <SubagentGroupCard
          item={item}
          onOpenTranscript={context.onOpenTranscript}
          presentation={presentation}
          subagents={groupChildren(item, context.subagents ?? {})}
        />
      )

    case 'status':
      return <StatusRow item={item} presentation={presentation} />

    case 'notice':
      return <NoticePill item={item} presentation={presentation} />

    case 'approval':
    case 'clarify':
      return (
        <RequestRow
          item={item}
          onOpen={context.onOpenRequest}
          {...(context.onRespondApproval ? { onRespond: context.onRespondApproval } : {})}
          presentation={presentation}
        />
      )

    // A cron delivery is a machine event, not the owner's own bubble — which is
    // exactly what it used to render as. See ADR-0013 for why the projection has
    // to guess at all.
    case 'cron_delivery':
      return <CronRow context={context} item={item} />

    default:
      return null
  }
}

const TranscriptRow = memo(RowView, sameRow)

/**
 * The one thing `version` cannot answer.
 *
 * `version` is bumped by the REDUCER, so it is an exact change key for anything
 * the gateway said. Show thinking is not that: `visibleItems` answers it at read
 * time by handing this row a copy of the same item with `reasoning` stripped —
 * same id, same version, same presentation. So the key above called the two
 * identical and the transcript kept drawing thoughts after the switch was off
 * (and drew none after it was switched on, until the next frame from the
 * gateway bumped the version for an unrelated reason).
 *
 * Two identity checks rather than a deep compare: that copy is the only place a
 * transcript item is ever rebuilt outside the reducer, and it differs in exactly
 * these two fields.
 */
function sameThought(previous: TranscriptItem, next: TranscriptItem): boolean {
  if (previous.kind !== 'assistant' || next.kind !== 'assistant') {
    return true
  }

  return previous.reasoning === next.reasoning && previous.reasoningVerbose === next.reasoningVerbose
}

/** The gap a row opens above itself. Speech rhythm, or §6.6's ledger one. */
function gapAbove(layout: RowLayout): number {
  // A date stamp owns the boundary it opens: it carries the author-change gap
  // above it and 4pt below, and a row margin stacked on top of that is 48pt of
  // nothing between two days.
  if (layout.dateStamp) {
    return 0
  }

  return layout.grouped ? BUBBLE_GAP.grouped : layout.ledgerRun ? DM_LINE_GAP : BUBBLE_GAP.separate
}

/**
 * One row, and the gap above it.
 *
 * A component rather than inline JSX inside `renderItem`, because whether there
 * is a gap is a question about whether there is a ROW, and a collapsed roll-up's
 * membership is disclosure state that only a hook can read.
 *
 * `marginTop` on an INVERTED list is not the mistake it looks like. A cell
 * carries the list's inversion a second time, so what is inside one still reads
 * top to bottom on screen; only the order of the cells is reversed. The gap
 * above a row is therefore the row's own margin, which is what lets it say
 * whether it continues the run above it.
 */
/**
 * The two `onLayout` hooks the scroll trace needs, and nothing when it is off.
 *
 * Both are spread props rather than always-present callbacks on purpose: an
 * `onLayout` on every row is a measurement callback per row per layout pass, and a
 * virtualised transcript is the one place in the app where that is a real cost. With
 * the flag down this returns two frozen empty objects, so the rows render exactly as
 * they did before the trace existed.
 *
 * The WRAPPER height is the row's contribution to the content, gap included. The
 * CONTENT height is what the row actually drew. A wrapper with height over content
 * with none is a blank row — the sixty points of nothing the owner photographed.
 */
type LayoutHook = { onLayout?: (event: LayoutChangeEvent) => void }

function useRowTrace(key: string): { wrapper: LayoutHook; content: LayoutHook } {
  const wrapper = useRef(0)

  return useMemo(() => {
    if (!TRACING) {
      return { content: {}, wrapper: {} }
    }

    return {
      content: {
        onLayout: (event: LayoutChangeEvent) => traceBlankRow(key, wrapper.current, event.nativeEvent.layout.height)
      },
      wrapper: {
        onLayout: (event: LayoutChangeEvent) => {
          wrapper.current = event.nativeEvent.layout.height
          traceRow(key, wrapper.current)
        }
      }
    }
  }, [key])
}

/**
 * The memo boundary the LIST re-renders against, and the one that was missing.
 *
 * `TranscriptRow` has always been memoized, which keeps a settled bubble's
 * Markdown from being parsed again — and `VirtualizedList` never reached it.
 * The list re-renders on its own state whenever the render window moves, which
 * during a fling is every frame; `CellRenderer` has no `shouldComponentUpdate`,
 * so it calls `renderItem` again, so THIS function ran for every mounted row on
 * every frame. Sixty-odd rows' worth of hooks, a `ContextMenuHost` and two
 * wrapper views, sixty times a second, for rows where nothing had changed.
 *
 * Measured at 4× CPU on a 390-row transcript — see docs/platform-notes.md.
 *
 * The same comparator as the row inside it, because it is the same question.
 * The hooks below subscribe to the disclosure store and re-render this
 * component when THEY change, which memo does not interfere with.
 */
const TranscriptRowFrame = memo(TranscriptRowFrameView, (previous, next) => sameRow(previous, next))

function sameRow(previous: RowProps, next: RowProps): boolean {
  return (
    previous.entry.item.id === next.entry.item.id &&
    previous.entry.item.version === next.entry.item.version &&
    sameThought(previous.entry.item, next.entry.item) &&
    previous.entry.presentation === next.entry.presentation &&
    previous.receipt === next.receipt &&
    previous.layout === next.layout &&
    previous.dmRole === next.dmRole &&
    previous.context === next.context
  )
}

function TranscriptRowFrameView({ entry, context, receipt, layout, dmRole }: RowProps) {
  /*
    A memo boundary does not follow the root's re-render.

    `App` subscribes to the locale so a language switch repaints the tree under
    it, and that works everywhere the tree is walked — which is everywhere
    except behind a `React.memo` whose props did not change. A transcript is
    exactly that case: the rows are memoised on purpose, so after a switch an
    open conversation would have gone on saying "Delivered" and "Show more" in
    the old language until something else moved.

    One subscription per mounted row, which is a set entry each on a
    virtualised list of a few dozen.
  */
  useFollowsLocale()

  const runId = dmRole?.role === 'rollupMember' ? dmRole.runId : ''
  const runExpanded = useRollupExpanded(runId)
  const menu = useMessageMenu(entry.item, context)
  const trace = useRowTrace(`${entry.item.kind}-${entry.item.id}`)

  if (!rowDraws(entry, dmRole, runExpanded)) {
    return null
  }

  return (
    <View {...trace.wrapper} style={{ marginTop: gapAbove(layout) }} testID={`transcript-row-${entry.item.id}`}>
      {/*
        The stamp comes FIRST, above the row it heads.

        A cell carries the list's inversion a second time, so what is inside one
        reads top to bottom on screen and only the ORDER OF CELLS is reversed —
        see docs/platform-notes.md. This used to sit after the row, on the belief
        that the inversion applied here too, which put every date stamp under the
        first message of its day instead of over it.
      */}
      {layout.dateStamp ? <DateSeparator label={layout.dateStamp} /> : null}

      {/*
        The whole row is the menu's target, not the bubble inside it. A secondary
        click on the metadata line under a reply, or on the gap beside a short one,
        means the same message — and UIKit lifts the target into the menu's preview,
        so a target that was only the text would lift only the text.
      */}
      <ContextMenuHost
        // A transcript row is as wide as the window and as tall as a reply, so
        // the pointer highlight a list row wants is, here, a blurred platter the
        // size of a message following the mouse across the conversation — which
        // is what the owner reported from the Mac build. Nothing about a
        // paragraph of text is a button; the menu still opens on a secondary
        // click, it just stops advertising itself on the way past.
        hoverEffect={false}
        items={menu.items}
        menuTitle={chatStrings.menu.message}
        onSelect={menu.select}
        // Unlike a chat row, this one is NOT the button — it holds several small
        // ones of its own: `Show more` on a folded reply, a tool card's own
        // disclosure, a reasoning toggle. Without this a click on one of those
        // sometimes did nothing at all, on a Mac: the interaction and the
        // `Pressable` underneath raced the same indirect-pointer click, and
        // whichever lost left the reader's tap unanswered. See
        // `HermieContextMenuView.setPassThroughButtons`.
        passThroughButtons
        testID={`transcript-menu-${entry.item.id}`}
      >
        <View {...trace.content}>
          <TranscriptRow
            context={context}
            {...(dmRole ? { dmRole } : {})}
            entry={entry}
            layout={layout}
            {...(receipt ? { receipt } : {})}
          />
        </View>
      </ContextMenuHost>
    </View>
  )
}

/**
 * The message's own menu, and what a selection from it does.
 *
 * `hasDetails` is narrower than it looks, and deliberately so: the only disclosure
 * the shared `expanded` store OWNS for a plain item id is the cron card's. A tool
 * card keeps its own `useState` — with a third state, "the reader has not decided",
 * that a boolean set cannot express — and a roll-up is keyed by run rather than by
 * item. So Show details is offered where it is actually connected, and the other two
 * keep their chevrons. Wiring those into the shared store is its own change.
 */
function useMessageMenu(
  item: TranscriptItem,
  context: TranscriptContext
): { items: ReturnType<typeof messageMenuItems>; select: (id: string) => void } {
  const [expanded, toggleExpanded] = useExpanded(item.id)
  const hasDetails = item.kind === 'cron_delivery'

  const items = useMemo(
    () =>
      messageMenuItems({
        // A colleague's turn in the group chat is never put back in the
        // composer under the reader's own name (HERM-83); `isOwnUserItem`
        // is the one place that question is answered, and it already draws
        // every row as the reader's own outside the group chat, before an
        // identity has loaded, or with no author at all.
        canEditResend: Boolean(context.onEditResend) && (item.kind !== 'user' || isOwnUserItem(item, context)),
        canOpenBot: Boolean(context.onOpenBot),
        // Three questions, answered by the only things that can: the host can
        // regenerate at all, this row is the newest reply, and — HERM-83 — the
        // turn a retry would repeat is the reader's own or unattributed. A
        // colleague's newest turn in the group chat fails the third and hides
        // the line rather than offering it disabled with an error.
        canRegenerate:
          Boolean(context.onRegenerate) &&
          context.lastAssistantId === item.id &&
          (context.regeneratePromptIsOwn ?? true),
        canBranch: Boolean(context.onBranch),
        // A capability, not a preference: the host passes a handler only where
        // the platform has a synthesiser at all.
        canReadAloud: Boolean(context.onReadAloud),
        reading: context.readingItemIds?.includes(item.id) ?? false,
        // A Mac question rather than a capability one. The panel renders
        // everywhere, but only where a pointer can drag across it does it offer
        // anything the long press does not already give.
        canSelectText: RUNS_ON_MAC && Boolean(context.onSelectText),
        detailsOpen: expanded,
        hasDetails,
        item,
        turnRunning: Boolean(context.turnRunning)
      }),
    // `item.version` is the engine's change key, so a streamed reply rebuilds the
    // menu's Copy lines and its links without deep-comparing the text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      context.groupChat,
      context.lastAssistantId,
      context.onBranch,
      context.onEditResend,
      context.onOpenBot,
      context.onReadAloud,
      context.onRegenerate,
      context.ownAuthorId,
      context.readingItemIds,
      context.regeneratePromptIsOwn,
      context.turnRunning,
      expanded,
      hasDetails,
      item,
      item.version
    ]
  )

  const select = useCallback(
    (id: string) => {
      const action = parseMessageMenuAction(id, item)

      switch (action?.kind) {
        case 'copyText':
        case 'copyMarkdown':
          copyToClipboard(action.text)

          return

        case 'copyLink':
          copyToClipboard(action.href)

          return

        case 'openBot':
          context.onOpenBot?.(action.handle)

          return

        case 'selectText':
          context.onSelectText?.(action.text)

          return

        /*
          Both refuse rather than fire while a turn is running.

          The menu already draws them disabled, and a disabled `UIMenu` item
          cannot be selected — but the fallback sheet draws a flat list, a
          keyboard can reach a row, and the turn can start between the menu
          opening and the tap. The guard is here because this is the one place
          all three paths meet.
        */
        case 'editResend':
          if (!context.turnRunning) {
            context.onEditResend?.(action.text, action.attachments)
          }

          return

        case 'regenerate':
          if (!context.turnRunning) {
            context.onRegenerate?.()
          }

          return

        /*
          No turn guard, and the menu does not draw this one disabled either.

          Branching takes nothing from the session it forks: `session.branch`
          copies the history so far into a new stored child and leaves the parent
          running. So unlike the two above it there is nothing in flight for it
          to collide with, and a reader who has just watched a reply go the wrong
          way should not have to wait for it to finish to fork before it.
        */
        case 'branch':
          context.onBranch?.(item.id, action.text)

          return

        /*
          No turn guard, deliberately.

          Reading is local and takes nothing from the gateway, so a reply that is
          still being written can be read — and the id is what the queue is keyed
          by, so a second selection on the same row stops it rather than starting
          a second copy. The text is read off the item at SELECTION time, which
          is what keeps a streamed reply from being spoken as the fragment its
          menu was built from.
        */
        case 'readAloud':
          context.onReadAloud?.(item.id, action.text)

          return

        case 'toggleDetails':
          toggleExpanded()

          return

        default:
          return
      }
    },
    [context, item, toggleExpanded]
  )

  return { items, select }
}

const AWAY_THRESHOLD = 32

/**
 * The ceiling on a programmatic jump. `onMomentumScrollEnd` normally arrives
 * first and clears the guard; this is what stops a jump that never reports
 * finishing — a list already at offset 0 emits no momentum at all — from freezing
 * the pill for good.
 */
const JUMP_SETTLE_MS = 600

/**
 * How long the reader's place is held after they open a disclosure.
 *
 * Long enough for the growth, the relayout it causes and the scroll event that
 * reports it; short enough that the reader's own next drag is never fought. A
 * drag releases the hold outright, so this is only the ceiling.
 */
const HOLD_SETTLE_MS = 400

/**
 * Sub-point drift is rounding, not a jump. The same half-point threshold UIKit
 * itself uses in `_adjustForMaintainVisibleContentPosition`.
 */
const HOLD_SLOP = 0.5

/**
 * How far the reader has to drag towards older messages before the keyboard is
 * put away, in points.
 *
 * Far enough that a settling finger or a rubber-band bounce is not a dismissal,
 * short enough that it happens while the drag is still going and reads as part of
 * it rather than as something that happened afterwards.
 */
const DISMISS_DRAG = 24

/**
 * The anchor held while the reader is scrolled away. One object, so toggling it
 * on does not hand the scroll view a new identity on every render.
 */
const AWAY_ANCHOR = { minIndexForVisible: 0 } as const

/** The same, for a turn whose last row is growing under the reader. */
const AWAY_ANCHOR_PAST_TAIL: Record<number, { minIndexForVisible: number }> = {}

/**
 * Which row the scroll view is allowed to anchor on.
 *
 * `maintainVisibleContentPosition` holds a VIEW still. On an inverted list the
 * newest row is cell 0, and cell 0 is laid out at content y = 0 — so its origin
 * is the one origin in the list that a growing cell 0 does **not** move.
 * Anchoring there while a reply streams therefore corrects for nothing, and
 * every row after it — which on screen is everything ABOVE, the history the
 * reader is actually reading — slides by the growth instead. That is the report:
 * an expanded reply, no fold left to open, and the paragraph under the reader's
 * eyes walking down the screen token by token.
 *
 * So the anchor has to be the first row that is NOT growing, which while a tail
 * is streaming is the row after it. The prepended rows — parked messages, the
 * typing dots — sit before the transcript in `rows`, so the streaming tail is at
 * `leading` and the first still row is the one after that.
 *
 * Anchoring past a row does not stop that row being corrected FOR: the native
 * loop takes the first subview at or after this index whose bottom edge is past
 * the offset, and a row inserted before the anchor still moves the anchor's
 * origin by its own height. All that changes is which view is believed to be
 * standing still.
 */
export function anchorFor(leading: number, streamingTail: boolean): { minIndexForVisible: number } {
  if (!streamingTail) {
    return AWAY_ANCHOR
  }

  const index = leading + 1

  // Memoized per index for the same reason `AWAY_ANCHOR` is a constant: a fresh
  // object every render is a new prop identity on the scroll view.
  AWAY_ANCHOR_PAST_TAIL[index] ??= { minIndexForVisible: index }

  return AWAY_ANCHOR_PAST_TAIL[index] as { minIndexForVisible: number }
}

/**
 * Has this drag gone far enough towards the history to put the keyboard away?
 *
 * **On an inverted list, "scroll up to read" is an offset that GROWS.** Offset 0
 * is the newest message, so the finger moving down the screen — the gesture every
 * messenger dismisses on — walks the offset upwards. That sign is the whole
 * reason this function exists rather than a `keyboardDismissMode` value:
 * `interactive` is set on iOS and does not behave on an inverted list, because
 * `inverted` is a `scaleY: -1` on the scroll view itself and UIKit's own
 * dismissal reads the pan in that flipped space — so it looks for a drag away
 * from the keyboard where the reader is making one towards it. The other two
 * suspects were checked and cleared: there is exactly ONE `KeyboardAvoidingView`
 * over this screen (the composer's own is off by default for precisely that
 * reason), and `keyboardShouldPersistTaps` governs taps, not drags.
 */
export function dismissesKeyboard(dragStartedAt: number | undefined, offset: number): boolean {
  return dragStartedAt !== undefined && offset - dragStartedAt > DISMISS_DRAG
}

/**
 * Where the list has to be put, given where the reader asked to stay.
 *
 * `held` is a TARGET, not a memory. That distinction is the whole of the
 * owner's second report — `Show more` still threw the transcript to the end of
 * the message — and it comes from how an inverted list grows.
 *
 * A cell's content origin is its BOTTOM edge on screen. So a body that opens
 * pins its own bottom and grows UPWARD, taking the line the reader was on up
 * with it, and the rest of the history above it moves by the same amount. The
 * previous version recorded the offset at the moment of the tap and restored
 * exactly that, which pins the bottom — and for a reader sitting at the bottom
 * of the conversation with the last message folded, "exactly that" is offset
 * zero: the correction put them at the END of the message they had just asked
 * to read. Nothing about it was a jump the list failed to catch; it was the
 * list catching the offset and holding it in the wrong place.
 *
 * The target is therefore the offset at the tap PLUS the growth, which keeps the
 * message's top edge where it was and lets it grow downward.
 *
 * **Which growth** is the third report. `Fold` predicts one from its own
 * unclipped body, and that is what the first frame has to go on — but a message
 * with a TABLE in it grows twice, and the table's pass is in nobody's
 * prediction. The CONTENT's own height cannot miss a stage, so `holdTarget`
 * takes the offset and content height recorded at the tap and the content
 * height as it is now, and answers where the reader belongs. Recorded on an
 * iPhone 17 Pro: the fold predicted 1165.3, the content grew by 1377.7, and the
 * 212.4pt between them is the text moving under the reader.
 *
 * Both are exported because they are the only part of this a test renderer can
 * watch. The rest is a scroll view moving.
 */
export function holdTarget(from: { offset: number; content: number }, content: number): number {
  return Math.max(0, from.offset + (content - from.content))
}

/**
 * Where the list has to be put, given the target and where it actually is.
 */

export function holdCorrection(held: number | undefined, offset: number): number | undefined {
  if (held === undefined || Math.abs(offset - held) <= HOLD_SLOP) {
    return undefined
  }

  return held
}

/** A stable empty array, so the context memo does not churn on every render. */
const EMPTY_HANDLES: readonly string[] = []

/**
 * The typing bubble's own row, at index 0 of the inverted list.
 *
 * It used to be pinned BELOW the scroll view, because a height that comes and
 * goes at the bottom of an inverted list moves the first cell's origin — which
 * is the view `maintainVisibleContentPosition` anchors on. That is still true,
 * and it is no longer a reason to keep it out: the anchor is only held while the
 * reader is scrolled AWAY from the bottom, where correcting for an inserted row
 * is precisely what a reader wants, and at the bottom there is no anchor to
 * move. So the dots can be what they look like — the last row of the transcript,
 * scrolling with the content, off screen the moment the reader goes up.
 *
 * One frozen object rather than a fresh one per render: it is the identity the
 * list's `keyExtractor` and row memo see.
 */
const TYPING_ROW = { typing: true } as const

/** The key the typing row keeps for as long as it exists. */
const TYPING_ROW_KEY = 'transcript-typing'

/** What the list holds: the items and the dots. Parked messages are not in it. */
type ListRow = VisibleItem | typeof TYPING_ROW

function isTypingRow(row: ListRow): row is typeof TYPING_ROW {
  return 'typing' in row
}

/** One shared object, so a row with no layout of its own still memoizes. */
const FALLBACK_LAYOUT: RowLayout = { grouped: false, ledgerRun: false, tail: true }

/**
 * Keep the previous object for every key whose value has not changed.
 *
 * A shallow compare one level down. A row layout is three scalars, so it settles
 * exactly; a roll-up HEAD carries a freshly built run object and therefore never
 * settles, which is deliberate — there is at most one head per run of dispatches,
 * and deep-comparing its item array to save one re-render would cost more than the
 * re-render does.
 */
function useStable<T extends object>(next: Record<string, T>): Record<string, T> {
  const previous = useRef<Record<string, T>>({})

  return useMemo(() => {
    const merged: Record<string, T> = {}

    for (const [key, value] of Object.entries(next)) {
      const before = previous.current[key]

      merged[key] = before && shallowEqual(before, value) ? before : value
    }

    previous.current = merged

    return merged
  }, [next])
}

function shallowEqual(a: object, b: object): boolean {
  const left = a as Record<string, unknown>
  const right = b as Record<string, unknown>
  const keys = Object.keys(left)

  if (keys.length !== Object.keys(right).length) {
    return false
  }

  return keys.every(key => left[key] === right[key])
}

export const TranscriptList = forwardRef<TranscriptListHandle, TranscriptListProps>(
  function TranscriptList(props, ref) {
    return <TranscriptListBody {...props} listRef={ref} />
  }
)

function TranscriptListBody({
  items,
  header,
  typing = false,
  highlightItemId,
  newMessageCount = 0,
  onScrolledAwayFromBottom,
  onEndReached,
  loadingOlder = false,
  receipt,
  contentStyle,
  testID = 'transcript-list',
  listRef: forwarded,
  ...handlers
}: TranscriptListProps & { listRef: React.ForwardedRef<TranscriptListHandle> }) {
  const theme = useTheme()
  const listRef = useRef<FlatList<ListRow>>(null)
  const [away, setAway] = useState(false)

  /**
   * On a Mac, a mouse drag across the transcript must select text rather than
   * scroll it. This is the surface the owner was dragging on when he asked, and
   * the list already holds the ref the fix needs — see `platform/pointer-drag`.
   * A no-op on every other platform.
   */
  useEffect(() => {
    applyDirectTouchPan(listRef.current)
  }, [])

  /**
   * The markdown the "Select text" panel is showing, or `null` for closed.
   *
   * The SOURCE rather than the item id, so the panel keeps showing what it was
   * opened on even if the row it came from scrolls out of the window and is
   * recycled — which on a long transcript is most of them.
   */
  const [selectingText, setSelectingText] = useState<string | null>(null)
  const openSelectText = useCallback((markdown: string) => setSelectingText(markdown), [])
  const closeSelectText = useCallback(() => setSelectingText(null), [])

  /**
   * The attachment the full-screen viewer is showing.
   *
   * Held HERE for the same reason the select-text panel is: the viewer is a
   * `Modal`, and a modal mounted from a virtualised row unmounts with the row
   * the moment the list recycles it — which, with a full-screen image over the
   * top, is as soon as the transcript scrolls underneath.
   *
   * A file that is not a picture never reaches this state. It has no viewer to
   * open, so it goes straight to the host's handler, which hands it to the
   * share sheet or downloads it.
   */
  const [viewing, setViewing] = useState<GalleryAttachment | null>(null)
  const closeViewer = useCallback(() => setViewing(null), [])

  /*
    The host's handler is reached through a REF, not through the dependency
    array.

    `handlers` is the props object and is new on every render, so depending on
    it rebuilt this callback each time, which rebuilt the context, which is the
    one thing `transcript-memo.test.tsx` exists to prevent — every settled row
    re-rendered on every streaming delta. The ref keeps the callback's identity
    stable while still calling whatever the host passed most recently.
  */
  const openFile = useRef(handlers.onOpenAttachment)

  openFile.current = handlers.onOpenAttachment

  const openAttachment = useCallback((attachment: GalleryAttachment) => {
    if (attachment.uri) {
      setViewing(attachment)

      return
    }

    openFile.current?.(attachment)
  }, [])

  const context = useMemo<TranscriptContext>(
    () => ({
      accent: handlers.accent,
      images: handlers.images,
      onLinkPress: handlers.onLinkPress,
      canOpenCron: handlers.canOpenCron,
      onOpenBot: handlers.onOpenBot,
      onOpenCron: handlers.onOpenCron,
      onOpenRequest: handlers.onOpenRequest,
      onRespondApproval: handlers.onRespondApproval,
      approvalForTool: handlers.approvalForTool,
      onOpenTranscript: handlers.onOpenTranscript,
      onRetry: handlers.onRetry,
      onRunCron: handlers.onRunCron,
      onSelectText: openSelectText,
      onOpenAttachment: openAttachment,
      ...(handlers.attachmentUri ? { attachmentUri: handlers.attachmentUri } : {}),
      /*
        The four MENU props, which were declared on `TranscriptContext` and never
        copied into the object the rows are actually given.

        They are listed one by one like everything else above rather than
        spread, because `handlers` is the whole rest of the props object and is
        new on every render — which is the note at the top of this memo. What
        that cost was invisible in the suites and total on the screen:
        `useMessageMenu` reads `context.onEditResend`, `context.onRegenerate`,
        `context.turnRunning` and `context.lastAssistantId`, every one of them
        came back `undefined`, and so `Edit and resend` and `Regenerate` were
        never drawn on any row in the app. The unit tests call
        `messageMenuItems` directly and passed throughout. `chat-screen` covers
        the round trip now.
      */
      onEditResend: handlers.onEditResend,
      onRegenerate: handlers.onRegenerate,
      turnRunning: handlers.turnRunning,
      ...(handlers.lastAssistantId ? { lastAssistantId: handlers.lastAssistantId } : {}),
      regeneratePromptIsOwn: handlers.regeneratePromptIsOwn,
      onReadAloud: handlers.onReadAloud,
      readingItemIds: handlers.readingItemIds,
      subagents: handlers.subagents ?? {},
      typingHandles: handlers.typingHandles ?? EMPTY_HANDLES,
      groupChat: handlers.groupChat,
      ownAuthorId: handlers.ownAuthorId,
      resolveSenderName: handlers.resolveSenderName,
      resolveSenderPictureUri: handlers.resolveSenderPictureUri,
      requestSenderPicture: handlers.requestSenderPicture,
      subscribeSenderPictures: handlers.subscribeSenderPictures
    }),
    [
      handlers.accent,
      handlers.images,
      handlers.onLinkPress,
      handlers.canOpenCron,
      handlers.onOpenBot,
      handlers.onOpenCron,
      handlers.onOpenRequest,
      handlers.onRespondApproval,
      handlers.approvalForTool,
      handlers.onOpenTranscript,
      handlers.attachmentUri,
      handlers.onRetry,
      handlers.onRunCron,
      handlers.onEditResend,
      handlers.onRegenerate,
      handlers.turnRunning,
      handlers.lastAssistantId,
      handlers.regeneratePromptIsOwn,
      handlers.onReadAloud,
      handlers.readingItemIds,
      openAttachment,
      openSelectText,
      handlers.subagents,
      handlers.typingHandles,
      handlers.groupChat,
      handlers.ownAuthorId,
      handlers.resolveSenderName,
      handlers.resolveSenderPictureUri,
      handlers.requestSenderPicture,
      handlers.subscribeSenderPictures
    ]
  )

  /**
   * Whole-list facts, computed in READING order and then reversed for the list.
   *
   * Both are STABILISED, not just memoized, and that distinction is the whole
   * point. A streaming delta produces a new `items` array, so both passes run
   * again and hand every row a freshly allocated layout object — which is a
   * different prop identity, which breaks `TranscriptRow`'s memo, which re-renders
   * every settled bubble on every token. Reusing the previous object wherever the
   * VALUE has not changed is what keeps `__tests__/chat-ui/transcript-memo` honest.
   */
  /*
    `speakerKey`'s own gate (HERM-83, D6): the group chat with the reader's
    identity known, and `undefined` everywhere else, which is what keeps a
    personal sub-chat, a branch and a retired conversation grouping exactly as
    they did before a row could carry an author at all.
  */
  const attributionOwnId = context.groupChat ? context.ownAuthorId : undefined
  const layout = useStable(useMemo(() => layoutRows(items, undefined, attributionOwnId), [items, attributionOwnId]))
  const dmRoles = useStable(useMemo(() => rollupDmRuns(items), [items]))

  // Inverted: newest first.
  const data = useMemo(() => [...items].reverse(), [items])

  if (TRACING) {
    // In the render body rather than in an effect, so the line lands BEFORE the
    // layout it describes rather than after it. A trace whose lines are in the
    // wrong order is worse than no trace: the whole question is what changed
    // height between two offsets.
    traceItems(
      `${items.length} rows, newest=${data[0]?.item.kind}:${data[0]?.item.id}${
        data[0]?.item.kind === 'assistant' && data[0].item.streaming ? ' streaming' : ''
      }`
    )
  }

  const lastOwnId = useMemo(() => {
    for (const entry of data) {
      // A colleague's message must never carry the reader's own receipt —
      // that is the exact defect HERM-83 fixes (§3): a foreign-attributed row
      // painted as the reader's own, ticks included.
      if (entry.item.kind === 'user' && !entry.item.unknownAuthor && isOwnUserItem(entry.item, context)) {
        return entry.item.id
      }
    }

    return undefined
  }, [context, data])

  /**
   * A streaming reply already on screen holds its own dots (§6.2), so the
   * standalone typing bubble must stand down the moment one exists. Drawing both
   * is what produced a bubble of dots under an empty grey rectangle.
   */
  const streamingTail = data[0]?.item.kind === 'assistant' && data[0].item.streaming

  /**
   * The rows the scroll view holds, dots included.
   *
   * Index 0 of an inverted list is the BOTTOM of the conversation, so prepending
   * the typing row is what puts it under the last message and nowhere else.
   */
  const showTyping = typing && !streamingTail
  const rows = useMemo<ListRow[]>(() => (showTyping ? [TYPING_ROW, ...data] : data), [data, showTyping])

  /**
   * How many rows sit between index 0 and the transcript's newest item.
   *
   * The dots, and nothing else. Parked messages used to be here too — they were
   * the reader's own bubbles at the end of the conversation — and they are a
   * strip over the composer now (`QueuedStrip`), which is why this can only ever
   * be nought or one. `anchorFor` needs it to name the row after the streaming
   * one.
   */
  const leadingRows = showTyping ? 1 : 0

  /**
   * A jump the LIST started, not the reader.
   *
   * `scrollToOffset({ animated: true })` emits a scroll event per frame on the way
   * down, and the first few are still far from the bottom — so the pill that was
   * just tapped reappeared for a moment mid-flight. Events are ignored until the
   * animation has landed.
   */
  const jumping = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * The reader's place across a disclosure opening.
   *
   * `offsetNow` is the last offset the scroll view reported; `holdingTo` is
   * where the list must END UP, worked out at the moment a `Show more` (or a
   * tool card, or a roll-up) was tapped. Not where it was — see
   * `holdCorrection`, which is where the difference between those two is the
   * whole bug.
   */
  const offsetNow = useRef(0)
  const holdingTo = useRef<number | undefined>(undefined)
  const holding = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Where the reader was, and how tall the content was, at the moment of the tap.
   *
   * The second number is what makes the hold correct rather than approximately
   * correct. A disclosure does NOT grow in one step: `Fold` can say how much
   * taller its own TEXT is about to be, because it measured the unclipped body,
   * but a message containing a table grows again when the table lays its columns
   * out, and that second stage is in nobody's prediction. Recorded on an iPhone
   * 17 Pro, opening the long report the fake gateway streams:
   *
   *     [scroll] +101310 offset=859.0   content=2103.0   ← the tap
   *     [row]    +108923 assistant-r:6 h=1676.7 (+1377.7)
   *     [scroll] +108926 offset=2024.3  content=3480.7
   *
   * The fold predicted 1165.3 and the row grew by 1377.7 — 212.4pt of table,
   * which is the number the owner reported the text moving by, twice.
   *
   * The CONTENT's own height is the one measurement that cannot miss a stage:
   * whatever the row does, in however many passes, it is in there. So the
   * prediction is only the first estimate, and every `onContentSizeChange` after
   * it replaces the target with the measured one.
   */
  const contentNow = useRef(0)
  const holdingFrom = useRef<{ offset: number; content: number } | undefined>(undefined)

  /**
   * How many rows the list had when the place was taken.
   *
   * A hold is a promise about ONE expansion. A row arriving underneath it — the
   * typing indicator appearing, a reply landing — changes the content by its own
   * height as well, and forcing the offset to a target computed before that row
   * existed would undo the correction the anchor just made and move the reader
   * by the row's height. So a changed row count retires the hold, the same way a
   * drag does.
   *
   * Counted over `rows` rather than over `items`, so the typing row is one of
   * them: the dots appearing or going is an insertion and a removal at index 0,
   * and it has to retire a hold for exactly the same reason a message does.
   */
  const rowCount = useRef(0)
  const holdingRows = useRef(0)

  // Read in the render body, below, where `rows` is what the list is about to
  // show. A ref rather than state: nothing renders differently because of it.
  rowCount.current = rows.length

  // A row came or went while a place was held; see `holdingRows`.
  if (rowCount.current !== holdingRows.current && holdingTo.current !== undefined) {
    holdingTo.current = undefined
  }

  /**
   * Where the current drag started, and `undefined` once the keyboard has been
   * put away for it. One dismissal per drag: `Keyboard.dismiss()` on every frame
   * of a long scroll is a native call per event for no further effect.
   *
   * It is armed on `onScrollBeginDrag` and deliberately NOT cleared when the
   * finger lifts. A flick up the history crosses the threshold during the
   * momentum that follows it, and that momentum is the same gesture.
   */
  const dragFrom = useRef<number | undefined>(undefined)

  const releaseHold = useCallback(() => {
    if (holding.current) {
      clearTimeout(holding.current)
      holding.current = null
    }

    holdingTo.current = undefined
    holdingFrom.current = undefined
  }, [])

  /**
   * Where the reader must end up, worked out at the moment of the tap.
   *
   * `growth` is what the row says it is about to add — see `Fold`, which is the
   * only place that number exists before the layout does. Adding it is what
   * keeps the opened message's TOP edge still and lets the body grow downward;
   * holding the bare offset pins its bottom instead, which on an inverted list
   * is how `Show more` used to land the reader at the end of the message.
   */
  const holdPlace = useCallback((_id: string, growth: number) => {
    // A browser has already done this, and doing it again is the whole of the
    // web report: `Show more` moves the reader by exactly the fold's growth.
    // See `platform/scroll-anchor.web.ts` for the measurement. Refused HERE, at
    // the tap, rather than at either correction site, so nothing downstream has
    // a target to aim at and the two sites stay one behaviour.
    if (ANCHORS_GROWTH_ITSELF) {
      return
    }

    if (holding.current) {
      clearTimeout(holding.current)
    }

    holdingTo.current = Math.max(0, offsetNow.current + growth)
    holdingFrom.current = { content: contentNow.current, offset: offsetNow.current }
    holdingRows.current = rowCount.current
    holding.current = setTimeout(() => {
      holding.current = null
      holdingTo.current = undefined
      holdingFrom.current = undefined
    }, HOLD_SETTLE_MS)
  }, [])

  /**
   * The correction, applied as soon as the content has actually changed size.
   *
   * `onContentSizeChange` is the earliest moment the scroll view can be moved to
   * a place that did not exist before the growth, and it fires in the same
   * commit as the layout rather than one scroll event later. The scroll handler
   * below still carries the same correction, because a growth that produces no
   * scroll event at all would otherwise never be answered — but by then the
   * reader has seen the frame this is meant to prevent.
   */
  const settleHold = useCallback((_width: number, height: number) => {
    const from = holdingFrom.current

    /*
     * Recorded on EVERY content change, not only while a place is held, and
     * that is the fourth `Show more` report.
     *
     * `contentNow` used to be written in two places — the scroll handler, and
     * the branch below. A reader who has opened a chat and not scrolled it has
     * produced no scroll event, so on an inverted list, sitting at the bottom
     * where offset really is 0, the content height this had on record was 0 as
     * well. `holdTarget` then read the growth as `height - 0` — the whole
     * transcript — and the hold aimed at a place the reader had never been.
     *
     * The height arrives here whether anything is holding or not, so there is
     * no reason for the record to depend on a hold existing. It is the state
     * every hold starts from.
     */
    if (height > 0) {
      contentNow.current = height
    }

    if (from && height > 0) {
      // Measured, not predicted. `holdTarget` is where the difference between
      // the two is the whole of the second `Show more` report.
      holdingTo.current = holdTarget(from, height)
    }

    const correction = holdCorrection(holdingTo.current, offsetNow.current)

    if (correction === undefined) {
      return
    }

    offsetNow.current = correction
    listRef.current?.scrollToOffset({ animated: false, offset: correction })
  }, [])

  useEffect(() => releaseHold, [releaseHold])

  const endJump = useCallback(() => {
    if (jumping.current) {
      clearTimeout(jumping.current)
      jumping.current = null
    }
  }, [])

  useEffect(() => endJump, [endJump])

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent

    traceScroll(contentOffset.y, contentSize.height, layoutMeasurement.height)

    offsetNow.current = contentOffset.y
    contentNow.current = contentSize.height

    if (dismissesKeyboard(dragFrom.current, contentOffset.y)) {
      dragFrom.current = undefined
      Keyboard.dismiss()
    }

    // A disclosure is growing: put the list back where the finger left it, and
    // say nothing about `away` — the offset it would read is the one being undone.
    const correction = holdCorrection(holdingTo.current, contentOffset.y)

    if (correction !== undefined) {
      listRef.current?.scrollToOffset({ animated: false, offset: correction })

      return
    }

    if (jumping.current) {
      return
    }

    // Inverted list: offset 0 IS the bottom of the conversation.
    setAway(contentOffset.y > AWAY_THRESHOLD)
  }, [])

  /**
   * Tell the screen about it in an EFFECT, not from inside the state updater.
   *
   * React runs an updater during the render phase, so calling the parent's setter
   * from there is "cannot update a component while rendering a different
   * component" — which React reports as an error and which really can drop the
   * update on the floor.
   */
  const notifyAway = useRef(onScrolledAwayFromBottom)

  notifyAway.current = onScrolledAwayFromBottom

  useEffect(() => {
    notifyAway.current?.(away)
  }, [away])

  /**
   * A drag is the reader deciding where to be, which outranks any hold. Same
   * callback as the one that ends a programmatic jump, for the same reason.
   */
  const beginDrag = useCallback(() => {
    dragFrom.current = offsetNow.current
    releaseHold()
    endJump()
  }, [endJump, releaseHold])

  /*
    Every scroll this component performs ITSELF is animated, and none of them is
    under Reduce Motion. That setting is not about durations, it is about a
    reader for whom a large moving field is unpleasant, and the largest moving
    field in this app is a transcript flying past a thousand points — so it is
    precisely the animation that setting means. A reader's own finger is never
    affected: this only reaches the three places the app moves the list.
  */
  const animatedScroll = !theme.reduceMotion

  const jump = useCallback(() => {
    if (jumping.current) {
      clearTimeout(jumping.current)
    }

    jumping.current = setTimeout(() => {
      jumping.current = null
    }, JUMP_SETTLE_MS)

    listRef.current?.scrollToOffset({ animated: animatedScroll, offset: 0 })
    setAway(false)
  }, [animatedScroll])

  useImperativeHandle(
    forwarded,
    () => ({
      scrollToItem(itemId) {
        const index = rows.findIndex(row => !isTypingRow(row) && row.item.id === itemId)

        if (index < 0) {
          return false
        }

        // `viewPosition: 0.5` centres the row: a message scrolled to the very edge
        // of the screen reads as "the end of the chat", which is the one thing
        // this is meant to disprove.
        listRef.current?.scrollToIndex({ animated: animatedScroll, index, viewPosition: 0.5 })

        return true
      },
      scrollToLatest: jump
    }),
    [animatedScroll, rows, jump]
  )

  /**
   * `scrollToIndex` on a virtualised list can fail: the row's height is not
   * measured yet, so the list does not know where it is. The documented recovery
   * is to scroll to the best guess, let a frame render, and try once more — not to
   * leave the reader where they were with nothing having moved.
   */
  const recoverScroll = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      listRef.current?.scrollToOffset({ animated: false, offset: info.averageItemLength * info.index })

      setTimeout(() => {
        listRef.current?.scrollToIndex({ animated: animatedScroll, index: info.index, viewPosition: 0.5 })
      }, 80)
    },
    [animatedScroll]
  )

  const renderItem = useCallback(
    ({ item: entry }: { item: ListRow }) =>
      isTypingRow(entry) ? (
        /*
          The dots are a turn starting, so they open the same gap above them as
          any other change of speaker — `gapAbove` would say `BUBBLE_GAP.separate`
          for a row with no grouping, and this row can never be grouped.
        */
        <View style={{ marginTop: BUBBLE_GAP.separate }} testID={`${testID}-typing-slot`}>
          <TypingIndicator />
        </View>
      ) : (
        <View
          style={
            entry.item.id === highlightItemId
              ? {
                  backgroundColor: theme.glass.row.solid,
                  borderRadius: theme.radii.card,
                  marginHorizontal: -theme.space.sm,
                  paddingHorizontal: theme.space.sm
                }
              : undefined
          }
          testID={entry.item.id === highlightItemId ? `${testID}-highlight` : undefined}
        >
          <TranscriptRowFrame
            context={context}
            {...(dmRoles[entry.item.id] ? { dmRole: dmRoles[entry.item.id] } : {})}
            entry={entry}
            layout={layout[entry.item.id] ?? FALLBACK_LAYOUT}
            {...(entry.item.id === lastOwnId && receipt ? { receipt } : {})}
          />
        </View>
      ),
    [context, dmRoles, highlightItemId, lastOwnId, layout, receipt, testID, theme]
  )

  return (
    /*
      The disclosure state is provided HERE rather than around the whole
      component, because the list is what holds the reader's place across an
      expansion and `holdPlace` only exists inside this body.
    */
    <ExpandedProvider onToggle={holdPlace}>
      {/*
        The transcript IS the chat column, so it is the thing that knows how wide
        a bubble may be. See `BubbleColumn`.
      */}
      <BubbleColumn style={{ flex: 1 }} testID={testID}>
        {header}

        {/*
          The platform's own edge blur, taken off this list.

          iOS 26 draws a scroll edge effect on every scroll view, and on the Mac
          that effect covered the whole transcript and faded in when the POINTER
          entered it — every bubble going blurry on the way to the composer, which
          is what the owner reported. The chat already has real glass over both
          ends of this list, the header and the composer, so there is nothing for a
          second blur to do. See `platform/scroll-edges`.
        */}
        <PlainScrollEdges style={{ flex: 1 }}>
          <FlatList
            /*
              The far end of an INVERTED list is its footer, and that is the whole
              reason this is a footer rather than a header. `VirtualizedList` adds
              one to `minIndexForVisible` whenever a header exists, so a header
              here would take the anchor away from row 0 and undo the thing that
              makes a prepend hold its place — see the note on the anchor below.
              A footer costs the anchor nothing.
            */
            ListFooterComponent={
              loadingOlder ? (
                <View
                  style={{ alignItems: 'center', paddingBottom: theme.space.sm, paddingTop: theme.space.md }}
                  testID="transcript-loading-earlier"
                >
                  <Text color="textFaint" variant="meta">
                    {chatStrings.transcript.loadingEarlier}
                  </Text>
                </View>
              ) : null
            }
            ListEmptyComponent={
              <Text color="textMuted" style={{ padding: theme.space.lg, textAlign: 'center' }}>
                {chatStrings.transcript.empty}
              </Text>
            }
            contentContainerStyle={[
              { paddingHorizontal: theme.space.md, paddingVertical: theme.space.md },
              contentStyle
            ]}
            data={rows}
            /*
              The window, stated rather than defaulted.

              `VirtualizedList`'s defaults are `windowSize: 21` and
              `initialNumToRender: 10`, and 21 means twenty-one VIEWPORTS —
              about 16,000pt of a transcript mounted at once. That costs twice:
              every row in it is in the layout tree that a scroll handler's read
              of `scrollTop` has to flush (see the forced-reflow note in
              docs/platform-notes.md), and every one of them is a cell the list
              re-renders when its own window moves.

              Eleven is five viewports either side of the one being read, which
              is more than a fling at 240pt per frame can outrun in the ~200ms
              the list takes to fill in behind itself, and it is the number the
              measurement settled on: below it the far end of a fling starts
              showing blank rows on a transcript whose bubbles are tall.

              `initialNumToRender` is the FIRST screen, and on an inverted list
              that is the newest messages — the ones the reader opened the chat
              for. Ten of them is under one viewport of bubbles, so the chat
              opened half-drawn and filled in; fourteen covers it.
            */
            initialNumToRender={14}
            inverted
            keyExtractor={row => (isTypingRow(row) ? TYPING_ROW_KEY : row.item.id)}
            // Dragging the transcript down lowers the keyboard with the finger, which
            // is what every messenger does and what the inverted list makes possible
            // without a gesture handler. Android has no interactive dismissal — the
            // value is ignored there and the keyboard simply stays up — so it drops
            // the keyboard when the drag starts instead.
            keyboardDismissMode={Platform.select({ ios: 'interactive', default: 'on-drag' })}
            keyboardShouldPersistTaps="handled"
            /*
             * Held ONLY while the reader is away from the bottom, and that is the
             * whole of the reported jump.
             *
             * `maintainVisibleContentPosition` anchors on a VIEW: iOS records the
             * frame of the first subview whose bottom edge is past the current offset,
             * and afterwards moves `contentOffset` by however far that view's origin
             * moved (`RCTScrollViewComponentView`). At the bottom of an INVERTED list
             * every new row — the message just sent, the reply's first bubble, a tool
             * row, the bubble after it — is inserted BEFORE that view in content
             * order, so the anchor moves down by exactly the new row's height and the
             * list corrects for a shift the reader never saw. With
             * `autoscrollToTopThreshold` set, the same branch then animates back to
             * zero: the chat jumps up and scrolls itself back down, which is the bug
             * as it was reported.
             *
             * Measured on an iPhone 17 Pro against the fake gateway with
             * `--hermieTraceScroll`; a 70pt outgoing bubble moved the offset from 0 to
             * 94 (the row plus its gap) and it took ~290ms to crawl back:
             *
             *     [row]    +38626 user-o:7000 h=70.0 (new)
             *     [scroll] +38626 offset=94.0  content=968.0
             *     [scroll] +38654 offset=90.3  content=951.0   ← animating back
             *     [scroll] +38921 offset=0.0   content=951.0
             *
             * A constant-height `ListHeaderComponent` was tried as the anchor and
             * CANNOT be one: `VirtualizedList` adds one to `minIndexForVisible`
             * whenever a header exists ("Adjust index to account for
             * ListHeaderComponent"), so the native loop starts at the first CELL and
             * never looks at the header. There is no value of `minIndexForVisible`
             * that reaches it — which is why the header is gone rather than tuned.
             *
             * The typing row is an insertion and a removal at index 0 like any
             * other, and it is answered by the same two branches: away from the
             * bottom the anchor corrects for it, at the bottom there is nothing to
             * correct. That is what let the dots move into the list at all.
             *
             * Off at the bottom nothing has to be corrected: an inverted list already
             * keeps offset 0 pinned to the newest row while the content grows above
             * it. Away from the bottom the anchor is a genuinely visible row and the
             * correction is what the reader wants — a message arriving under them must
             * not shove the paragraph they are reading up the screen. So the prop is
             * on exactly where it earns its keep, and `autoscrollToTopThreshold` is
             * gone with it: it only ever fires within `AWAY_THRESHOLD` of the bottom,
             * which is where this is now off.
             */
            maintainVisibleContentPosition={away ? anchorFor(leadingRows, streamingTail) : undefined}
            /*
              Four rather than ten, and this is the one that moves p95.

              A batch is mounted inside ONE frame, and a transcript row is a
              bubble with Markdown in it rather than a line of text. The window
              above decides how much is mounted in the end; this decides how
              lumpy getting there is, and a fling mounts a viewport's worth
              every ~55ms whatever the window is — so the spikes are batches,
              not the window. Ten of these rows in a frame is the 40ms frame.

              Below four the list cannot keep up with a fling and the far end
              starts arriving blank, which is the floor this was chosen against.
            */
            maxToRenderPerBatch={4}
            onContentSizeChange={settleHold}
            onEndReached={onEndReached}
            onEndReachedThreshold={0.4}
            onMomentumScrollEnd={endJump}
            onScroll={handleScroll}
            onScrollBeginDrag={beginDrag}
            onScrollToIndexFailed={recoverScroll}
            ref={listRef}
            renderItem={renderItem}
            // A frame apart while tracing: a correction and the animated scroll back
            // to the bottom are two events inside 300ms, and at 64ms the first of
            // them is the one that gets dropped.
            scrollEventThrottle={TRACING ? 16 : 64}
            testID={`${testID}-scroll`}
            windowSize={11}
          />
        </PlainScrollEdges>

        {/*
          "Jump to latest" is the only thing left floating over the conversation.
          The typing bubble used to be pinned here beside it; it is a cell now —
          see `TYPING_ROW`.
        */}
        {/*
          It rises out of the composer it sits above, and sinks back into it. A
          pill that blinks on is the reader's own scroll being answered by
          something that was apparently always there.
        */}
        <Appear
          pointerEvents="box-none"
          rise={10}
          style={{ alignItems: 'center', bottom: theme.space.md, left: 0, position: 'absolute', right: 0 }}
          visible={away}
        >
          <JumpToLatestPill count={newMessageCount} onPress={jump} />
        </Appear>

        {/*
          Mounted HERE, from the list rather than from the row that opened it: a
          `Modal` inside a virtualised cell is unmounted the moment the cell
          recycles, which on a transcript happens while the reader is still
          reading what it shows.
        */}
        {selectingText === null ? null : (
          <SelectTextOverlay markdown={selectingText} onClose={closeSelectText} testID={`${testID}-select-text`} />
        )}

        {/* Same reason, same place: a full-screen image over a list that is
            still scrolling underneath it must not belong to a row. */}
        <ImageViewer
          onClose={closeViewer}
          testID={`${testID}-image-viewer`}
          uri={viewing?.uri ?? null}
          {...(viewing?.name ? { name: viewing.name } : {})}
        />
      </BubbleColumn>
    </ExpandedProvider>
  )
}
