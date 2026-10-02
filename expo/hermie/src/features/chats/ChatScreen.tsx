/**
 * One bot's chat, drawn with the chat UI kit.
 *
 * The screen owns three things and nothing else: which sheet is open, what the
 * composer is holding, and how far the reader has scrolled. Everything else is
 * read from `useChat` — the transcript already filtered through the view
 * settings, the open questions, the running children — so the gateway, the
 * reducer and the navigator stay out of this file entirely.
 *
 * Two arrangements worth knowing about:
 *
 *  - `ChatHeader` is the header on BOTH shells. The compact stack hides its own
 *    native header for this route (`CompactShell`), because the design board's
 *    header carries an avatar and a live subtitle that a stack title bar cannot.
 *  - Only ONE agent question is on screen at a time, the oldest first. The
 *    gateway can have several open at once, and a stack of sheets is how a user
 *    ends up answering the wrong one.
 */
import {
  exportTranscript,
  findDmCounterpart,
  normalizeAgentTarget,
  transcriptFileName,
  type ApprovalItem,
  type ClarifyItem,
  type ToolItem,
  type TranscriptItem,
  type TurnActivity,
  type Verbosity
} from '@hermie/transcript'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Keyboard, Pressable, View } from 'react-native'

import {
  AgentsBar,
  attachmentName,
  ChatHeader,
  chatStrings,
  Composer,
  formatClock,
  type ComposerAttachment,
  type PickerOption,
  SidebarToggleButton,
  type SlashFailure,
  type SlashSuggestion,
  senderLabel,
  shortToolName,
  QueuedStrip,
  type SubagentTranscript,
  TranscriptList,
  type TranscriptListHandle
} from '../../chat-ui'
import { shareText } from '../../platform/share-text'
import { lastMessageAt } from '@hermie/transcript'
import type { ConnectionStatus } from '@hermie/gateway-client'
import { looksLikeSlashCommand, parseSlashCommand } from '@hermes/shared/slash'

import { useGateway } from '../../gateway'
import { gatewayStop } from '../../gateway/gateway-stop'
import { GatewayStoppedPanel } from '../../gateway/GatewayStoppedPanel'
import { chatGatewayFor } from '../../gateway/link'
import { strings } from '../../i18n/strings'
import { haptic } from '../../platform/haptics'
import { presenceOf } from '../bots/presence'
import { MemoryBotsScreen } from '../memory'
import { useSenderPictureResolver } from '../people/use-sender-picture-resolver'
import { botNames, useHideHandleWhenNamed } from '../../store/bot-names'
import { useBotsStore } from '../../store/bots'
import {
  useBotLabel,
  useChatAccent,
  useChatLayoutStore,
  useChatMuted,
  useCurrentConversation
} from '../../store/chat-layout'
import { ChatChoiceRow } from '../user-chats'
import { ownChatDisplayLabel, useConversationList } from '../sessions/ConversationListView'
import { mutedUntil as mutedUntilOf } from '../../store/mute'
import { useChatsStore } from '../../store/chats'
import { useCronStore } from '../../store/cron'
import { hasChatViewOverride, useChatView, useSettingsStore } from '../../store/settings'
import { textSizeScale } from '../../store/text-size'
import { usePushStore } from '../../store/push'
import { effectivePushTypes, type PushType } from '@hermie/gateway-client/push'
import { Appear } from '../../ui/Appear'
import { KeyboardInset } from '../../ui/KeyboardInset'
import { Screen, Text } from '../../ui/primitives'
import { TypeScaleProvider, useTheme } from '../../ui/theme'
import {
  CHAT_POPOVER_MIN_WIDTH,
  ChatOptionsPopover,
  modelPickerOptions,
  modelRowLabel,
  muteRowLabel,
  optionRowLabel,
  type ChatOptionsPane
} from '../../ui/sheets'
import { CONTROL_MIN_HEIGHT, TAP_SLOP } from '../../ui/tokens'
import { useShortcut } from '../../ui/useShortcut'
import { DropZone } from '../../chat-ui/DropZone'
import { messageText } from '../../chat-ui/message-menu'
import type { DroppedFile } from '../../platform/file-drop'
import { imageDimensions, openAppSettings, pickAttachment, resizeToBase64, type PickedAttachment } from './attachments'
import { droppedFile, pickFile, type PickedFile } from './file-attachments'
import { FileUploadError, MAX_UPLOAD_BYTES } from './file-upload'
import { splitPastedFiles } from './paste-attachments'
import { ChatSheetHost, type RequestItem } from './ChatSheetHost'
import { ConversationBusyError, SLASH_NO_ANSWER, type AttachmentInput, type ModelChoice } from './chat-controller'
import type { ManualSheet } from './sheet-host'
import { useChatRuntime } from './ChatRuntime'
import { findMatchingItem } from '../search'
import { connectionNotice, RETRY_OFFER_MS } from './connection-notice'
import { openAttachmentFile } from './open-attachment'
import { countsAsRead, readWatermark } from './read-watermark'
import { regenerateLastTurn, regenerateTargetIsOwn } from './regenerate'
import { useComposerDictation } from '../voice/useComposerDictation'
import { useDictationLanguages } from '../voice/useDictationLanguages'
import { useVoiceMode } from '../voice/useVoiceMode'
import { VoiceOverlay } from '../voice/VoiceOverlay'
import { useReadAloud } from '../voice/useReadAloud'
import { useVoiceSettingsStore } from '../voice/voice-settings'
import { ChatConnectingState, ReconnectPill } from './ConnectionState'
import { useChat, type UseChatResult } from './useChat'
import { useGroupChat } from './bound-conversation'
import { useOwnAuthorId } from './own-author'

export interface OpenChatOptions {
  /**
   * Land on this item instead of at the bottom.
   *
   * A tapped DM card should open the OTHER bot's chat on the message it is
   * about — the whole point of showing bot-to-bot traffic is that a reader can
   * follow it across chats without searching for where it went.
   */
  focusItemId?: string
  /**
   * Land on the newest row that contains these words.
   *
   * Text rather than an id because the gateway's search cannot name a row: it
   * projects no message id and no message timestamp, so a hit points at a
   * conversation and this side has to find the row again from the same words
   * the reader typed (`features/search/find-in-chat.ts`). When it is not in
   * what the chat has loaded, the chat says so rather than scrolling somewhere
   * plausible-looking.
   */
  findText?: string
}

export type ChatScreenProps = {
  /** The compact shell passes the bot through navigation params. */
  route?: { params?: { bot?: string; focusItemId?: string; findText?: string } }
  /** The regular shell passes it directly. */
  bot?: string
  /** Scroll here once the transcript is on screen. */
  focusItemId?: string
  /** Scroll to the newest row containing these words; see `OpenChatOptions.findText`. */
  findText?: string
  /** Shown as the header's back chevron; absent on the regular shell. */
  onBack?: () => void
  /** Open another bot's chat — a tapped DM card or sender chip. */
  onOpenBot?: (botName: string, options?: OpenChatOptions) => void
  /**
   * Open one cron's detail, by job id. Absent means the shell cannot get there,
   * and a cron card in the transcript then offers no `Open cron` at all.
   */
  onOpenCron?: (jobId: string) => void
  /**
   * Open one of this bot's OTHER conversations — a branch, or one `/new` put
   * away. Absent means the shell cannot get there, which drops the branch
   * notice's "Open now" and the popover's Conversations row rather than leaving
   * either pointing at nothing.
   */
  onOpenConversation?: (botName: string, storedId: string) => void
  /** Open the page that lists them. Present exactly where the one above is. */
  onOpenConversations?: (botName: string) => void
  /**
   * Hide or show the wide layout's chat list. Absent on the compact shell, where
   * there is no second pane and the header's leading slot is Back's.
   */
  onToggleSidebar?: () => void
}

/** How long a found row stays lit. Long enough to see, short enough not to be a state. */
const HIGHLIGHT_MS = 2_000

/**
 * How long this connection has been away from `ready`.
 *
 * A clock rather than a `Date.now()` read per render, because the thing it
 * decides — whether the reader is offered a dial of their own — has to become
 * true while nothing else is happening. A reconnect produces no renders: the
 * ladder is inside the connection object and the status does not change between
 * rungs, so a screen that only measured the elapsed time when something else
 * re-rendered it would offer the button at an arbitrary moment or never.
 *
 * One timeout, armed on the transition away from `ready` and disarmed on the way
 * back, so a chat sitting on a live connection runs no timer at all.
 */
function useWaitingMs(status: ConnectionStatus): number {
  const since = useRef<number | null>(null)
  const [, tick] = useState(0)

  if (status === 'ready' || status === 'paused') {
    since.current = null
  } else if (since.current === null) {
    since.current = Date.now()
  }

  const startedAt = since.current

  useEffect(() => {
    if (startedAt === null) {
      return
    }

    const remaining = RETRY_OFFER_MS - (Date.now() - startedAt) + 1

    if (remaining <= 0) {
      return
    }

    const timer = setTimeout(() => tick(value => value + 1), remaining)

    return () => clearTimeout(timer)
  }, [startedAt])

  return startedAt === null ? 0 : Date.now() - startedAt
}

