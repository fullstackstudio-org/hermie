/**
 * The chat's (…) menu, as a popover in the chat.
 *
 * The owner's words: *"menu in een chat moet popover in een chat zijn. nu
 * schuift alles"* — a menu belonging to a chat has to be a popover in that chat,
 * and what was there instead was a bottom sheet. A sheet is a presentation: it
 * dims the window, it takes the keyboard, and on the compact shell it pushes the
 * transcript up to make room for itself. Every one of those is the screen
 * MOVING because somebody asked what their options were.
 *
 * So the first level is a floating glass surface anchored under the header,
 * drawn the way `chat-ui/AttachMenu.tsx` is drawn, for the same reasons that one
 * gives:
 *
 *  - it is `opaque`, because it floats over the transcript and a text-heavy wash
 *    over running text is two strings at the same weight in the same place;
 *  - it has no tail — a tail is a bubble's shape and a bubble is a thing somebody
 *    said. What says where it came from is the MOTION, which is why it drops out
 *    of the header (`rise` is negative) and sinks back into it;
 *  - it is absolutely positioned by its caller, so opening it lays nothing out.
 *    Nothing behind it moves. `__tests__/chat-options-popover.test.tsx` asserts
 *    that the transcript's own content inset is the same number with the popover
 *    open as without it, because "nothing moves" is the whole of the request and
 *    a padding that quietly changed would satisfy every other assertion here.
 *
 * ## What is on it, and what still opens a sheet
 *
 * The first level only: the two mode switches, the four disclosures that lead
 * somewhere, and the view group — verbosity, bot-to-bot, thinking, text size —
 * as compact rows. Anything that is a PAGE (the model picker, the colour
 * swatches, the mute spans, export, usage) still opens `ChatOptionsSheet` at
 * that page, through `onOpenPage`. A picker is a list as long as the gateway's
 * catalogue and a popover is not where a hundred models go.
 *
 * ## The keyboard
 *
 * ↑, ↓ and Return, through the same three shortcut actions the composer's
 * completion list uses — they are bare arrow keys and Tab, they are delivered
 * while a field holds the caret, and `useShortcut` is a stack, so a popover
 * opened over the composer takes them and gives them back when it closes. Escape
 * closes it, one level, through `useEscapeKey` for the same reason.
 *
 * The keyboard needs a flat list of things it can land on, and so does a test,
 * so the rows are DATA (`popoverRows`) rather than JSX with an index counted by
 * eye. A row that cannot be reached by ↓ is a row that does not exist, and the
 * only honest way to keep that true is for the arrow key and the renderer to
 * read the same array.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, ScrollView, View } from 'react-native'

import { ContextMeter } from '../../chat-ui/ContextMeter'
import { chatStrings } from '../../chat-ui/strings'
import type { Verbosity } from '../../chat-ui/types'
import { strings } from '../../i18n/strings'
import { Appear } from '../Appear'
import { GlassSurface } from '../glass'
import { Text } from '../primitives'
import { useTheme } from '../theme'
import { CONTROL_MIN_HEIGHT } from '../tokens'
import { useEscapeKey } from '../useEscapeKey'
import { useHover } from '../useHover'
import { useShortcut } from '../useShortcut'
import type { ChatOptionsSheetProps, ChatOptionsPane } from './ChatOptionsSheet'
import { DisclosureRow, SegmentedRow, SwitchRow } from './controls'
import { TEXT_SIZE_ORDER, type TextSize } from '../../store/text-size'

/**
 * How much room the popover needs before it is the honest answer.
 *
 * The rows are label-and-value pairs and the view group holds a three-segment
 * control, and below this the value column starts eliding — at which point a
 * popover is a sheet with less room, not a smaller sheet. The number is the
 * owner's: under 400pt it may still be a sheet. It is compared against the CHAT
 * COLUMN's measured width and never against the platform, because a Mac window
 * dragged narrow and a phone are the same problem and `Platform.OS` answers only
 * one of them.
 */
export const CHAT_POPOVER_MIN_WIDTH = 400

/** How wide the popover itself is drawn, when there is room for it. */
export const CHAT_POPOVER_WIDTH = 320

/** How tall it may get before its own list scrolls rather than the screen. */
export const CHAT_POPOVER_MAX_HEIGHT = 460

/**
 * Which rows the popover offers, in the order a ↓ walks them.
 *
 * `page` is the sheet this row opens, or absent for a row that is answered in
 * place. Pure, so the keyboard's arithmetic can be tested without a keyboard.
 */
export type PopoverRowId =
  | 'yolo'
  | 'fast'
  | 'reasoning'
  | 'model'
  | 'colour'
  | 'mute'
  | 'refresh'
  | 'branch'
  | 'new-chat'
  | 'conversations'
  | 'pin'
  | 'notifications'
  | 'verbosity'
  | 'bot-to-bot'
  | 'thinking'
  | 'text-size'
  | 'export'

export interface PopoverRow {
  id: PopoverRowId
  /** The page this row opens, when it opens one. */
  page?: ChatOptionsPane
}

export interface PopoverRowsInput {
  /** Absent removes the export row, the way it removes the group on the sheet. */
  canExport: boolean
  /** Absent removes the notifications row: nothing would read what it wrote. */
  canSetNotifications: boolean
  /** Absent removes Refresh, which is what a surface with no gateway gets. */
  canRefresh: boolean
  /**
   * Absent removes both conversation rows.
   *
   * One flag for the two, because they answer the same question — is there a
   * gateway holding this profile's other sessions — and a menu that offered to
   * branch but not to find the branch afterwards would be worse than one that
   * offered neither.
   */
  canBranch?: boolean
  /**
   * Absent removes the `new-chat` row: sub-chats (ADR-0007, amended). A row of
   * its own rather than folded into `canBranch` — a gateway can brand-new one
   * without accounts being configured at all, and a gateway with accounts can
   * still be reached before `canBranch` has anywhere to fork FROM.
   */
  canNewChat?: boolean
  /** Absent removes Pin: a surface with no arrangement has nowhere to store it. */
  canPin?: boolean
}

export function popoverRows({
  canBranch = false,
  canExport,
  canNewChat = false,
  canPin = false,
  canRefresh,
  canSetNotifications
}: PopoverRowsInput): PopoverRow[] {
  return [
    { id: 'yolo' },
    { id: 'fast' },
    { id: 'reasoning', page: 'reasoning' },
    { id: 'model', page: 'model' },
    { id: 'colour', page: 'colour' },
    { id: 'mute', page: 'mute' },
    ...(canPin ? [{ id: 'pin' as const }] : []),
    ...(canRefresh ? [{ id: 'refresh' as const }] : []),
    /*
      Branch, "New chat" under it, then the page that lists what both of them
      produced — all three about the CONVERSATION rather than about how this
      chat is set up or drawn, which is the distinction the separator above
      them already makes. `new-chat` has its own gate: a gateway can offer it
      with no `canBranch` at all, and vice versa.
    */
    ...(canBranch ? [{ id: 'branch' as const }] : []),
    ...(canNewChat ? [{ id: 'new-chat' as const }] : []),
    ...(canBranch ? [{ id: 'conversations' as const }] : []),
    ...(canSetNotifications ? [{ id: 'notifications' as const, page: 'notifications' as const }] : []),
    { id: 'verbosity' },
    { id: 'bot-to-bot' },
    { id: 'thinking' },
    { id: 'text-size' },
    ...(canExport ? [{ id: 'export' as const, page: 'export' as const }] : [])
  ]
}

/**
 * One row's box: the keyboard's ring, and the pointer's.
 *
 * Its own component because a hover needs a hook and the rows are built by a
 * helper inside the render. It wraps rather than replaces whatever the row
 * draws — a switch, a disclosure, a segmented control — so there is one place
 * that answers "is the pointer on this line" for all of them rather than a
 * hover added to three different controls and forgotten on the fourth.
 *
 * The keyboard's own ring wins where both are true: a reader driving with ↓ has
 * a mouse sitting somewhere over the list, and a hover that painted over the
 * selection would leave them unable to see where Return is going. Both use a
 * background rather than a border, for the reason `focusStyle` gives: a border
 * changes a row's height, and a menu whose rows resize as the selection moves is
 * the thing this component exists to stop doing.
 */