const REASONING_OPTIONS: PickerOption[] = [
  { value: 'none', label: 'Off', detail: 'No extra thinking' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
  { value: 'ultra', label: 'Ultra' }
]

export function ChatScreen({
  route,
  bot,
  findText,
  focusItemId,
  onBack,
  onOpenBot,
  onOpenConversation,
  onOpenConversations,
  onOpenCron,
  onToggleSidebar
}: ChatScreenProps) {
  // The classifier is a plain function of the three things this screen already
  // has from the provider, so deciding what to show costs no extra context and
  // no state: `lastError` survives the statuses a re-dial passes through, which
  // is what keeps the card up while Re-check runs.
  const { config, lastError, status } = useGateway()
  const stop = gatewayStop({ config, error: lastError, status })
  const botName = bot ?? route?.params?.bot ?? ''
  const focus = focusItemId ?? route?.params?.focusItemId
  const find = findText ?? route?.params?.findText

  /**
   * A gateway that has stopped takes the whole screen, inside a chat as well as
   * beside one.
   *
   * On the wide layout the shell did this and the phone did not, so a reader
   * who was already inside a conversation when the token expired saw a transcript
   * that had simply stopped, plus whatever error the next send produced. Neither
   * says "sign in", which is the only thing that helps. The same is true of every
   * other stop: an address the gateway refuses leaves a transcript that will
   * never fill and no account of why. It is checked before the bot name because
   * a stopped gateway has no roster to have picked from.
   */
  if (stop) {
    return <GatewayStoppedPanel />
  }

  if (!botName) {
    return <NoBotSelected onToggleSidebar={onToggleSidebar} />
  }

  // Keyed on the bot so that switching conversations in the regular shell
  // starts from a clean composer and closed sheets rather than inheriting the
  // previous chat's.
  return (
    <Conversation
      botName={botName}
      findText={find}
      focusItemId={focus}
      key={botName}
      onBack={onBack}
      onOpenBot={onOpenBot}
      onOpenConversation={onOpenConversation}
      onOpenConversations={onOpenConversations}
      onOpenCron={onOpenCron}
      onToggleSidebar={onToggleSidebar}
    />
  )
}

/**
 * The wide layout's empty content column, before a chat has been picked.
 *
 * It carries the sidebar control, which looks like a duplicate of the chat
 * header's and is not: on first launch there is no chat, therefore no header,
 * therefore nowhere to hide the list FROM. Only the shortcut and the Mac menu bar
 * reached it, and a control that exists only on a keyboard is a control most
 * readers will never find. The compact shell passes no handler and draws none.
 */
function NoBotSelected({ onToggleSidebar }: { onToggleSidebar?: (() => void) | undefined }) {
  const theme = useTheme()

  return (
    <Screen testID="chat-empty">
      {onToggleSidebar ? (
        <View style={{ padding: theme.space.md }}>
          <SidebarToggleButton onPress={onToggleSidebar} />
        </View>
      ) : null}

      <View style={{ alignItems: 'center', flex: 1, gap: theme.space.sm, justifyContent: 'center' }}>
        <Text color="textMuted">{strings.chat.pickBot}</Text>
      </View>
    </Screen>
  )
}

/** A file staged in the tray whose upload has not finished. */
interface PendingFile {
  id: string
  name: string
  size: number
  status: 'uploading' | 'error'
  error?: string
}

/**
 * The reason, short enough for a chip.
 *
 * The typed `FileUploadError.message` is a sentence — right for a notice, far too
 * long for a 260pt chip — so each reason gets a chip-sized form and the sentence
 * stays available in the notice. `Too large · 100 MB max` is §6.7's own example.
 */
function uploadChipError(error: FileUploadError): string {
  switch (error.reason) {
    case 'too-large':
      return strings.chat.attach.chipTooLarge(Math.round(MAX_UPLOAD_BYTES / (1024 * 1024)))
    case 'no-workspace':
      return strings.chat.attach.chipNoWorkspace
    case 'refused':
      return strings.chat.attach.chipRefused
    default:
      return strings.chat.attach.chipFailed
  }
}

function Conversation({
  botName,
  findText,
  focusItemId,
  onBack,
  onOpenBot,
  onOpenConversation,
  onOpenConversations,
  onOpenCron,
  onToggleSidebar
}: {
  botName: string
  findText?: string
  focusItemId?: string
  onBack?: () => void
  onOpenBot?: (botName: string, options?: OpenChatOptions) => void
  onOpenConversation?: (botName: string, storedId: string) => void
  onOpenConversations?: (botName: string) => void
  onOpenCron?: (jobId: string) => void
  onToggleSidebar?: () => void
}) {
  const chat = useChat(botName)
  const runtime = useChatRuntime()
  const cronJobs = useCronStore(state => state.jobs)
  const { config, connection, gatewayId, http, lastError, status } = useGateway()
  const view = useChatView(botName)
  const pinned = useChatLayoutStore(state => Boolean(state.pinned[botName]))
  /** ADR-0007, amended: whether this bot opens the reader's own chat. */
  const myChat = useChatLayoutStore(state => Boolean(state.myChats[botName]))
  /*
    `?? null` rather than a bare read: the gallery and a dozen tests mount this
    screen with a hand-built runtime that has no switch on it, and a feature
    added to the context must not be a way to crash every surface that predates
    it. No switch is the same as no identity — the row is simply not drawn.
  */
  const userChats = runtime?.userChats ?? null
  const avatar = useBotsStore(state => state.avatars[botName])
  const byName = useBotsStore(state => state.byName)
  const overridden = useSettingsStore(state => hasChatViewOverride(state, botName))
  /*
    The transcript's own type scale, as a factor on the theme's type tokens.

    Read here and applied by a provider around the list rather than passed down:
    the words it has to reach are in the bubbles, the markdown blocks and the
    code blocks, and every one of those already reads `theme.type`. See
    `TypeScaleProvider`.
  */
  const textSize = useSettingsStore(state => state.textSize)
  /*
    This chat's own notification types, where anything would honour them.

    `canNotify` is the capability gate and it is deliberately the REGISTRATION
    rather than the plugin's advert: the per-type rule is read from the same
    `push` section a registration lives in, so a device that has never asked to
    be told has nothing for these switches to modify and the page is not
    offered at all. A switch that writes a preference nothing reads is worse
    than no switch.
  */
  const pushEnabled = usePushStore(state => state.enabled)
  const pushTypes = usePushStore(state => state.types)
  const botPushTypes = usePushStore(state => state.perBot[botName])
  const theme = useTheme()
  // The chat's own colour: the avatar ring in the header and the outgoing bubble
  // gradient. One lookup per screen rather than one per row.
  const accent = useChatAccent(botName)

  /*
    Sub-chats (ADR-0007, amended). `canCreate` is the switch's own `available` —
    the same "has this gateway named anybody" question `ChatChoiceRow` already
    asks — read synchronously rather than through the async list, so the header
    button and the popover's `new-chat` row can decide whether to exist without
    waiting on a `session.list` round trip.
  */
  const canCreate = Boolean(runtime?.userChats?.available)
  const currentOwnId = useCurrentConversation(botName)
  const conversationList = useConversationList(botName, canCreate)

  /*
    HERM-83, D6: a name and an avatar are drawn only in the canonical GROUP
    chat, never in one of the reader's own. Read off what is actually BOUND
    under this bot's key (`useGroupChat`, the controller's own derivation), not
    off `currentOwnId`: that is the reader's remembered choice, which says
    "group chat" for a legacy title-only `myChats` entry and moves before a
    switch has happened — or has been refused. While a switch has the key
    empty, the last settled answer is kept. A branch or a retired conversation
    never reaches `ChatScreen` at all (they open in `ConversationViewScreen`,
    which passes neither prop), so nothing further keeps them unnamed.
  */
  const groupChat = useGroupChat(botName)
  // The reader's own id as the gateway stamps it (`<provider>:<user_id>`), D3.
  const ownAuthorId = useOwnAuthorId()
  // A colleague's picture at the head of their run, fetched by `author.id`
  // and cached per gateway (HERM-120). `RowView` only ever uses these for a
  // row already proven to be somebody else's, so they never fire for the
  // reader's own messages or for an unattributed row. Three stable callbacks:
  // read, ask (from an effect), and hear when one arrives.
  const { requestSenderPicture, resolveSenderPictureUri, subscribeSenderPictures } = useSenderPictureResolver()

  /*
    The header's second line, while sub-chats are on: `Group chat` for the
    group, or the reader's own words for the chat the bot is on. The group
    label needs no round trip — `currentOwnId` alone says which one it is — but
    an own chat's LABEL is not known until the list answers, so the bot's other
    name stands in until it does rather than leaving the line blank.
  */
  const conversationLabel =
    conversationList.state.kind === 'ready'
      ? (conversationList.state.list.own.find(conversation => conversation.id === currentOwnId)?.title ?? null)
      : null

  /*
    ADR-0017's heartbeat, driven from the one place that knows a chat is on
    screen. It is a chat being MOUNTED rather than a message arriving: the
    daemon's question is "is anybody looking", and the answer stops being yes
    when this screen goes away or the app leaves the foreground — which
    `ChatRuntimeProvider` reports separately.

    Worth saying plainly, because the ADR's heading is "last seen per chat" and
    what the daemon actually reads is one stamp per INSTALLATION: `seen` is keyed
    by installation id (`packages/hermie-web/src/push/registrations.ts`), so a
    tablet with a chat open suppresses a message notification about any chat on
    that device. That is the schema the reader on the other side implements, and
    writing a per-chat map it does not look at would be a section nobody reads.
  */
  useEffect(() => {
    runtime?.push.setOpenChat(botName)

    return () => runtime?.push.setOpenChat(null)
  }, [botName, runtime])

  const [sheet, setSheet] = useState<ManualSheet>('none')
  /*
    The memory browser REPLACES this conversation while it is open, the way it
    replaces the roster in `BotsScreen`. It is a full page with its own header
    and its own Escape, and a page stacked on top of a sheet would leave the
    reader on a profile form when they press Back.
  */
  const [memoryFor, setMemoryFor] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<PickedAttachment[]>([])
  /**
   * Local URIs for images sent from THIS device, this session, by filename.
   *
   * A sent attachment survives in the transcript as a reference — `@image:` and
   * a path on the gateway's disk — and no endpoint serves one back, so an image
   * in a bubble can only be drawn from bytes the app still has. Those exist for
   * exactly one set: the pictures just picked here.
   *
   * Keyed by FILENAME rather than by the reference, because the reference
   * changes underneath: the optimistic bubble carries `@image:shot.png` (the
   * name is all a client is told) and the row the gateway echoes back carries
   * `@image:/srv/…/shot.png`. The name is the part that survives, which is also
   * what `attachmentsMatchKey` pairs the two on.
   *
   * It is deliberately NOT persisted. A `file://` URI from a picker does not
   * outlive the app, so a cache of them would come back after a restart as a
   * screenful of broken images — a chip is the honest thing to show then.
   */
  const [sentImages, setSentImages] = useState<Record<string, string>>({})
  /**
   * Files whose upload is in flight or has failed.
   *
   * Separate from `uploaded` on purpose: only a file the gateway acknowledged may
   * be referenced in a prompt, and keeping the two lists apart makes that a type
   * distinction rather than a flag someone can forget to check.
   */
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [attachBusy, setAttachBusy] = useState<'photo' | 'file' | null>(null)
  /**
   * How tall the floating chrome came out, so the transcript can pad its content
   * clear of it.
   *
   * Measured rather than declared as a constant: the header is a pill whose height
   * follows the type scale and the presence line, and a number written down beside
   * it is a number that goes stale the first time either moves.
   */
  const [chromeHeight, setChromeHeight] = useState(0)
  /**
   * How wide the chat column is, for the popover-or-sheet decision.
   *
   * Measured off the chrome rather than read off the window, for the reason the
   * composer's `+` menu already gives about exactly this choice: on the wide
   * layout the chat column is not the window, and a popover that fits the
   * window can still not fit the column. It is a MEASUREMENT and never
   * `Platform.OS`, because a Mac window dragged narrow and a phone are the same
   * problem and the platform answers only one of them.
   */
  const [chromeWidth, setChromeWidth] = useState(0)
  /**
   * The chat's options, as a popover in the chat.
   *
   * The owner's complaint was that the sheet made everything move
   * (*"nu schuift alles"*), so the first level is a floating surface anchored
   * under the header and laid out absolutely — see `ChatOptionsPopover`. It is
   * deliberately NOT part of the sheet host's state machine: the host exists
   * because iOS presents one `Modal` at a time, and a popover is not a modal.
   * A question the agent is blocked on still arrives over it, and the popover
   * closes when one does — see the effect below.
   */
  const [optionsPopover, setOptionsPopover] = useState(false)
  /** Which page the options SHEET should open on, when the popover hands over. */
  const [optionsPane, setOptionsPane] = useState<ChatOptionsPane | undefined>(undefined)
  /**
   * Files already uploaded and waiting to be named in the next prompt.
   *
   * Uploaded on pick rather than on send, because the upload is the slow part
   * and the send should not be: by the time the message goes out the bytes are
   * on the gateway and only the path travels with it.
   */
  const [uploaded, setUploaded] = useState<{ id: string; filename: string; path: string }[]>([])
  const [suggestions, setSuggestions] = useState<SlashSuggestion[]>([])
  /**
   * The completion call that refused, until one of them answers.
   *
   * Kept as state rather than read off the connection store's failure ring: the
   * ring is every absorbed refusal in the session and the popover is about the
   * LAST answer to the line in front of the caret. A successful answer clears
   * it, which is what makes the row disappear the moment the gateway comes
   * back rather than at the next reconnect.
   */
  const [slashFailure, setSlashFailure] = useState<SlashFailure | null>(null)
  /** A query is outstanding and this chat has never had one answered. */
  const [slashLoading, setSlashLoading] = useState(false)
  /** Which completion query is allowed to paint; see `querySlash` below. */
  const slashSeq = useRef(0)
  /**
   * Has any completion call for this chat ever come back?
   *
   * The "Loading…" row is for the FIRST fetch — the one that builds the
   * catalogue — and a ref rather than state because nothing renders from it
   * directly: it only decides whether the next query is allowed to set the
   * loading flag at all.
   */
  const slashAnswered = useRef(false)
  const [models, setModels] = useState<ModelChoice[]>([])
  const [dismissedRequests, setDismissed] = useState<string[]>([])
  const [newCount, setNewCount] = useState(0)
  const [away, setAway] = useState(false)
  const [notice, setNotice] = useState<ChatNotice | null>(null)
  const [highlightId, setHighlightId] = useState<string | undefined>(undefined)
  /** The query this screen has already answered, and how far it has paged back for one. */
  const searchedFor = useRef<string | undefined>(undefined)
  const expandedFor = useRef<{ query: string | undefined; pages: number }>({ query: undefined, pages: 0 })
  /** A page of older history is in the air: the list draws a row that says so. */
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [pendingModel, setPendingModel] = useState<{ value: string; message?: string } | null>(null)
  const [transcript, setTranscript] = useState<SubagentTranscript | null>(null)
  const [agentsNotice, setAgentsNotice] = useState<string | null>(null)
  const [imageHeaders, setImageHeaders] = useState<Record<string, string> | null>(null)
  const [needsPhotoAccess, setNeedsPhotoAccess] = useState(false)

  const listRef = useRef<TranscriptListHandle>(null)
  const focused = useRef<string | null>(null)
  const acknowledged = useRef<string | null>(null)
  const awayRef = useRef(false)

  /**
   * Only what a reader would call a message.
   *
   * The pill used to count `chat.items`, which is every row: a tool call, a
   * status chip, a notice. One `ls` behind a scrolled-up reader announced "4
   * new" and none of them were messages.
   */
  const messageCount = useMemo(
    () => chat.items.reduce((total, entry) => (MESSAGE_KINDS.has(entry.item.kind) ? total + 1 : total), 0),
    [chat.items]
  )
  const lastCount = useRef(messageCount)

  awayRef.current = away

  /**
   * When the newest message arrived, off the RAW chat rather than off the
   * transcript this screen is drawing.
   *
   * `chat.items` has already been through the view settings, and Quiet folds a
   * teammate's DM into a chip — so a transcript that is not showing a message is
   * not evidence that no message arrived. The badge counts the same rows
   * `lastMessageAt` looks at, which is the point of them sharing a predicate.
   */
  const storedChat = useChatsStore(state => state.chats[botName])
  const newestMessageAt = useMemo(() => (storedChat ? lastMessageAt(storedChat) : 0), [storedChat])

  /**
   * A chat in front of a reader at the bottom of it is read, and stays read as
   * messages arrive.
   *
   * It runs on two edges and they are the two halves of the rule: a new message
   * (`newestMessageAt` moves) while the reader is at the bottom, and the reader
   * arriving back at the bottom after being scrolled up. `markSeen` ignores a
   * watermark that is not newer than the one it holds, so the repeats this
   * effect makes on an unrelated re-render cost nothing and write nothing.
   */
  useEffect(() => {
    if (!countsAsRead({ away, open: true })) {
      return
    }

    // Under the key of the conversation the bot is ON: reading one of the
    // reader's own chats must not mark the group chat read.
    useBotsStore
      .getState()
      .markSeen(
        runtime?.controller.readKeyFor(botName) ?? botName,
        readWatermark(Math.floor(Date.now() / 1000), newestMessageAt)
      )
  }, [away, botName, newestMessageAt, runtime])

  // Messages that landed while the reader was further up: the pill's count.
  //
  // The delta is taken BEFORE the watermark moves. React runs a functional
  // updater during the next render, long after this effect body has finished,
  // so reading `lastCount.current` from inside the updater read the value this
  // effect had already overwritten — every delta came out as zero and the pill
  // never showed a count at all.
  useEffect(() => {
    const arrived = messageCount - lastCount.current

    lastCount.current = messageCount

    if (arrived > 0 && awayRef.current) {
      setNewCount(current => current + arrived)
    }
  }, [messageCount])

  /**
   * What a Markdown image in a reply needs to load.
   *
   * An agent writes an attachment as `/api/files/…` — a path on the gateway,
   * behind whatever the rest of the API is behind. Resolved once per
   * connection and held in state, because this object ends up in the memo key
   * of every transcript row.
   */
  useEffect(() => {
    if (!http) {
      setImageHeaders(null)

      return
    }

    let cancelled = false

    void http
      .requestHeaders()
      .then(headers => {
        if (!cancelled) {
          setImageHeaders(headers)
        }
      })
      .catch(() => undefined)

    return () => {
      cancelled = true
    }
  }, [http])

  /**
   * What a bubble can actually draw for one attachment reference.
   *
   * Only images this device sent itself resolve; everything else answers
   * `undefined` and draws as a chip, which is the truthful state for a file on
   * a machine the app cannot read.
   */
  const attachmentUri = useCallback((reference: string) => sentImages[attachmentName(reference)], [sentImages])

  /**
   * A non-picture attachment, opened.
   *
   * Quick Look first and the share sheet only if that cannot show it — see
   * `open-attachment.ts`, which owns that ordering. A reference with no local
   * URI has nothing to open, so the tap does nothing rather than putting up an
   * empty sheet.
   */
  const openAttachment = useCallback(
    (attachment: { name: string; uri?: string }) => {
      // The gateway's own client, because a remote attachment has to be fetched
      // with this connection's credentials before anything can preview it.
      void openAttachmentFile(attachment, { http })
    },
    [http]
  )

  const images = useMemo(
    () => ({
      ...(config?.baseUrl ? { baseUrl: config.baseUrl } : {}),
      ...(imageHeaders ? { headers: imageHeaders } : {})
    }),
    [config?.baseUrl, imageHeaders]
  )

  useEffect(() => {
    let cancelled = false

    void chat.modelOptions().then(options => {
      if (!cancelled) {
        setModels(options)
      }
    })

    return () => {
      cancelled = true
    }
  }, [chat])

  // ── the one question on screen ──────────────────────────────────────────
  //
  // Oldest first, and a question the user closed after it was resolved is not
  // re-opened. `dismissedRequests` is keyed by item id, so a NEW request with
  // the same shape still shows.
  const request = useMemo<RequestItem | undefined>(() => {
    for (const item of chat.requests) {
      if ((item.kind === 'approval' || item.kind === 'clarify') && !dismissedRequests.includes(item.id)) {
        return item
      }
    }

    return undefined
  }, [chat.requests, dismissedRequests])

  /**
   * Any question by id, answered or not.
   *
   * `chat.requests` is `openRequests`, so a question drops out of it the
   * instant it resolves. The sheet host holds the one it is showing by id and
   * reads it back through here, which is how an answered question can stay on
   * screen long enough to say what happened to it.
   */
  const findRequest = useCallback(
    (id: string): RequestItem | undefined => {
      for (const entry of chat.items) {
        if (entry.item.id === id && (entry.item.kind === 'approval' || entry.item.kind === 'clarify')) {
          return entry.item
        }
      }

      return undefined
    },
    [chat.items]
  )

  // `approval.received` tells the gateway's queue a human is looking at it, so
  // it stops counting down. It is sent once per request, on first show.
  const acknowledge = useCallback(
    (item: RequestItem) => {
      if (item.kind !== 'approval' || acknowledged.current === item.id) {
        return
      }

      acknowledged.current = item.id
      void chat.acknowledgeApproval(item.requestId).catch(() => undefined)
    },
    [chat]
  )

  const mutes = useChatLayoutStore(state => state.mutes)
  const muted = useChatMuted(botName)

  // A reply landing is worth one buzz, and only while the chat is on screen:
  // this effect is unmounted the moment the user leaves, so a bot answering in
  // a chat nobody is looking at stays silent.
  const wasRunning = useRef(false)

  useEffect(() => {
    if (chat.turnActive) {
      wasRunning.current = true

      return
    }

    if (wasRunning.current) {
      wasRunning.current = false

      // ...unless the reader silenced this chat. A mute that stopped the push
      // and then buzzed the phone the moment they opened the app would be a
      // mute in name only.
      if (!muted) {
        haptic('complete')
      }
    }
  }, [chat.turnActive, muted])

  // Land on the item the caller asked for, once it is actually in the list.
  // Hydration is asynchronous, so this retries as items arrive and gives up
  // silently rather than scrolling somewhere plausible-looking.
  useEffect(() => {
    if (!focusItemId || focused.current === focusItemId || !chat.items.length) {
      return
    }

    if (listRef.current?.scrollToItem(focusItemId)) {
      focused.current = focusItemId
    }
  }, [chat.items, focusItemId])

  /**
   * Land on the words a search hit was about.
   *
   * The gateway matched a CONVERSATION and cannot say which row, so the row is
   * found here, from the same query. Three outcomes and each one is a different
   * thing to tell the reader:
   *
   *  - found: scroll to it and light it up for a moment;
   *  - not found and there is more history to read: read one page further back
   *    and look again. The effect re-runs when the transcript grows, so that is
   *    a loop without being written as one, and it walks back a page at a time
   *    until the row turns up;
   *  - not found and there is nothing more, or the walk has gone far enough:
   *    say so. Scrolling to the bottom with no explanation is how a working
   *    search reads as a broken one.
   *
   * The walk is BOUNDED, and the bound is not timidity. The gateway's index is
   * built over the JSON-encoded message and this searches the projected item, so
   * a hit on a tool's arguments can never be found here however far back it
   * reads — an unbounded loop on that query would page to the start of a
   * thousand-turn conversation and then apologise anyway. `findExhausted` is the
   * sentence for both ways of stopping, because they are the same fact to the
   * reader.
   *
   * The refs are keyed on the QUERY rather than being booleans, so opening the
   * same chat from a second search starts the whole sequence again.
   */
  useEffect(() => {
    if (!findText || searchedFor.current === findText) {
      return
    }

    const found = findMatchingItem(chat.items, findText)

    if (found) {
      if (listRef.current?.scrollToItem(found)) {
        searchedFor.current = findText
        setHighlightId(found)
      }

      return
    }

    // Still arriving. A miss against a half-hydrated transcript is not a miss.
    if (chat.hydration !== 'live' && chat.hydration !== 'stale') {
      return
    }

    const walked = expandedFor.current.query === findText ? expandedFor.current.pages : 0

    if (walked >= FIND_PAGE_LIMIT) {
      searchedFor.current = findText
      setNotice(openFailed(strings.chat.findExhausted(findText)))

      return
    }

    expandedFor.current = { query: findText, pages: walked + 1 }

    void runtime?.controller
      .loadOlder(botName)
      .then(outcome => {
        if (outcome === 'grew' || searchedFor.current === findText) {
          // It grew: this effect runs again on the new items and looks again.
          return
        }

        searchedFor.current = findText
        // `start` and `unavailable` are the same sentence to a reader: this is
        // everything there is, and the words are not in it.
        setNotice(openFailed(walked ? strings.chat.findExhausted(findText) : strings.chat.findMissed(findText)))
      })
      .catch(() => undefined)
  }, [botName, chat.hydration, chat.items, findText, runtime])

  // The highlight is a moment, not a state: it says "here", and a row that
  // stayed lit would read as a selection nobody made.
  useEffect(() => {
    if (!highlightId) {
      return
    }

    const timer = setTimeout(() => setHighlightId(undefined), HIGHLIGHT_MS)

    return () => clearTimeout(timer)
  }, [highlightId])

  /**
   * Handles whose chat is live and mid-turn.
   *
   * This is what lets a pending dispatch say "@writer is writing…": the
   * recipient's chat is resumed (every opened chat stays live) and its turn is
   * running, which together mean the DM landed and is being answered.
   */
  const typingHandles = useChatsStore(
    useCallback(
      state =>
        Object.keys(state.live)
          .filter(name => name !== botName && state.chats[name]?.turn.active)
          .map(name => normalizeAgentTarget(name) || name.toLowerCase())
          .sort()
          .join(','),
      [botName]
    )
  )

  const typing = useMemo(() => (typingHandles ? typingHandles.split(',') : []), [typingHandles])

  /**
   * Open another bot's chat on the message this one is about.
   *
   * The two rows are the same delivery seen from opposite sides and the gateway
   * keys them by nothing in common, so the match is handle plus nearest stamp
   * (`findDmCounterpart`). It refuses rather than guesses, and a refusal just
   * means the chat opens at the bottom the way it always did.
   */
  /**
   * The reader reached the far end: read one page further back.
   *
   * The list fires this more than once while a page is in the air — that is what
   * `onEndReachedThreshold` does — and the controller refuses the second call
   * rather than fetching the same offset twice, so this is free to be eager.
   * `loadingOlder` is only the ROW: it says a page is coming, and it is set
   * before the request and cleared after it whatever the answer was, because a
   * spinner that outlives its request is worse than no spinner.
   */
  const loadOlder = useCallback(() => {
    if (!runtime?.controller) {
      return
    }

    setLoadingOlder(true)
    void runtime.controller
      .loadOlder(botName)
      .catch(() => undefined)
      .finally(() => setLoadingOlder(false))
  }, [botName, runtime])

  const openBot = useCallback(
    (handle: string, from?: { kind: 'bot_dm_in' | 'bot_dm_out'; at?: number; text?: string }) => {
      const names = Object.keys(useBotsStore.getState().byName)
      const target = resolveBot(handle, names)
      const targetChat = useChatsStore.getState().chats[target]
      const counterpart = from
        ? findDmCounterpart(targetChat, {
            kind: from.kind,
            handle: botName,
            ...(from.at === undefined ? {} : { at: from.at }),
            ...(from.text === undefined ? {} : { text: from.text })
          })
        : undefined

      onOpenBot?.(target, counterpart ? { focusItemId: counterpart } : undefined)
    },
    [botName, onOpenBot]
  )

  /**
   * A cron card's `Open cron`, resolved rather than guessed.
   *
   * A card carries the job's NAME, and a name does not identify a job: two
   * profiles may hold a cron called the same thing, which is exactly why the
   * list shows a profile chip. So the name is narrowed by this chat's bot — a
   * bot IS a Hermes profile — and the action exists only when that leaves
   * EXACTLY ONE job. Anything else and `undefined` is handed down, which makes
   * the card render no action at all instead of a link that opens the wrong
   * cron or nothing.
   *
   * It is also undefined until the crons list has been read at least once in
   * this session: the cron controller's lifetime is the Crons screen's, so
   * until then this app genuinely does not know which job the card names.
   */
  const resolveCron = useCallback(
    (jobName: string): string | undefined => {
      const named = cronJobs.filter(job => job.name === jobName)
      const matches = named.length > 1 ? named.filter(job => job.profile === botName) : named

      return matches.length === 1 ? matches[0]?.id : undefined
    },
    [botName, cronJobs]
  )

  // Per CARD, not per screen: the card asks whether ITS name resolves, so a
  // transcript with one resolvable delivery and one ambiguous one draws the link
  // on the first only.
  const canOpenCron = useCallback(
    (jobName: string) => Boolean(onOpenCron) && resolveCron(jobName) !== undefined,
    [onOpenCron, resolveCron]
  )

  const openCron = useCallback(
    (jobName: string) => {
      const id = resolveCron(jobName)

      if (id) {
        onOpenCron?.(id)
      }
    },
    [onOpenCron, resolveCron]
  )

  const subagents = useChatsStore(useCallback(state => state.chats[botName]?.subagents ?? EMPTY_SUBAGENTS, [botName]))

  /**
   * Open one child's transcript.
   *
   * While it is RUNNING, `subagent.tail` is the only live view and it is polled
   * (see below). Once it has finished, the tail is gone but the child's own
   * stored session is not — so a finished child is read through
   * `session.history` instead, which is the difference between a button that
   * works afterwards and one that shows an empty box.
   */
  const openTranscript = useCallback(
    (subagentId: string) => {
      const child = subagents[subagentId]

      if (!child) {
        return
      }

      const live = child.status === 'running' || child.status === 'queued'

      setSheet('agents')
      setTranscript({
        subagentId,
        goal: child.goal,
        text: '',
        source: live || !child.childSessionId ? 'tail' : 'stored',
        loading: true
      })
    },
    [subagents]
  )

  const steerChild = useCallback(
    async (subagentId: string, text: string) => {
      try {
        const status = await chat.steerSubagent(subagentId, text)

        setAgentsNotice(status === 'rejected' ? chatStrings.subagents.steerRejected : chatStrings.subagents.steerQueued)
      } catch (error) {
        setAgentsNotice(messageOf(error))
      }
    },
    [chat]
  )

  const stopChild = useCallback(
    async (subagentId: string) => {
      try {
        const found = await chat.interruptSubagent(subagentId)

        setAgentsNotice(found ? chatStrings.subagents.stopped : chatStrings.subagents.status.completed)
      } catch (error) {
        setAgentsNotice(messageOf(error))
      }
    },
    [chat]
  )

  /**
   * Keep the open transcript fresh.
   *
   * `subagent.tail` is a tail, not a subscription, so a live child's output
   * only moves if something asks. Three seconds is the plan's cadence; the poll
   * stops the moment the child finishes, and then the STORED transcript is read
   * once and left alone, because a finished session does not change.
   */
  useEffect(() => {
    const open = transcript

    if (!open) {
      return
    }

    let cancelled = false
    const child = subagents[open.subagentId]
    const live = child?.status === 'running' || child?.status === 'queued'

    const read = async () => {
      try {
        const text =
          open.source === 'stored' && child?.childSessionId
            ? (await chat.childTranscript(child.childSessionId)).map(transcriptLine).filter(Boolean).join('\n')
            : await chat.tailSubagent(open.subagentId)

        if (!cancelled) {
          setTranscript(current =>
            current && current.subagentId === open.subagentId ? { ...current, text, loading: false } : current
          )
        }
      } catch (error) {
        if (!cancelled) {
          setTranscript(current =>
            current && current.subagentId === open.subagentId
              ? { ...current, loading: false, error: messageOf(error) }
              : current
          )
        }
      }
    }

    void read()

    if (!live || open.source === 'stored') {
      return () => {
        cancelled = true
      }
    }

    const timer = setInterval(() => void read(), SUBAGENT_TAIL_POLL_MS)

    return () => {
      cancelled = true
      clearInterval(timer)
    }
    // Only the identity of the open transcript and the child's status may
    // restart the poll; the text this effect writes must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, subagents, transcript?.subagentId, transcript?.source])

  const busy = chat.busy

  /**
   * What the connection has to say, and where it is allowed to say it.
   *
   * The old answer was a `Banner` at the top of the transcript pane, and the
   * transcript pane's top is UNDER the floating header — so a reader whose
   * gateway had gone away read "Waiting for th…" with the middle of the sentence
   * behind the contact pill. `connection-notice.ts` has the whole decision; this
   * is only the two inputs it cannot work out for itself.
   */
  /**
   * Which of the three the bar is showing.
   *
   * The connection's own account of a terminal refusal beats the RPC message it
   * produced, which only ever says "gateway not connected"; both are the chat
   * failing to open, so both wear that sentence. Anything this screen put there
   * itself already knows which of the two shapes it is.
   */
  const opening = chat.connectionError ?? chat.error
  const bannerNotice = opening ? openFailed(opening) : notice

  const waitingMs = useWaitingMs(status)
  // A gateway that has stopped has its own screen — `GatewayStoppedPanel`, which
  // this component's own parent returns instead of the chat. Standing the
  // notice down as well keeps that true for any arrangement where both could be
  // mounted: two notices about one connection is how a screen stops being read.
  const gatewayStopped = gatewayStop({ config, error: lastError, status }) !== null
  const connectionState = connectionNotice({
    blocked: chat.connectionError !== null || gatewayStopped,
    hasTranscript: chat.items.length > 0,
    lastError: lastError ?? null,
    status,
    waitingMs
  })

  /**
   * Reset the ladder to the bottom and dial now.
   *
   * `retryNow` is deliberately harmless at any time and deliberately refuses to
   * restart a connection that stopped for a reason it can explain — so the
   * button never has to ask whether this is the kind of failure it can fix.
   */
  const retryConnection = useCallback(() => {
    connection?.retryNow()
  }, [connection])

  // Every question the agent is still blocked on, including one the reader put
  // aside with "Later". The header must not go quiet while the agent waits.
  const needsInput = chat.needsInput
  const subtitle = subtitleFor({
    status,
    hydration: chat.hydration,
    activity: chat.activity,
    queued: Boolean(chat.queuedText)
  })

  /**
   * The bead's state, from the same function the chat list uses.
   *
   * `sessionAttached` is `hydration === 'live'` rather than the socket's status,
   * for exactly the reason `subtitleFor` gives: coming back from the background
   * walks the whole pre-dial ladder again while this session keeps streaming, and a
   * bead that goes hollow during it describes the socket's bookkeeping rather than
   * the bot.
   */
  const presence = presenceOf({
    gatewayReady: status === 'ready' || chat.hydration === 'live',
    needsInput,
    sessionAttached: chat.hydration === 'live',
    working: busy,
    ...(typeof chat.info?.last_active === 'number' ? { lastActive: chat.info.last_active } : {})
  })

  const send = useCallback(
    async (text: string) => {
      const body = text.trim()

      if (!body && attachments.length === 0 && uploaded.length === 0) {
        return
      }

      // Captured now, not read off state again later: everything past this
      // point clears the live `attachments` / `uploaded` state before the
      // request that needs them has even gone out, so a catch block that read
      // the state instead of these would find it already empty and have
      // nothing left to put back.
      const sentAttachments = attachments
      const sentUploaded = uploaded

      const files: AttachmentInput[] = [
        ...sentAttachments.map(file => ({ filename: file.filename, base64: file.base64 })),
        ...sentUploaded.map(file => ({ kind: 'file' as const, filename: file.filename, path: file.path }))
      ]

      chat.setDraft('')
      setSuggestions([])

      haptic('send')

      /*
        A line that begins with a slash is a COMMAND only if the gateway has one
        by that name. The catalogue (`commands.catalog`, fetched once per
        session behind the autocomplete) is what answers that, and the two
        roads are genuinely different: a command goes to `slash.exec` and comes
        back as text in the transcript, while anything else — `/usr/local/bin`,
        a sentence that starts with a slash, a command this profile does not
        have — is an ordinary prompt and starts a turn.

        A catalogue that has not arrived yet answers "no", which sends the line
        as a prompt. The gateway understands a leading slash there too, so the
        worst case is the reply arriving as a turn rather than as a notice.
      */
      if (looksLikeSlashCommand(body) && chat.knowsSlashCommand(parseSlashCommand(body).name)) {
        try {
          const outcome = await chat.runSlash(body)

          // A `prefill` directive — `/undo`, `/queue edit` — hands back text for
          // the FIELD rather than for the transcript. The controller does not
          // reach into the composer; this is the only place that owns it.
          if (outcome.prefill !== undefined) {
            chat.setDraft(outcome.prefill)
          }
        } catch (error) {
          chat.setDraft(body)
          setNotice(openFailed(messageOf(error)))
        }

        return
      }

      /*
        Your own message goes to the END of the conversation, wherever you were
        reading when you sent it.

        The end of an INVERTED list is offset 0, and `scrollToLatest` is the same
        animated jump the "Jump to latest" pill makes — one `scrollToOffset` to
        zero, never a `scrollToIndex`, whose recovery path multiplies an average
        row height by an index and can land anywhere.

        It runs BEFORE the await on purpose. The jump also clears `away`, which
        takes `maintainVisibleContentPosition` off the scroll view, so the
        optimistic bubble that lands a moment later arrives at a list with
        nothing to correct — rather than mid-animation with an anchor moving
        under it.
      */
      listRef.current?.scrollToLatest()

      // Recorded BEFORE the send, so the optimistic bubble already has them:
      // that bubble is painted synchronously and would otherwise show chips
      // for a second and then swap to pictures.
      const pictures = sentAttachments.filter(file => file.uri)

      if (pictures.length) {
        setSentImages(current => {
          const next = { ...current }

          for (const file of pictures) {
            if (file.uri) {
              next[file.filename] = file.uri
            }
          }

          return next
        })
      }

      /*
        The tray empties HERE, before the request goes out, not after
        `chat.send` resolves. It used to wait for that, so a failed send never
        lost a file the reader could not retype — but a second Enter, or a
        tap on the send button, landing while the first send was still in
        flight found the same chips still staged and sent them again: a
        second paid agent turn with no undo, even with an empty text field.

        Emptying it now closes that gap: a second press that lands mid-flight
        sees nothing left to attach. With no text either, `sendable` in the
        composer refuses it outright; with text, it goes out as the plain
        message it looks like, exactly as it does today. A failure below puts
        `sentAttachments` and `sentUploaded` straight back, ahead of anything
        staged in the meantime, so the one thing this used to guard against —
        a file lost to a failed send — still cannot happen.
      */
      setAttachments([])
      setUploaded([])

      try {
        await chat.send(body, files)
      } catch (error) {
        // The optimistic bubble stays — the words were the user's — and the
        // draft comes back so the message is not lost with it. The
        // attachments come back too, exactly as they were and in the same
        // order, ahead of anything added to the tray while this send was in
        // flight, and never duplicated with it.
        setAttachments(current => [
          ...sentAttachments,
          ...current.filter(file => !sentAttachments.some(sent => sent.id === file.id))
        ])
        setUploaded(current => [
          ...sentUploaded,
          ...current.filter(file => !sentUploaded.some(sent => sent.id === file.id))
        ])

        chat.setDraft(body)
        setNotice(openFailed(messageOf(error)))
      }
    },
    [attachments, chat, uploaded]
  )

  const attach = useCallback(async () => {
    // The `+` menu is already on screen; this marks WHICH entry is waiting on the
    // system picker. The owner measured 1.5-2s of nothing here on the Mac, so the
    // busy mark is the only feedback there is during it.
    setAttachBusy('photo')

    try {
      const picked = await pickAttachment()

      if (picked) {
        setAttachments(current => [...current, picked])
      }
    } catch (error) {
      const message = messageOf(error)

      // A refused picker is the one failure the user can do something about,
      // and the only place to do it is the system settings app.
      setNeedsPhotoAccess(message === strings.chat.attach.permission)
      setNotice(openFailed(strings.chat.attach.failed(message)))
    } finally {
      setAttachBusy(null)
    }
  }, [])

  /**
   * Pick a file, stage a chip for it, upload it.
   *
   * The chip appears BEFORE the upload rather than after. That is a deliberate
   * change from the first version, which staged nothing until the upload finished:
   * a 40 MB archive then produced several seconds in which the tap had visibly done
   * nothing, and a failure produced a toast with no chip to attach it to. Now the
   * chip carries its own state — uploading, then either a size or the reason it was
   * refused — which is what §6.7 asks the tray to show.
   *
   * A chip in the `error` state is still never SENT: `send` only references files
   * that reached `uploaded`, so a prompt can never name a path the gateway does not
   * have.
   */
  /**
   * Stage one file's chip, upload it, and settle the chip either way.
   *
   * Declared BEFORE `attachFile`, which depends on it: a `useCallback` dependency
   * array is evaluated while the component renders, so the other order is a
   * temporal-dead-zone throw rather than a style preference.
   *
   * Separate from `attachFile` because there are two roads to it now — the `+`
   * menu's picker and a file dragged onto the window — and only the first half
   * differs. A second copy of the chip states would be a second place for
   * "uploading" to get stuck.
   */
  const stageFile = useCallback(
    async (picked: PickedFile) => {
      const id = `pending-${Date.now().toString(36)}-${picked.name}`

      setPendingFiles(current => [
        ...current,
        { id, name: picked.name, size: picked.size, status: 'uploading' as const }
      ])

      try {
        const result = await chat.uploadFile(picked)

        setPendingFiles(current => current.filter(file => file.id !== id))
        setUploaded(current => [...current, { id: result.path, filename: result.filename, path: result.path }])
      } catch (error) {
        // A typed reason exists for exactly the failures a message can explain;
        // anything else is the transport, and its own words are the best available.
        const reason = error instanceof FileUploadError ? uploadChipError(error) : messageOf(error)

        setPendingFiles(current =>
          current.map(file => (file.id === id ? { ...file, status: 'error', error: reason } : file))
        )
      }
    },
    [chat]
  )

  const attachFile = useCallback(async () => {
    setAttachBusy('file')

    let picked: Awaited<ReturnType<typeof pickFile>>

    try {
      picked = await pickFile()
    } catch (error) {
      setNotice(openFailed(strings.chat.attach.failed(messageOf(error))))

      return
    } finally {
      setAttachBusy(null)
    }

    if (!picked) {
      return
    }

    await stageFile(picked)
  }, [stageFile])

  /**
   * Files dragged onto the chat, staged exactly as picked ones are.
   *
   * Every file in one drop, in order, and each gets its own chip — a drag of
   * three files is three attachments, which is what the Finder promised when it
   * let go of all three.
   */
  const dropFiles = useCallback(
    (files: DroppedFile[]) => {
      for (const file of files) {
        void stageFile(droppedFile(file))
      }
    },
    [stageFile]
  )

  /**
   * One pasted image, resized and staged exactly as the "+" menu's photo option
   * stages one — the same tray, the same thumbnail, the same remove control.
   *
   * `imageDimensions` is asked first because neither side of a paste hands over
   * pixel dimensions the way an `ImagePicker` asset does: the pasteboard is bytes
   * and a URI, on the Mac and in a browser alike. Without it `resizeToBase64`
   * cannot tell whether the image is already under the cap, and a pasted photo
   * from a 6K display would be re-encoded at full size instead of scaled down.
   */
  const attachPastedImage = useCallback(async (file: DroppedFile) => {
    try {
      const { height, width } = await imageDimensions(file.uri)
      const picked = await resizeToBase64(file.uri, file.name, width, height)

      setAttachments(current => [...current, picked])
    } catch (error) {
      setNotice(openFailed(strings.chat.attach.failed(messageOf(error))))
    }
  }, [])

  /**
   * A paste's files, sorted onto the two roads a chat already takes one on —
   * images through the resize-and-attach pipeline, everything else through the
   * upload `stageFile` already gives a drop. Several files in one paste is
   * several attachments, the same rule `dropFiles` follows for a multi-file drag.
   */
  const pasteFiles = useCallback(
    (files: DroppedFile[]) => {
      const { files: rest, images } = splitPastedFiles(files)

      for (const image of images) {
        void attachPastedImage(image)
      }

      for (const file of rest) {
        void stageFile(droppedFile(file))
      }
    },
    [attachPastedImage, stageFile]
  )

  /**
   * Candidates for the line being typed, and what accepting one puts in the field.
   *
   * `replace_from` is the column the gateway's answer stands for, and it is what
   * makes ONE call complete both halves: with nothing typed after the slash it
   * is 0 and the item replaces the whole line, and once there is an argument it
   * points at the start of that argument and the command in front of it is kept.
   * Without it the only safe assumption is a bare command name.
   */
  const querySlash = useCallback(
    (typed: string) => {
      /*
        Only the NEWEST query may paint.

        Every keystroke fires one and they are answered out of order — a real
        gateway's `/` is thirty-four rows and its `/model` is seven, so the wide
        answer regularly lands after the narrow one and the popover fills back up
        with the list for a prefix that is no longer in the field. Against the
        fake, which answers within the tick, the race simply never ran.
      */
      const seq = (slashSeq.current += 1)

      if (!slashAnswered.current) {
        setSlashLoading(true)
      }

      void chat
        .querySlash(typed)
        .then(({ failure, items, replaceFrom }) => {
          if (seq !== slashSeq.current) {
            return
          }

          slashAnswered.current = true
          setSlashLoading(false)
          setSlashFailure(failure ?? null)

          setSuggestions(
            items.slice(0, 6).map(item => {
              const name = (item.display ?? item.text).replace(/^\//u, '')
              const insert = replaceFrom === undefined ? `/${name} ` : `${typed.slice(0, replaceFrom)}${item.text}`

              return { name, description: item.meta ?? '', insert }
            })
          )
        })
        .catch((error: unknown) => {
          if (seq !== slashSeq.current) {
            return
          }

          /*
            `querySlash` absorbs the gateway's own refusals and reports them as a
            `failure`, so reaching this catch means the call did not get as far
            as the gateway — no runtime session for this chat yet, most often.
            It is still a reason the popover has nothing, and the reader is owed
            the same row rather than the silence this used to be.
          */
          setSlashLoading(false)
          setSuggestions([])
          setSlashFailure({ method: 'complete.slash', reason: slashReasonOf(error) })
        })
    },
    [chat]
  )

  const setOption = useCallback(
    async (key: 'yolo' | 'fast' | 'reasoning' | 'model', value: string, confirmExpensiveModel = false) => {
      try {
        const result = await chat.setOption(key, value, { confirmExpensiveModel })

        if (result.confirmRequired) {
          setPendingModel({ value, ...(result.confirmMessage ? { message: result.confirmMessage } : {}) })

          return
        }

        setPendingModel(null)
      } catch (error) {
        // The conversation is open and unaffected; one option was refused. The
        // gateway's sentence already names the setting and the reason, so it is
        // kept whole and only what happened to it is added.
        setNotice(settingRefused(messageOf(error)))
      }
    },
    [chat]
  )

  /*
    Built by `modelPickerOptions`, which sits beside the function that reads a
    label back off this list. They used to be two places and they disagreed: the
    chat's own model was appended with the WIRE ID as its label, so the one model
    certain to be in the list was the one whose row said
    `anthropic/claude-opus-4-1-20250805` while every row under it said a name.
  */
  const modelOptions = useMemo<PickerOption[]>(
    () => modelPickerOptions(models, chat.info?.model),
    [chat.info?.model, models]
  )

  const composerAttachments = useMemo<ComposerAttachment[]>(
    () => [
      ...attachments.map(file => ({
        id: file.id,
        kind: 'image' as const,
        name: file.filename,
        ...(file.uri ? { uri: file.uri } : {})
      })),
      // A file is a CHIP, not a thumbnail: a type glyph, the name and its size are
      // what tells an archive from a spreadsheet, and neither has a preview.
      ...pendingFiles.map(file => ({
        id: file.id,
        kind: 'file' as const,
        name: file.name,
        size: file.size,
        status: file.status,
        ...(file.error ? { error: file.error } : {})
      })),
      ...uploaded.map(file => ({
        id: file.id,
        kind: 'file' as const,
        name: file.filename,
        status: 'uploaded' as const
      }))
    ],
    [attachments, pendingFiles, uploaded]
  )

  /*
    Both of the bot's names, in the order this reader chose.

    `display` stays as the ONE-line answer for the places that have room for
    exactly one — the connecting card, the composer's placeholder, the options
    sheet's subtitle — and is the primary line so those agree with the header.
  */
  const names = botNames(
    {
      name: botName,
      displayName: byName[botName]?.displayName ?? botName,
      label: useBotLabel(botName)
    },
    useSettingsStore(state => state.botNameOrder),
    { hideHandle: useHideHandleWhenNamed() }
  )
  const display = names.primary

  /*
    The header's second line, once sub-chats are on (`canCreate`): which
    conversation the bot is on, rather than the bot's other name — `names.secondary`
    is what a gateway with no accounts still gets, unchanged.

    `Group chat` needs nothing but `currentOwnId` being empty. An own chat's
    label needs `conversationLabel` (the list) and `lead` (the switch's own
    title, the same string `ownChatTitle`/`ownChatLabel` build against) — while
    either is still loading, the bot's other name stands in rather than leaving
    the line blank for the round trip.
  */
  const conversationSecondaryName = canCreate
    ? currentOwnId
      ? (conversationLabel && ownChatDisplayLabel(conversationLabel, runtime?.userChats?.title ?? '')) ||
        names.secondary
      : chatStrings.conversations.groupChat
    : names.secondary

  /**
   * The newest reply in what the reader is looking at.
   *
   * Computed once here rather than by each row: a row is one item and cannot see
   * what came after it, and `Regenerate` is offered on exactly one row. Off
   * `chat.items` — the VISIBLE list — because the menu is opened on a row in that
   * list, and a hidden reply the filter removed is not a row anybody can ask to
   * run again.
   */
  const lastAssistantId = useMemo(() => {
    for (let at = chat.items.length - 1; at >= 0; at -= 1) {
      const entry = chat.items[at]

      if (entry?.item.kind === 'assistant') {
        return entry.item.id
      }
    }

    return undefined
  }, [chat.items])

  /**
   * Speaking, for this chat.
   *
   * Everything about it — the queue, the flattening, the automatic read, the
   * stop on background — is `features/voice`; the screen supplies the two facts
   * only it has (which chat, and what is visible in it) and hands the result to
   * the transcript's menu and to the options sheet.
   */
  /**
   * Voice mode: the hands-free loop, and the overlay it draws.
   *
   * Declared before `useReadAloud` because that one is SUSPENDED while this is
   * active — voice mode reads every reply by design, and a chat with "Read
   * replies aloud" switched on would otherwise read the same reply again
   * underneath it, on the one speaker the device has.
   */
  const voiceMode = useVoiceMode({ items: chat.items, send, turnRunning: chat.turnActive })

  const readAloud = useReadAloud({
    botName,
    items: chat.items,
    suspended: voiceMode.active,
    turnRunning: chat.turnActive
  })
  const autoRead = useVoiceSettingsStore(state => state.autoReadByChat[botName] === true)
  const voiceRate = useVoiceSettingsStore(state => state.rate)
  const voiceLanguage = useVoiceSettingsStore(state => state.dictationLanguage)
  const voiceConfirm = useVoiceSettingsStore(state => state.confirmBeforeSending)

  /**
   * The composer's microphone.
   *
   * It writes through `chat.setDraft`, which is the same setter the reader's own
   * typing goes through — so a dictated sentence is a draft like any other: it
   * survives navigating away, it is what the store persists, and it can be
   * edited before it is sent. Dictation never sends anything.
   */
  const dictation = useComposerDictation({
    onChangeText: chat.setDraft,
    value: chat.draft,
    ...(voiceMode.available ? { onOpenVoiceMode: voiceMode.open } : {})
  })
  const dictationLanguages = useDictationLanguages()

  /**
   * Put one of the reader's own turns back in the composer.
   *
   * The turn already in the conversation is left exactly where it is — this
   * starts a NEW one from the same words, which is why the menu line says "and
   * resend" rather than "Edit". The attachment references travel with the text
   * because they are what the turn holds and what the gateway understands; the
   * bytes are long gone from this device, so a picture comes back as a chip.
   */
  const editResend = useCallback(
    (text: string, references: readonly string[]) => {
      chat.setDraft(references.length ? `${text}\n${references.join(' ')}`.trim() : text)
    },
    [chat]
  )

  /**
   * Ask for the last reply again.
   *
   * The decision — `/retry` where the gateway has it, the previous prompt again
   * where it does not, and a refusal in the two cases where neither is honest —
   * is `regenerate.ts`, which has its own suite. This is the half that belongs
   * to the screen: turning an outcome into a notice.
   */
  const regenerate = useCallback(() => {
    // HERM-83: the same two facts the menu was already hidden on
    // (`regeneratePromptIsOwn`, below) travel with the request itself, so a
    // gateway that has no `/retry` falls back to `lastPrompt`'s own refusal
    // rather than a second, independent notion of "mine".
    void regenerateLastTurn({ ...chat, groupChat, ownAuthorId })
      .then(outcome => {
        if (outcome.kind === 'busy') {
          setNotice(openFailed(chatStrings.menu.turnRunning))

          return
        }

        if (outcome.kind === 'nothing') {
          setNotice(openFailed(chatStrings.menu.nothingToRegenerate))
        }
      })
      .catch(error => setNotice(openFailed(messageOf(error))))
  }, [chat, groupChat, ownAuthorId])

  /**
   * Whether `Regenerate` is honest to offer on the newest reply at all
   * (HERM-83).
   *
   * Read off the same `chat.items` the screen already has and the same
   * `groupChat`/`ownAuthorId` facts `regenerate` above sends along — computed
   * once here rather than by each row, exactly as `lastAssistantId` is.
   * `false` only for a colleague's newest turn in the group chat; everywhere
   * else (a personal chat, an unattributed row, the reader's own turn) this is
   * `true` and the menu draws exactly as it did before this flag existed.
   */
  const regeneratePromptIsOwn = useMemo(
    () => regenerateTargetIsOwn(chat.items, { groupChat, ownAuthorId }),
    [chat.items, groupChat, ownAuthorId]
  )

  /**
   * Write the conversation out and hand it to the platform.
   *
   * `chat.items` is what the reader is looking at — the verbosity filter, the
   * bot-to-bot toggle and the thinking toggle have already been applied — and
   * that is deliberately what is exported. A chat set to Quiet exports the quiet
   * conversation; carrying the rows the screen is hiding would hand somebody a
   * file they have not read.
   *
   * Nothing about the serialization is here. `exportTranscript` is a pure
   * function in `@hermie/transcript` with its own suite; this supplies the two
   * things the package cannot know — what a clock looks like on this device, and
   * how a file reaches the rest of the system.
   */
  const exportChat = useCallback(
    (format: 'md' | 'txt') => {
      const now = Date.now()
      const { markdown, text } = exportTranscript(
        chat.items.map(entry => entry.item),
        {
          botName: display,
          exportedAt: Math.floor(now / 1000),
          // The device's own clock, which is the whole reason the formatter is
          // passed in: a file saved on this phone should read in this phone's
          // time, and the transcript package has no business knowing what that
          // is.
          formatTime: seconds => `${new Date(seconds * 1000).toLocaleDateString()} ${formatClock(seconds)}`.trim(),
          // HERM-83, D6/D3: the same gate and the same cleaning resolver the
          // transcript itself draws a name from — the export has no bubble to
          // ask, so it is handed the identical facts.
          groupChat,
          ownAuthorId,
          resolveSenderName: senderLabel,
          selfName: chatStrings.export.self
        }
      )

      const name = transcriptFileName(display, format, new Date(now).toISOString().slice(0, 10))

      void shareText(name, format === 'md' ? markdown : text, format === 'md' ? 'text/markdown' : 'text/plain').then(
        shared => {
          if (!shared) {
            setNotice(openFailed(chatStrings.export.failed))
          }
        }
      )
    },
    [chat.items, display, groupChat, ownAuthorId]
  )

  /**
   * Stable callbacks for the transcript.
   *
   * `TranscriptRow` is memoized on `(id, version, presentation, receipt,
   * context)`, and the context is rebuilt whenever any handler identity
   * changes. An inline arrow here therefore invalidated EVERY settled row on
   * every streaming delta — the one thing the memo exists to prevent.
   */
  const reopenRequest = useCallback((item: ApprovalItem | ClarifyItem) => {
    setDismissed(current => current.filter(id => id !== item.id))
  }, [])

  /**
   * The chat's notification page, as the sheet and the popover both want it.
   *
   * `types` is the EFFECTIVE answer — `effectivePushTypes` folds this chat's
   * overrides into the global switches — because "will this chat wake me for a
   * failed turn" is the question being asked, and `overridden` is what lets the
   * footer say which of the two is answering it.
   */
  const notifications = useMemo(
    () =>
      pushEnabled
        ? {
            types: effectivePushTypes(pushTypes, botPushTypes),
            overridden: Object.keys(botPushTypes ?? {}).length > 0,
            onChangeType: (type: PushType, on: boolean | null) => usePushStore.getState().setBotType(botName, type, on),
            onUseGlobal: () => usePushStore.getState().resetBotTypes(botName)
          }
        : undefined,
    [botName, botPushTypes, pushEnabled, pushTypes]
  )

  const openAgents = useCallback(() => setSheet('agents'), [])
  /*
    Opening either sheet asks the gateway for the context reading once.

    Nearly always a no-op: the reducer already follows the live `session.usage`
    ticks and the usage on `message.complete`, so a chat that has run a turn
    since it was opened is current. It covers the chat that was resumed and not
    yet spoken to, whose `session.resume` answered without `info.usage` — which
    is the first thing a reader sees after a cold start, and the one moment the
    row would otherwise be missing for no reason the reader can act on.

    Fire and forget, deliberately: the sheet opens now. A gateway without the
    method answers nothing and the row stays absent, which is what
    `refreshUsage` promises.
  */
  const refreshUsage = chat.refreshUsage
  /*
    Popover where there is room for one, sheet where there is not.

    `CHAT_POPOVER_MIN_WIDTH` against the MEASURED column, which is the owner's
    own allowance: under 400pt the rows' value column starts eliding and a
    popover has stopped being the better answer. A column that has not been laid
    out yet reports 0, and a width of nothing is not "too narrow" — it is "not
    known", so the first open before layout takes the sheet rather than
    guessing.
  */
  const openOptions = useCallback(() => {
    void refreshUsage()

    /*
      Put the keyboard away first.

      The popover is laid out absolutely from the top of the chrome downwards,
      and it is a SIBLING of the composer rather than above it — so with the
      keyboard up on a phone, opening the menu while the draft had focus drew
      the composer and its send button straight over the menu's lower half,
      with the rest of it behind the keyboard and no way to scroll to it.
      Measured on the iPhone 17 Pro: Model and Colour were both unreachable.

      Raising the popover's z-order would only move the collision — the rows
      would then cover the composer, and the keyboard would still be sitting on
      the bottom third of a menu. A menu over the transcript and a keyboard for
      the draft are two different intentions, and the tap on (…) is the moment
      the reader states which one they are in.
    */
    Keyboard.dismiss()

    if (chromeWidth >= CHAT_POPOVER_MIN_WIDTH) {
      setOptionsPopover(true)

      return
    }

    setOptionsPane(undefined)
    setSheet('options')
  }, [chromeWidth, refreshUsage])

  /** A row on the popover that leads to a page: close it, open the sheet there. */
  const openOptionsPage = useCallback((pane: ChatOptionsPane) => {
    setOptionsPopover(false)
    setOptionsPane(pane)
    setSheet('options')
  }, [])

  const closeOptionsPopover = useCallback(() => setOptionsPopover(false), [])

  /**
   * Re-resolve this chat and replay it, from the menu.
   *
   * Two calls and both are needed. `bots.refresh` re-reads the roster, which is
   * where the canonical session id comes from; `chat.reload` re-opens the chat
   * against whatever that answered, which resumes and replays. After a gateway
   * restart the first is the one that matters — the runtime id this chat was
   * bound to is gone and the stored one has to be resolved again — and after a
   * dropped socket the second is.
   *
   * The popover closes first: the thing the reader wants to look at is the
   * transcript, not the menu they pressed.
   */
  const refreshChat = useCallback(() => {
    setOptionsPopover(false)
    void runtime?.bots.refresh()
    void chat.reload().catch(error => setNotice(openFailed(messageOf(error))))
  }, [chat, runtime])

  /**
   * Fork the conversation at one row.
   *
   * The canonical chat does not move and is not reloaded — `session.branch`
   * copies the history into a new stored child and leaves the parent exactly as
   * it was — so what happens on screen is a NOTICE and nothing else. The notice
   * carries the way in: a reader who branched on purpose wants to go and read
   * it, and one who branched to keep a thought for later does not.
   *
   * The popover closes first where the branch came from there, for the same
   * reason Refresh does: what the reader is looking at is the transcript.
   */
  const branchHere = useCallback(
    (itemId: string, text: string) => {
      setOptionsPopover(false)
      void chat
        .branchFrom(itemId, text)
        .then(branch => {
          setNotice({
            kind: 'branch',
            text: chatStrings.sessions.branchMade(branch.title),
            onOpen: () => onOpenConversation?.(botName, branch.id)
          })
        })
        .catch(error => setNotice(openFailed(`${chatStrings.sessions.branchFailed} ${messageOf(error)}`)))
    },
    [botName, chat, onOpenConversation]
  )

  /** The same fork, from the popover, taken at the newest row in the chat. */
  const branchNewest = useCallback(() => {
    const newest = chat.items[chat.items.length - 1]?.item

    if (!newest) {
      return
    }

    branchHere(newest.id, messageText(newest))
  }, [branchHere, chat.items])

  /**
   * ⌘N: a new conversation in the chat that is open.
   *
   * The same `/new` the composer runs, through the same `runSlash` — not a
   * second road to it. `ChatController.dispatchSlash` intercepts the name before
   * any round trip and calls `startNewConversation`, which retires the session,
   * keeps the chat and writes the notice; a shortcut that reimplemented any of
   * that would be a second set of rules about what happens to the old
   * conversation.
   *
   * It is deliberately NOT "new chat". A Mac reader expects ⌘N to make a new
   * something in the window they are looking at, and the window they are looking
   * at is one conversation. Creating a chat is a gateway-side act with a name to
   * choose, which is a sheet rather than a keystroke.
   */
  const newConversation = useCallback(() => {
    void chat.runSlash('/new').catch(error => setNotice(openFailed(messageOf(error))))
  }, [chat])

  useShortcut('newConversation', newConversation)
  const openProfile = useCallback(() => {
    void refreshUsage()
    setSheet('profile')
  }, [refreshUsage])

  /**
   * The header's own conversations button: opens the sheet below the column's
   * breakpoint (Task 7 forwards this to the column toggle instead, above it).
   */
  const openConversations = useCallback(() => setSheet('conversations'), [])

  /**
   * Start another one of the reader's own chats, from the popover's `new-chat`
   * row. The popover closes first, for the reason `refreshChat` and
   * `branchHere` already give: the thing the reader wants to look at next is
   * the conversation, not the menu they pressed, and `selectConversation`
   * (inside `startOwnChat`) puts the new chat straight on screen.
   */
  const newChat = useCallback(() => {
    const bot = byName[botName]

    if (!bot) {
      return
    }

    setOptionsPopover(false)
    void runtime?.controller
      .startOwnChat(bot)
      .catch(error =>
        setNotice(
          openFailed(
            error instanceof ConversationBusyError ? chatStrings.sessions.busy : chatStrings.conversations.newChatFailed
          )
        )
      )
  }, [botName, byName, runtime])

  /*
    The profile sheet's own connection.

    Built here rather than threaded down from `ChatRuntime` because the sheet's
    two writes — `profiles.configure` and `profiles.set_asset` — have nothing to
    do with a chat's session, and giving the runtime's gateway a second owner
    would tie a profile edit to whether a transcript happens to be streaming.
  */
  const profileGateway = useMemo(() => (connection ? chatGatewayFor(connection) : null), [connection])

  /*
    A saved profile only reaches the rest of the app through the roster.

    The sheet writes to the gateway; the header, the chat list and every other
    chat paint from `profiles.list`. So a save is followed by a re-read, which
    is also what invalidates the avatar cache — that is keyed on the profile's
    `ui_meta` revision, and `profiles.set_asset` is what moves it.

    The runtime's own controller, which is the one the pull-to-refresh on the
    chat list uses: a second instance would race it for the same store.
  */
  const onProfileSaved = useCallback(() => {
    void runtime?.bots.refresh()
  }, [runtime])

  const onScrolledAway = useCallback((next: boolean) => {
    setAway(next)

    if (!next) {
      setNewCount(0)
    }
  }, [])

  const closeManualSheet = useCallback(() => {
    setSheet('none')
    setTranscript(null)
    // So the next plain open lands on the root rather than on the page the last
    // reader happened to be handed.
    setOptionsPane(undefined)
  }, [])

  const dismissRequest = useCallback((item: ApprovalItem | ClarifyItem) => {
    setDismissed(current => (current.includes(item.id) ? current : [...current, item.id]))
  }, [])

  /*
    Both of these are fired AFTER the sheet has started sliding out — see
    `ChatSheetHost`. So a failure has nowhere to be shown but here: the banner
    carries the error, and the question is still open in the transcript with an
    `Answer` button that brings the sheet back.
  */
  const respondApproval = useCallback(
    (item: ApprovalItem, choice: string) => {
      haptic('choice')
      void chat.respondApproval(item.requestId, choice).catch(error => setNotice(openFailed(messageOf(error))))
    },
    [chat]
  )

  /**
   * Answer an approval from the transcript, without the sheet.
   *
   * Two steps in one, and the order matters: the question is taken off the
   * screen FIRST so a sheet that happens to be up starts leaving before the
   * RPC is handed to the socket, and the answer travels second. It is the same
   * order `ChatSheetHost` uses for a tap on the sheet's own buttons, and the
   * same pair of handlers — an answer given on a card and an answer given on
   * the sheet are one code path from here down.
   */
  const answerApprovalInline = useCallback(
    (item: ApprovalItem, choice: string) => {
      dismissRequest(item)
      respondApproval(item, choice)
    },
    [dismissRequest, respondApproval]
  )

  /**
   * Which open approval belongs to a tool card, when that can be said at all.
   *
   * The gateway's approval carries a tool NAME and no tool-call id, so this is
   * a match on the name and on the card not having finished. Two concurrent
   * calls to the same tool would therefore both draw the question — which is
   * the same question drawn twice rather than the wrong one, and answering
   * either answers it. A card that has a result is never offered one: the
   * decision it was waiting for has already been made.
   */
  const approvalForTool = useCallback(
    (tool: ToolItem): ApprovalItem | undefined => {
      if (tool.resultKnown || !tool.name) {
        return undefined
      }

      return chat.requests.find(
        (item): item is ApprovalItem => item.kind === 'approval' && item.state === 'open' && item.toolName === tool.name
      )
    },
    [chat.requests]
  )

  const submitClarify = useCallback(
    (item: ClarifyItem, answers: Record<string, string>) => {
      haptic('choice')
      void chat.respondClarify(item.requestId, answers).catch(error => setNotice(openFailed(messageOf(error))))
    },
    [chat]
  )

  /*
    The three things that can still be done about a message the reader sent
    while the bot was working. They are here rather than in the list because two
    of them end somewhere the list cannot reach: the composer, and the banner.
  */
  const editQueued = useCallback(
    (id: string) => {
      const text = chat.editQueued(id)

      if (text !== undefined) {
        // Appended rather than assigned: the reader may have started typing the
        // next one while this was parked, and their words outrank ours.
        chat.setDraft(chat.draft ? `${chat.draft}\n${text}` : text)
      }
    },
    [chat]
  )

  const steerQueued = useCallback(
    (id: string) => {
      void chat
        .steerQueued(id)
        .then(status => setNotice(status === 'rejected' ? openFailed(chatStrings.queue.steerRejected) : null))
        .catch(error => setNotice(openFailed(messageOf(error))))
    },
    [chat]
  )

  const lockClarify = useCallback(
    (item: ClarifyItem, qid: string, answer: string) => {
      void chat.lockClarify(item.requestId, qid, answer).catch(error => setNotice(openFailed(messageOf(error))))
    },
    [chat]
  )

  if (memoryFor) {
    return <MemoryBotsScreen initialProfile={memoryFor} onClose={() => setMemoryFor(null)} />
  }

  return (
    <Screen edgeToEdgeTop={false} padded={false}>
      {/*
        The whole conversation takes a dropped file, not the composer alone.
        "Drop it on the chat" is what a reader means, and aiming a file at a
        44pt field is not. Inert everywhere there is no drag session — see
        `DropZone`, which renders its children bare when there is no native view.
      */}
      <DropZone onFiles={dropFiles} style={{ flex: 1 }} testID="chat-drop-zone">
        {/*
          `KeyboardInset` rather than a bare `KeyboardAvoidingView`, and the
          difference is 59 points of composer.

          React Native compares this view's PARENT-RELATIVE layout frame with the
          keyboard's WINDOW frame, so it only makes the right amount of room when
          the view starts at the top of the window. `Screen` puts the safe area
          above it on a phone and the wide layout puts a whole panel above it, and
          the shortfall is exactly that distance — which is why the composer went
          behind the keyboard instead of sitting on it. The distance is measured
          rather than written down: only the window knows it.
        */}
        <KeyboardInset style={{ flex: 1 }} testID="chat-keyboard-inset">
          <Banner
            hydration={chat.hydration}
            notice={bannerNotice}
            onDismiss={() => {
              setNotice(null)
              setNeedsPhotoAccess(false)
              chat.clearError()
            }}
            onRetry={chat.reload}
            {...(needsPhotoAccess ? { onOpenSettings: openAppSettings } : {})}
          />

          {/*
          `onRunCron` is deliberately absent. Run now is a side effect on the
          gateway and it lives on the cron's own detail behind its confirm; a
          transcript card is a receipt for a run that already happened, and one
          tap away from starting another one is not where that belongs.
        */}
          {connectionState.kind === 'empty' ? (
            /*
              Nothing cached and nothing live: the notice IS the screen.

              The list is not rendered at all rather than rendered empty. An empty
              inverted list would put "Nothing has been said in this chat yet."
              under the header — which is a claim about the CONVERSATION, and the
              app does not know whether it is true yet. It has not been able to ask.
            */
            <ChatConnectingState
              hint={connectionState.hint}
              message={connectionState.message}
              name={display}
              onRetry={retryConnection}
              phase={connectionState.phase}
              retry={connectionState.retry}
              {...(avatar ? { avatarUri: avatar } : {})}
            />
          ) : (
            <TypeScaleProvider scale={textSizeScale(textSize)}>
              <TranscriptList
                canOpenCron={canOpenCron}
                /*
            The transcript runs UNDER the floating chrome and pads its own content
            out of the way. An inverted list's content container has its top where
            the screen's bottom is, so the padding that clears a header at the
            visual top is `paddingBottom`.

            Measured rather than named: `chromeHeight` is what the header actually
            laid out at, so the clearance and the thing it clears cannot drift
            apart when a subtitle wraps or a control size changes.
          */
                contentStyle={{ paddingBottom: chromeHeight }}
                header={
                  chat.subagents.length ? (
                    <AgentsBar
                      count={chat.subagents.length}
                      onPress={openAgents}
                      startedAtMs={oldestStart(chat.subagents)}
                    />
                  ) : null
                }
                {...(highlightId ? { highlightItemId: highlightId } : {})}
                attachmentUri={attachmentUri}
                groupChat={groupChat}
                images={images}
                {...(ownAuthorId ? { ownAuthorId } : {})}
                onOpenAttachment={openAttachment}
                requestSenderPicture={requestSenderPicture}
                resolveSenderPictureUri={resolveSenderPictureUri}
                subscribeSenderPictures={subscribeSenderPictures}
                items={chat.items}
                newMessageCount={newCount}
                loadingOlder={loadingOlder}
                onEndReached={loadOlder}
                {...(lastAssistantId ? { lastAssistantId } : {})}
                onEditResend={editResend}
                onRegenerate={regenerate}
                regeneratePromptIsOwn={regeneratePromptIsOwn}
                {...(runtime ? { onBranch: branchHere } : {})}
                turnRunning={chat.turnActive}
                {...(readAloud.available ? { onReadAloud: readAloud.toggle } : {})}
                readingItemIds={readAloud.readingIds}
                onOpenBot={openBot}
                onOpenCron={openCron}
                approvalForTool={approvalForTool}
                onOpenRequest={reopenRequest}
                onRespondApproval={answerApprovalInline}
                onOpenTranscript={openTranscript}
                onScrolledAwayFromBottom={onScrolledAway}
                ref={listRef}
                subagents={subagents}
                // The TURN is running and nothing has been said yet: three dots. Not
                // `busy` — that also covers a tool or a child still working, and dots
                // under a finished reply promise a sentence that is not coming.
                typing={chat.turnActive && !hasStreamingText(chat.items)}
                typingHandles={typing}
              />
            </TypeScaleProvider>
          )}

          {/*
          The chrome, laid OVER the transcript rather than above it.

          The owner's reference is iPadOS 26 Messages: the buttons and the contact
          pill float on the conversation and the messages blur through them, which
          only works if the list occupies the space they sit in. `box-none` so the
          gaps between the three elements pass drags and taps down to the list.

          It is a sibling of the list inside the keyboard-avoiding view, not a
          child of it, so the chrome does not move when the keyboard opens.
        */}
          <View
            onLayout={event => {
              setChromeHeight(event.nativeEvent.layout.height)
              setChromeWidth(event.nativeEvent.layout.width)
            }}
            pointerEvents="box-none"
            style={{ left: 0, position: 'absolute', right: 0, top: 0 }}
            testID="chat-chrome"
          >
            <ChatHeader
              accentFill={theme.accent(accent).fill}
              avatarUri={avatar}
              name={names.primary}
              onBack={onBack}
              onOpenOptions={openOptions}
              onOpenProfile={openProfile}
              onToggleSidebar={onToggleSidebar}
              // The resolved state, from the same function the chat list uses. It is
              // what keeps the header from saying "Connecting…" over a live chat: the
              // socket's own status is not a bot's state.
              presence={presence.state}
              {...(canCreate ? { onOpenConversations: openConversations } : {})}
              {...(conversationSecondaryName ? { secondaryName: conversationSecondaryName } : {})}
              {...(presence.lastSeenAt !== undefined ? { lastSeenAt: presence.lastSeenAt } : {})}
              {...(subtitle ? { subtitle } : {})}
            />
          </View>

          {/*
            The options popover, and the tap that puts it away.

            BOTH are absolutely positioned and both are siblings of the
            transcript rather than children of it, which is the whole of the
            owner's request: opening this lays nothing out, so the list's own
            content inset, the composer and everything behind the surface stay
            exactly where they were. `chat-options-popover.test.tsx` asserts
            that inset is the same number open and closed, because "nothing
            moves" is the requirement and every other assertion here would pass
            with a padding that quietly changed.

            `box-none` on the layer so the gaps around the popover — which is
            most of the screen — reach the catcher underneath it, and the
            catcher is rendered FIRST so the popover's own rows still get the
            tap.
          */}
          {optionsPopover ? (
            <Pressable
              accessibilityElementsHidden
              aria-hidden
              importantForAccessibility="no-hide-descendants"
              onPress={closeOptionsPopover}
              style={{ bottom: 0, left: 0, position: 'absolute', right: 0, top: 0 }}
              testID="chat-options-backdrop"
            />
          ) : null}

          <View
            pointerEvents="box-none"
            style={{
              left: 0,
              paddingHorizontal: theme.space.md,
              position: 'absolute',
              right: 0,
              top: chromeHeight
            }}
            testID="chat-options-layer"
          >
            <ChatOptionsPopover
              accent={accent}
              botName={display}
              canExport
              canSetNotifications={Boolean(notifications)}
              /*
                ADR-0007, amended: the shared Bot Chat or this reader's own.

                Passed as a NODE because the control belongs to
                `features/user-chats` and the popover is `ui/`. It draws nothing
                where the gateway named nobody, so a session-token deployment
                sees the menu it has always seen.
              */
              chatChoice={
                <ChatChoiceRow
                  available={Boolean(userChats?.available && byName[botName])}
                  choice={myChat ? 'mine' : 'shared'}
                  onChoose={async choice => {
                    const row = byName[botName]

                    if (row) {
                      await runtime?.controller.chooseChat(row, choice)
                    }
                  }}
                  testID="chat-choice"
                />
              }
              contextUsage={chat.contextUsage}
              fast={chat.info?.fast === true}
              model={chat.info?.model ?? ''}
              modelLabel={modelRowLabel(modelOptions, chat.info?.model ?? '')}
              modelOptions={modelOptions}
              muteLabel={muteRowLabel(
                mutedUntilOf(mutes, botName, Math.floor(Date.now() / 1000)),
                Math.floor(Date.now() / 1000)
              )}
              mutedUntil={mutedUntilOf(mutes, botName, Math.floor(Date.now() / 1000))}
              onChangeAccent={value => useChatLayoutStore.getState().setAccent(botName, value)}
              onChangeFast={value => void setOption('fast', value ? 'fast' : 'normal')}
              onChangeModel={value => void setOption('model', value)}
              onChangeMute={(until: number | null) => useChatLayoutStore.getState().setMute(botName, until)}
              onChangeReasoningEffort={value => void setOption('reasoning', value)}
              onChangeShowBotToBot={value => useSettingsStore.getState().setChatView(botName, { showBotToBot: value })}
              onChangeShowThinking={value => useSettingsStore.getState().setChatView(botName, { showThinking: value })}
              onChangeTextSize={value => useSettingsStore.getState().setTextSize(value)}
              onChangeVerbosity={(value: Verbosity) =>
                useSettingsStore.getState().setChatView(botName, { level: value })
              }
              onChangeYolo={value => void setOption('yolo', value ? 'true' : 'false')}
              onClose={closeOptionsPopover}
              onOpenPage={openOptionsPage}
              onRefresh={refreshChat}
              {...(runtime && onOpenConversation ? { onBranch: branchNewest } : {})}
              {...(canCreate ? { onNewChat: newChat } : {})}
              {...(onOpenConversations
                ? {
                    onOpenConversations: () => {
                      setOptionsPopover(false)
                      onOpenConversations(botName)
                    }
                  }
                : {})}
              onTogglePin={() => {
                setOptionsPopover(false)
                useChatLayoutStore.getState().togglePinned(botName)
              }}
              pinned={pinned}
              onResetView={() => useSettingsStore.getState().resetChatView(botName)}
              reasoningEffort={chat.info?.reasoning_effort ?? ''}
              reasoningLabel={optionRowLabel(REASONING_OPTIONS, chat.info?.reasoning_effort ?? '')}
              reasoningOptions={REASONING_OPTIONS}
              showBotToBot={view.showBotToBot}
              showThinking={view.showThinking}
              textSize={textSize}
              verbosity={view.level}
              viewOverridden={overridden}
              visible={optionsPopover}
              yolo={chat.info?.yolo === true}
            />
          </View>

          {/*
            The same fact as the plate above, for a chat that has something to
            read: a thin pill in the flow directly over the composer.

            In the FLOW rather than floating, which is the one arrangement that
            cannot collide with the jump-to-latest pill — that one already floats
            at the bottom of the transcript, and two pills landing on each other
            is the sort of thing only a dropped connection would ever show. The
            list loses the pill's height and an inverted list keeps its bottom
            pinned, so the newest message does not move when it arrives.
          */}
          {/*
            The messages parked behind the running turn, over the composer where
            the reader left them rather than as bubbles in the history. See
            `QueuedStrip`, and `TranscriptList` for what taking them out of the
            list did to the scroll anchor.
          */}
          <View style={{ paddingHorizontal: theme.space.md }}>
            <QueuedStrip onDelete={chat.deleteQueued} onEdit={editQueued} onSteer={steerQueued} queued={chat.queued} />
          </View>

          <Appear
            rise={6}
            style={{ paddingBottom: theme.space.xs, paddingHorizontal: theme.space.md }}
            testID="chat-reconnect-slot"
            visible={connectionState.kind === 'pill'}
          >
            <ReconnectPill
              message={connectionState.message}
              onRetry={retryConnection}
              phase={connectionState.phase}
              retry={connectionState.retry}
            />
          </Appear>

          <Composer
            attachBusy={attachBusy}
            attachments={composerAttachments}
            botName={display}
            onAttach={() => void attach()}
            // The `+` menu's second entry. Both pickers exist on every target this
            // builds for, so neither is conditional.
            onAttachFile={() => void attachFile()}
            onPasteFiles={pasteFiles}
            dictation={dictation}
            onChangeText={chat.setDraft}
            onQuerySlash={querySlash}
            onRemoveAttachment={id => {
              setAttachments(current => current.filter(file => file.id !== id))
              setPendingFiles(current => current.filter(file => file.id !== id))
              // An uploaded file is left on the gateway: deleting it would need a
              // second round trip to undo something the user only unstaged.
              setUploaded(current => current.filter(file => file.id !== id))
            }}
            onSend={text => void send(text)}
            onStop={() => void chat.stop()}
            running={busy}
            /*
              Typing stays possible and sending does not. A draft written while
              the gateway is away is worth keeping — it is the reason to sit
              through a reconnect at all — but a send that cannot reach anything
              either throws the words away or invents a queue nobody asked for.
            */
            sendBlocked={connectionState.kind !== 'none'}
            slashFailure={slashFailure}
            slashLoading={slashLoading}
            suggestions={suggestions}
            value={chat.draft}
            {...(chat.queuedText ? { queuedText: chat.queuedText } : {})}
          />
        </KeyboardInset>
      </DropZone>

      {/* One sheet, never four. `ChatSheetHost` decides which, and closes the
          one on screen before it opens the next. */}
      <ChatSheetHost
        agents={{
          notice: agentsNotice,
          onCloseTranscript: () => setTranscript(null),
          onInterrupt: id => void stopChild(id),
          onOpenTranscript: openTranscript,
          onSteer: (id, text) => void steerChild(id, text),
          transcript,
          tree: chat.subagentTree
        }}
        botHandle={botName}
        {...(canCreate
          ? {
              conversations: {
                botName,
                // The sheet closes first (`closeManualSheet`), so the archive
                // page is not a second modal over it — the same order every
                // other "open a page from a sheet" handoff in this screen uses.
                ...(onOpenConversations
                  ? {
                      onOpenArchive: () => {
                        closeManualSheet()
                        onOpenConversations(botName)
                      }
                    }
                  : {})
              }
            }
          : {})}
        dismissedIds={dismissedRequests}
        findRequest={findRequest}
        manual={sheet}
        {...(byName[botName]
          ? {
              profile: {
                avatarUri: avatar,
                bot: byName[botName],
                contextUsage: chat.contextUsage,
                gateway: profileGateway,
                gatewayId,
                gatewayVersion: config?.version ?? '',
                http,
                // The sheet goes first, so the page is not a second modal over
                // it — the same order `BotsScreen` opens the browser in.
                onOpenMemory: () => {
                  closeManualSheet()
                  setMemoryFor(byName[botName]?.name ?? botName)
                },
                // A saved description or picture only reaches the header, the
                // list and every other chat once the roster has been read
                // again; the sheet itself writes to the gateway, not the store.
                onSaved: onProfileSaved
              }
            }
          : {})}
        onCloseManual={closeManualSheet}
        onCloseRequest={dismissRequest}
        onLockClarify={lockClarify}
        onRespondApproval={respondApproval}
        onShowRequest={acknowledge}
        onSubmitClarify={submitClarify}
        options={{
          accent,
          botName: display,
          ...(optionsPane ? { initialPane: optionsPane } : {}),
          confirmMessage: pendingModel?.message ?? '',
          contextUsage: chat.contextUsage,
          onExport: exportChat,
          fast: chat.info?.fast === true,
          model: chat.info?.model ?? '',
          modelOptions,
          mutedUntil: mutedUntilOf(mutes, botName, Math.floor(Date.now() / 1000)),
          ...(notifications ? { notifications } : {}),
          onCancelExpensiveModel: () => setPendingModel(null),
          onChangeMute: (until: number | null) => useChatLayoutStore.getState().setMute(botName, until),
          /*
            The gateway's own words, not a boolean.

            `config.set {key:'fast'}` is parsed by a word list — fast, on,
            normal, off, auto, cold — and `true` is in none of it, so every tap
            came back as 4002 "unknown fast mode: true" and the switch snapped
            straight back. `yolo` next door really does take `true`/`false`,
            which is why one of the two toggles worked and the other never did.
          */
          onChangeFast: value => void setOption('fast', value ? 'fast' : 'normal'),
          onChangeModel: value => void setOption('model', value),
          onChangeReasoningEffort: value => void setOption('reasoning', value),
          onChangeShowBotToBot: value => useSettingsStore.getState().setChatView(botName, { showBotToBot: value }),
          onChangeShowThinking: value => useSettingsStore.getState().setChatView(botName, { showThinking: value }),
          onChangeVerbosity: (value: Verbosity) => useSettingsStore.getState().setChatView(botName, { level: value }),
          onChangeAccent: value => useChatLayoutStore.getState().setAccent(botName, value),
          onChangeYolo: value => void setOption('yolo', value ? 'true' : 'false'),
          onConfirmExpensiveModel: () => {
            if (pendingModel) {
              void setOption('model', pendingModel.value, true)
            }
          },
          onResetView: () => useSettingsStore.getState().resetChatView(botName),
          /*
            The Voice group, present only where the platform can speak.

            `voice: undefined` removes the whole group rather than drawing it
            with a dead switch, which is the same rule the export group follows:
            a control that cannot do anything is worse than a control that is
            not there. A browser with no `speechSynthesis` is the case.
          */
          ...(readAloud.available
            ? {
                voice: {
                  autoRead,
                  /*
                    The toggle is about the NEXT reply, and switching it off
                    deliberately does not cut the sentence being spoken: a
                    reader who has heard half an answer did not ask for the
                    other half to be taken away. Stopping is its own row, and it
                    is only drawn while there is something to stop.
                  */
                  onChangeAutoRead: (value: boolean) => useVoiceSettingsStore.getState().setAutoRead(botName, value),
                  onChangeConfirmBeforeSending: (value: boolean) =>
                    useVoiceSettingsStore.getState().setConfirmBeforeSending(value),
                  onChangeRate: (value: number) => useVoiceSettingsStore.getState().setRate(value),
                  confirmBeforeSending: voiceConfirm,
                  ...(voiceMode.available
                    ? {
                        onOpenVoiceMode: () => {
                          // The sheet goes first: an overlay opening over an
                          // open sheet is two modals deep, which is where a
                          // `Modal` stops behaving the same on all four targets.
                          closeManualSheet()
                          voiceMode.open()
                        }
                      }
                    : {}),
                  onStopReading: readAloud.stop,
                  rate: voiceRate,
                  reading: readAloud.reading,
                  // The listening half only where there is a microphone behind
                  // it: a browser with speech synthesis and no recognizer gets
                  // the reading rows and no language picker.
                  ...(dictation.available
                    ? {
                        dictation: {
                          language: voiceLanguage,
                          languages: dictationLanguages,
                          onChangeLanguage: (value: string) =>
                            useVoiceSettingsStore.getState().setDictationLanguage(value)
                        }
                      }
                    : {})
                }
              }
            : {}),
          pendingExpensiveModel: pendingModel?.value ?? null,
          reasoningEffort: chat.info?.reasoning_effort ?? '',
          reasoningOptions: REASONING_OPTIONS,
          showBotToBot: view.showBotToBot,
          showThinking: view.showThinking,
          verbosity: view.level,
          viewOverridden: overridden,
          yolo: chat.info?.yolo === true
        }}
        {...(request ? { request } : {})}
      />

      {/*
        Voice mode, over everything.

        A `Modal` of its own rather than a fifth case in `ChatSheetHost`: that
        host owns the four BOTTOM SHEETS and closes one before opening the next,
        and this is not a sheet — it is full screen, it has no page stack, and it
        stays up across a whole conversation. What it does share is the rule that
        only one of them is on screen at a time, which is why opening it from the
        options sheet closes that sheet first.
      */}
      <VoiceOverlay
        botName={display}
        onCancel={voiceMode.cancel}
        onInterrupt={voiceMode.interrupt}
        onLeave={voiceMode.leave}
        state={voiceMode.state}
        visible={voiceMode.active}
      />
    </Screen>
  )
}

/**
 * What the jump-to-latest pill counts: messages, not rows.
 *
 * The same rule as the chat list's badge, and deliberately the same list as
 * `countsAsMessage` in the transcript selectors: bot-to-bot traffic does not
 * count. A scrolled-up reader being told "3 new" and finding three asides
 * between two agents is the pill making a promise the transcript does not keep —
 * the owner's rule that bot-to-bot must not bump a count is about every count,
 * not only the one on the chat list.
 */
const MESSAGE_KINDS = new Set<string>(['assistant', 'user'])

/**
 * How many pages back a search will walk before it gives up.
 *
 * Two hundred rows a page, so this is forty thousand rows — further than any
 * reader would scroll and far enough that a query which stops here almost
 * certainly matched something this side cannot see at all: the gateway indexes
 * the JSON-encoded message and `findMatchingItem` searches the rendered item, so
 * a hit on a tool's arguments is unreachable however long the walk.
 */
const FIND_PAGE_LIMIT = 200

/** A stable empty map, so a chat without children does not churn the memo. */
const EMPTY_SUBAGENTS: Record<string, never> = {}

/** The plan's cadence for `subagent.tail` while a child is running. */
const SUBAGENT_TAIL_POLL_MS = 3_000

/** One stored transcript row as a plain line, for the read-only child view. */
function transcriptLine(item: TranscriptItem): string {
  switch (item.kind) {
    case 'user':
      return item.text ? `> ${item.text}` : ''
    case 'assistant':
      return item.text ?? ''
    case 'tool':
      return `· ${item.context || item.summary || item.name}`
    default:
      return ''
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * What the bar above the transcript is ABOUT, which is not always the same
 * thing.
 *
 * It used to be one string and one sentence — "This conversation could not be
 * opened: …" — wrapped around whatever had gone wrong. That sentence is right
 * for the failure it was written for and false for the other one: a gateway
 * refusing a single setting says nothing about the conversation, which is open,
 * readable and still streaming while the bar claims it could not be opened.
 */
type ChatNotice =
  | { kind: 'open' | 'setting'; text: string }
  /**
   * A branch was made, and here is the way into it.
   *
   * The third kind, and the first one that is not a failure — which is why it
   * carries its own `onOpen` rather than reusing Retry. Branching changes
   * NOTHING on the screen the reader is looking at (the parent is untouched by
   * construction), so without a line saying so the gesture would appear to have
   * done nothing at all.
   */
  | { kind: 'branch'; text: string; onOpen: () => void }

/** This conversation could not be opened. */
const openFailed = (text: string): ChatNotice => ({ kind: 'open', text })

/** The chat is fine; the gateway refused one option on it. */
const settingRefused = (text: string): ChatNotice => ({ kind: 'setting', text })

/** The earliest start among the running children, in epoch milliseconds. */
function oldestStart(children: readonly { startedAt: number }[]): number | undefined {
  const starts = children.map(child => child.startedAt).filter(value => value > 0)

  return starts.length ? Math.min(...starts) : undefined
}

/** True once the running turn has said anything; the typing dots stop there. */
function hasStreamingText(items: readonly { item: { kind: string } }[]): boolean {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]?.item as { kind: string; streaming?: boolean; text?: string } | undefined

    if (item?.kind === 'assistant') {
      return Boolean(item.streaming && item.text?.trim())
    }
  }

  return false
}

/**
 * A DM card carries the routing handle, which is usually but not always the
 * profile name. Matching case-insensitively against the roster keeps a tap on
 * "@Writer" opening Writer's chat.
 */
function resolveBot(handle: string, names: readonly string[]): string {
  const needle = handle.replace(/^@/, '').toLowerCase()

  return names.find(name => name.toLowerCase() === needle) ?? needle
}

/**
 * What the bot is doing, and failing that, what the connection is.
 *
 * The two halves are in that order on purpose and the rule is the owner's: a
 * chat that is visibly streaming must never be described by the socket's
 * bookkeeping. So anything `turnActivity` can prove about the TURN wins, and
 * the connection's own words are what is left when the turn has nothing to say.
 *
 * It replaced a single `Working…` that covered the whole of a turn. That line
 * was true for every second of it and told a reader nothing about which second
 * they were looking at — whether the model was thinking, writing, running a
 * command on their machine, or waiting on them.
 */
/**
 * A thrown value, as one printable line.
 *
 * Only for the rejections `querySlash` does NOT absorb — a missing runtime
 * session, most often — because everything the gateway itself refused has
 * already been through `describeRpcFailure` and arrives with its words picked
 * out. Capped at the same length for the same reason: this lands in a popover.
 */
function slashReasonOf(error: unknown): string {
  const raw = (error instanceof Error ? error.message : String(error ?? '')).replace(/\s+/gu, ' ').trim()

  return raw.slice(0, 300) || SLASH_NO_ANSWER
}

function subtitleFor(state: {
  status: string
  hydration: UseChatResult['hydration']
  activity: TurnActivity
  queued: boolean
}): string {
  switch (state.activity.kind) {
    case 'waiting':
      return strings.chat.subtitle.waiting
    case 'thinking':
      return strings.chat.subtitle.thinking
    case 'typing':
      return strings.chat.subtitle.typing
    case 'tool': {
      // `shortToolName` is what keeps this line inside the pill: an MCP tool's own
      // spelling is `mcp__terminal__run_in_terminal`, which is wider than the bot's
      // name and every other status put together.
      const tool = shortToolName(state.activity.tool)

      return tool === '' ? strings.chat.subtitle.working : strings.chat.subtitle.running(tool)
    }
    case 'delegating':
      return strings.chat.subtitle.delegating
    case 'working':
      return strings.chat.subtitle.working
    case 'idle':
      break
  }

  if (state.queued) {
    return strings.chat.subtitle.queued
  }

  switch (state.status) {
    case 'ready':
      return strings.chat.subtitle.idle
    case 'offline':
      return strings.chat.subtitle.offline
    case 'reconnecting':
      return strings.chat.subtitle.reconnecting
    case 'needs_signin':
      return strings.chat.subtitle.signedOut
    case 'connecting':
    case 'authenticating':
    case 'probing':
      // A live chat is one the gateway answered `session.resume` for and is
      // streaming events into. Coming back from the background walks the whole
      // pre-dial ladder again while that session keeps working, and
      // "Connecting…" over a conversation the reader can see updating describes
      // the socket's bookkeeping rather than this chat.
      return state.hydration === 'live' ? strings.chat.subtitle.idle : strings.chat.subtitle.connecting
    default:
      return strings.connection.status.disconnected
  }
}

/**
 * The bar above the transcript, for the three things that are NOT the connection.
 *
 * The connection used to be here too and is not any more: this bar's top edge is
 * the transcript pane's top edge, which the floating chrome covers, so anything
 * put here has to be short enough to survive being half-hidden. An error and a
 * cache notice are; "Waiting for the gateway. This conversation opens as soon as
 * it answers." was not, and that is what the reader was shown. See
 * `connection-notice.ts` for where it went.
 */
function Banner({
  hydration,
  notice,
  onRetry,
  onDismiss,
  onOpenSettings
}: {
  hydration: UseChatResult['hydration']
  notice: ChatNotice | null
  onRetry: () => Promise<void>
  onDismiss: () => void
  /** Only for a refused photo picker: the one failure with a way out. */
  onOpenSettings?: () => void
}) {
  const theme = useTheme()

  if (notice) {
    return (
      <View style={{ backgroundColor: theme.elevation.e3c, gap: theme.space.xs, padding: theme.space.md }}>
        {/*
          A branch is the one notice here that is not a failure, so it is not
          drawn in the danger colour and its text is not wrapped in "could not".
          Everything below it — the row of actions, Done — is the same bar.
        */}
        <Text color={notice.kind === 'branch' ? 'text' : 'dangerText'} testID="chat-notice" variant="preview">
          {notice.kind === 'branch'
            ? notice.text
            : notice.kind === 'setting'
              ? strings.chat.settingRefused(notice.text)
              : strings.chat.failed(notice.text)}
        </Text>
        <View style={{ alignItems: 'center', flexDirection: 'row', gap: theme.space.lg }}>
          {notice.kind === 'branch' ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={notice.onOpen}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
              testID="chat-branch-open"
            >
              <Text color="accentText" variant="preview">
                {chatStrings.sessions.openNow}
              </Text>
            </Pressable>
          ) : null}
          {/*
            Reload is the answer to a chat that would not open, and it is no
            answer at all to a setting the gateway refused: the conversation is
            already there, and rebuilding it would spend a session rebuild on a
            switch that flipped back. Done is the whole of what is on offer.
          */}
          {notice.kind === 'open' ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={() => void onRetry()}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
            >
              <Text color="accentText" variant="preview">
                {strings.chat.retry}
              </Text>
            </Pressable>
          ) : null}
          {onOpenSettings ? (
            <Pressable
              accessibilityRole="button"
              hitSlop={TAP_SLOP}
              onPress={onOpenSettings}
              style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
              testID="chat-open-settings"
            >
              <Text color="accentText" variant="preview">
                {strings.chat.attach.openSettings}
              </Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            hitSlop={TAP_SLOP}
            onPress={onDismiss}
            style={{ justifyContent: 'center', minHeight: CONTROL_MIN_HEIGHT }}
            testID="chat-error-dismiss"
          >
            <Text color="textMuted" variant="preview">
              {strings.common.done}
            </Text>
          </Pressable>
        </View>
      </View>
    )
  }

  if (hydration === 'hydrating') {
    return (
      <View
        style={{
          alignItems: 'center',
          flexDirection: 'row',
          gap: theme.space.sm,
          padding: theme.space.md
        }}
      >
        <ActivityIndicator />
        <Text color="textMuted" variant="preview">
          {strings.chat.hydrating}
        </Text>
      </View>
    )
  }

  if (hydration === 'cached' || hydration === 'stale') {
    return (
      <View style={{ backgroundColor: theme.elevation.e3c, padding: theme.space.md }}>
        <Text color="textMuted" variant="preview">
          {hydration === 'cached' ? strings.chat.offlineCopy : strings.chat.stale}
        </Text>
      </View>
    )
  }

  return null
}