function PopoverRowBox({
  children,
  focused,
  testID
}: {
  children: React.ReactNode
  focused: { backgroundColor: string }
  testID: string
}) {
  const theme = useTheme()
  const hover = useHover()
  const lit = focused.backgroundColor !== 'transparent'

  return (
    <View
      style={[focused, !lit && hover.hovered ? { backgroundColor: theme.tintHover } : null, { cursor: 'pointer' }]}
      testID={testID}
      {...hover.props}
    >
      {children}
    </View>
  )
}

/**
 * Where the keyboard lands next.
 *
 * Clamped rather than wrapped: a menu whose selection jumps from the last row to
 * the first has told the reader nothing about having reached the end, and the
 * one below is the row they were aiming at more often than the one at the top.
 */
export function nextFocus(current: number, delta: number, count: number): number {
  if (count <= 0) {
    return 0
  }

  return Math.min(Math.max(current + delta, 0), count - 1)
}

export interface ChatOptionsPopoverProps extends Omit<
  ChatOptionsSheetProps,
  | 'visible'
  | 'onClose'
  | 'onClosed'
  | 'initialPane'
  | 'onExport'
  | 'pendingExpensiveModel'
  | 'confirmMessage'
  | 'onCancelExpensiveModel'
  | 'onConfirmExpensiveModel'
  | 'onPickExpensiveModel'
> {
  visible: boolean
  onClose: () => void
  /** Open the full sheet at this page. The popover closes first; the caller does both. */
  onOpenPage: (pane: ChatOptionsPane) => void
  /** Present only where there is a transcript to write out. */
  canExport?: boolean
  /** Present only where a notifier can honour per-type settings. */
  canSetNotifications?: boolean
  /**
   * Re-resolve this chat and replay it.
   *
   * Absent where there is no gateway to ask — the developer gallery. The
   * popover closes on it, because the thing the reader wants to look at is the
   * transcript and not this menu.
   */
  onRefresh?: () => void
  /**
   * Fork this conversation from its newest row.
   *
   * The menu's own "Branch from here…" is per ROW and is the precise one; this
   * is the same intention without having to find a row first, which is what a
   * reader who has just finished reading a reply actually wants. Absent where
   * there is no gateway to fork against.
   */
  onBranch?: () => void
  /** Open the Conversations page. Present exactly when `onBranch` is. */
  onOpenConversations?: () => void
  /**
   * Start another one of the reader's own chats (ADR-0007, amended). Present
   * only where this gateway can offer one at all — the `new-chat` row's gate.
   */
  onNewChat?: () => void
  /**
   * Whether this chat is pinned to the top of its folder, and a way to change
   * it. Both absent on a surface with no arrangement to store it in.
   */
  pinned?: boolean
  onTogglePin?: () => void
  /** This chat's transcript type scale, and a way to change it. */
  textSize: TextSize
  onChangeTextSize: (value: TextSize) => void
  /**
   * The "Shared Bot Chat / My chat" control, as a node (ADR-0007, amended).
   *
   * A SLOT rather than four props, because the control belongs to
   * `features/user-chats` and this file is `ui/` — a menu that imported a
   * feature to draw one of its rows would be the first edge from the kit into
   * the app. Absent on every surface that has no gateway identity to offer one,
   * which is the gallery and every session-token deployment.
   *
   * It sits above the first row and outside the ↓ ring: it is a segmented
   * control like the verbosity and text-size rows, which Return already treats
   * as a no-op.
   */
  chatChoice?: ReactNode
  /** The row menu's mute wording, already formatted by the caller. */
  muteLabel: string
  modelLabel: string
  reasoningLabel: string
  testID?: string
}

export function ChatOptionsPopover({
  visible,
  onClose,
  onOpenPage,
  canExport = false,
  canSetNotifications = false,
  onRefresh,
  onBranch,
  onOpenConversations,
  onNewChat,
  pinned = false,
  onTogglePin,
  accent,
  botName,
  contextUsage,
  yolo,
  onChangeYolo,
  fast,
  onChangeFast,
  muteLabel,
  modelLabel,
  reasoningLabel,
  chatChoice,
  verbosity,
  onChangeVerbosity,
  showBotToBot,
  onChangeShowBotToBot,
  showThinking,
  onChangeShowThinking,
  textSize,
  onChangeTextSize,
  viewOverridden,
  onResetView,
  testID = 'chat-options-popover'
}: ChatOptionsPopoverProps) {
  const theme = useTheme()
  const rows = popoverRows({
    canBranch: Boolean(onBranch && onOpenConversations),
    canExport,
    canNewChat: Boolean(onNewChat),
    canPin: Boolean(onTogglePin),
    canRefresh: Boolean(onRefresh),
    canSetNotifications
  })
  const [focus, setFocus] = useState(0)

  // A popover that reopens on the row the last reader left is a popover that
  // answers a different question than the one that was asked.
  useEffect(() => {
    if (visible) {
      setFocus(0)
    }
  }, [visible])

  useEscapeKey(onClose, visible)
  useShortcut('suggestionDown', () => setFocus(index => nextFocus(index, 1, rows.length)), visible)
  useShortcut('suggestionUp', () => setFocus(index => nextFocus(index, -1, rows.length)), visible)
  useShortcut(
    'suggestionAccept',
    () => {
      const row = rows[focus]

      if (row) {
        activate(row)
      }
    },
    visible
  )

  const activate = (row: PopoverRow) => {
    if (row.page) {
      onOpenPage(row.page)

      return
    }

    switch (row.id) {
      case 'yolo':
        onChangeYolo(!yolo)

        return
      case 'fast':
        onChangeFast(!fast)

        return
      case 'bot-to-bot':
        onChangeShowBotToBot(!showBotToBot)

        return
      case 'thinking':
        onChangeShowThinking(!showThinking)

        return
      case 'refresh':
        onRefresh?.()

        return
      case 'branch':
        onBranch?.()

        return
      case 'new-chat':
        onNewChat?.()

        return
      case 'conversations':
        onOpenConversations?.()

        return
      case 'pin':
        onTogglePin?.()

        return
      default:
        // Verbosity and text size are segmented: Return on them is a no-op
        // rather than a guess at which of three the reader meant.
        return
    }
  }

  /**
   * The ring the keyboard leaves behind.
   *
   * A background rather than a border, because a border changes a row's height
   * and a menu whose rows resize as the selection moves is the thing this whole
   * component exists to stop doing.
   */
  const focusStyle = (index: number) => ({
    backgroundColor: index === focus ? theme.tintSunk : 'transparent'
  })

  const row = (id: PopoverRowId, node: React.ReactNode) => {
    const index = rows.findIndex(entry => entry.id === id)

    if (index === -1) {
      return null
    }

    return (
      <PopoverRowBox focused={focusStyle(index)} key={id} testID={`${testID}-row-${id}`}>
        {node}
      </PopoverRowBox>
    )
  }

  return (
    <Appear
      rise={-10}
      style={{ alignSelf: 'flex-end', maxWidth: '100%', width: CHAT_POPOVER_WIDTH }}
      testID={`${testID}-appear`}
      visible={visible}
    >
      <GlassSurface
        contentStyle={{ maxHeight: CHAT_POPOVER_MAX_HEIGHT, paddingVertical: theme.space.xs }}
        opaque
        radius={theme.radii.card}
        shadow="float"
        testID={testID}
        variant="float"
      >
        <ScrollView keyboardShouldPersistTaps="handled">
          <View
            style={{ paddingBottom: theme.space.xs, paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm }}
          >
            <Text color="textFaint" variant="micro">
              {chatStrings.options.eyebrow.toUpperCase()}
            </Text>
            <Text numberOfLines={1} variant="name">
              {botName}
            </Text>
          </View>

          {chatChoice ? (
            <>
              {chatChoice}
              <Separator />
            </>
          ) : null}

          {row(
            'yolo',
            <SwitchRow
              hint={chatStrings.options.yoloHint}
              label={chatStrings.options.yolo}
              onChange={onChangeYolo}
              testID="option-yolo"
              value={yolo}
            />
          )}
          {row(
            'fast',
            <SwitchRow
              hint={chatStrings.options.fastHint}
              label={chatStrings.options.fast}
              onChange={onChangeFast}
              testID="option-fast"
              value={fast}
            />
          )}

          <Separator />

          {row(
            'reasoning',
            <DisclosureRow
              label={chatStrings.options.reasoning}
              onPress={() => onOpenPage('reasoning')}
              testID="option-reasoning"
              value={reasoningLabel}
            />
          )}
          {row(
            'model',
            <DisclosureRow
              label={chatStrings.options.model}
              onPress={() => onOpenPage('model')}
              testID="option-model"
              value={modelLabel}
            />
          )}
          {row(
            'colour',
            <DisclosureRow
              label={strings.layout.colour}
              onPress={() => onOpenPage('colour')}
              testID="option-colour"
              value={strings.layout.accents[accent]}
            />
          )}
          {row(
            'mute',
            <DisclosureRow
              label={strings.layout.mute}
              onPress={() => onOpenPage('mute')}
              testID="option-mute"
              value={muteLabel}
            />
          )}
          {/*
            Pin, with the row menu's wording and beside the other two things that
            are about this chat's place in the list rather than about the
            conversation in it.

            An ACTION rather than a switch, and the label is the one that says
            what pressing it will do rather than what is true now — the same
            reading Mute/Unmute already takes in both menus, so a reader meeting
            the two rows together is not asked to hold two conventions at once.
          */}
          {row(
            'pin',
            <Pressable
              accessibilityRole="button"
              onPress={() => onTogglePin?.()}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT, paddingHorizontal: theme.space.lg }}
              testID="option-pin"
            >
              <Text>{pinned ? chatStrings.sessions.unpin : chatStrings.sessions.pin}</Text>
            </Pressable>
          )}
          {/*
            Read-only, and the same row the sheet draws: a fact the reader checks
            their other choices against, not a choice of its own. It carries no
            chevron because there is nowhere for it to go.
          */}
          {contextUsage ? (
            <View
              style={{
                alignItems: 'center',
                flexDirection: 'row',
                gap: theme.space.sm,
                minHeight: CONTROL_MIN_HEIGHT,
                paddingHorizontal: theme.space.lg,
                paddingVertical: theme.space.sm
              }}
              testID="option-context"
            >
              <Text style={{ flex: 1 }}>{chatStrings.context.label}</Text>
              <ContextMeter detail usage={contextUsage} />
            </View>
          ) : null}

          <Separator />

          <Text
            color="textFaint"
            style={{ paddingHorizontal: theme.space.lg, paddingTop: theme.space.sm }}
            variant="micro"
          >
            {chatStrings.options.viewHeader.toUpperCase()}
          </Text>

          {/*
            Refresh: re-resolve the canonical chat, resume it and replay.

            An ACTION rather than a page, and a row rather than a pull-to-refresh
            gesture, because the case it is for is one a gesture cannot express:
            the gateway restarted, the runtime session id this chat was bound to
            no longer exists, and the transcript on screen is a transcript of a
            conversation nothing is listening to any more. A reader who suspects
            that needs a thing to press, and the pull gesture on an inverted
            transcript means "older messages".
          */}
          {row(
            'refresh',
            <Pressable
              accessibilityRole="button"
              onPress={() => onRefresh?.()}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT, paddingHorizontal: theme.space.lg }}
              testID="option-refresh"
            >
              <Text>{chatStrings.sessions.refresh}</Text>
            </Pressable>
          )}

          {/*
            Branch, and the page that lists what branching produced.

            "Branch from here…" on the MESSAGE menu forks at one row; this one
            forks at the newest, which is where a reader who has just read a
            reply already is. The ellipsis is kept on both, because both open
            something before anything is committed.
          */}
          {row(
            'branch',
            <Pressable
              accessibilityRole="button"
              onPress={() => onBranch?.()}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT, paddingHorizontal: theme.space.lg }}
              testID="option-branch"
            >
              <Text>{chatStrings.sessions.branch}</Text>
            </Pressable>
          )}

          {row(
            'new-chat',
            <Pressable
              accessibilityRole="button"
              onPress={() => onNewChat?.()}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT, paddingHorizontal: theme.space.lg }}
              testID="option-new-chat"
            >
              <Text>{chatStrings.conversations.newChat}</Text>
            </Pressable>
          )}

          {row(
            'conversations',
            <DisclosureRow
              label={chatStrings.sessions.conversations}
              onPress={() => onOpenConversations?.()}
              testID="option-conversations"
            />
          )}

          {row(
            'notifications',
            <DisclosureRow
              label={chatStrings.notifications.label}
              onPress={() => onOpenPage('notifications')}
              testID="option-notifications"
            />
          )}

          {row(
            'verbosity',
            <SegmentedRow
              label={chatStrings.options.verbosity}
              onChange={(value: Verbosity) => onChangeVerbosity(value)}
              options={[
                { label: chatStrings.options.verbosityOptions.quiet, value: 'quiet' },
                { label: chatStrings.options.verbosityOptions.normal, value: 'normal' },
                { label: chatStrings.options.verbosityOptions.verbose, value: 'verbose' }
              ]}
              testID="option-verbosity"
              value={verbosity}
            />
          )}
          {row(
            'bot-to-bot',
            <SwitchRow
              label={chatStrings.options.showBotToBot}
              onChange={onChangeShowBotToBot}
              testID="option-bot-to-bot"
              value={showBotToBot}
            />
          )}
          {row(
            'thinking',
            <SwitchRow
              label={chatStrings.options.showThinking}
              onChange={onChangeShowThinking}
              testID="option-thinking"
              value={showThinking}
            />
          )}
          {row(
            'text-size',
            <SegmentedRow
              label={chatStrings.options.textSize}
              onChange={(value: TextSize) => onChangeTextSize(value)}
              options={TEXT_SIZE_ORDER.map(size => ({
                label: chatStrings.options.textSizes[size] as string,
                value: size
              }))}
              testID="option-text-size"
              value={textSize}
            />
          )}

          {viewOverridden && onResetView ? (
            <>
              <Pressable
                accessibilityRole="button"
                onPress={onResetView}
                style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT, paddingHorizontal: theme.space.lg }}
                testID="option-use-default"
              >
                <Text color="accentText" variant="meta">
                  {chatStrings.options.useDefault}
                </Text>
              </Pressable>
              {/*
                What the link above does, in full. The popover never shows the
                sheet's own `usingOverride` footer, so without this line the link
                is the only word on screen about the view being overridden at all.
              */}
              <Text
                color="textFaint"
                style={{ paddingBottom: theme.space.xs, paddingHorizontal: theme.space.lg }}
                variant="micro"
              >
                {chatStrings.options.useDefaultHint}
              </Text>
            </>
          ) : null}

          {row(
            'export',
            <DisclosureRow
              label={chatStrings.export.header}
              onPress={() => onOpenPage('export')}
              testID="option-export"
            />
          )}
        </ScrollView>
      </GlassSurface>
    </Appear>
  )
}

/** The hairline between two groups of rows, stopping short of the leading edge. */
function Separator() {
  const theme = useTheme()

  return (
    <View
      style={{
        backgroundColor: theme.hairline,
        height: 1,
        marginLeft: theme.space.lg,
        marginVertical: theme.space.xs
      }}
    />
  )
}
