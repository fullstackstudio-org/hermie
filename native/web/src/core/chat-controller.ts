/**
 * The chat controller: the only thing in the app that talks to the gateway
 * about a transcript.
 *
 * Three rules shape the whole file.
 *
 * **Every opened chat stays live.** Leaving the screen does not detach. A bot
 * that receives a teammate's DM only streams it into a chat that is resumed, so
 * closing on navigation would turn bot-to-bot traffic into a silent list of
 * missed messages the user has to go looking for.
 *
 * **Runtime ids are never persisted.** The gateway hands out a new runtime
 * `session_id` every time it rebuilds a session, and every event and every
 * server request is addressed by that id. What is persisted is the canonical
 * chat's durable id; the runtime id lives in `runtimeToBot` and is dropped on
 * `session.reclaimed`.
 *
 * **A turn nobody here started is a foreign turn.** The reducer stands a
 * placeholder in, and this fills it with a short tail fetch. That covers a
 * teammate bot writing into the chat, the same chat open on a desktop, and a
 * cron job delivering into it.
 *
 * Ported whole from the Expo app's `src/features/chats/chat-controller.ts`;
 * every method, field and constant keeps its name and its behaviour.
 * Deliberate differences:
 *
 *  - **Everything that changes a chat goes through the ingest**
 *    (`core/ingest.ts`). The controller builds one over the chat store it is
 *    handed and routes the store's actions through it; `this.chats` is the
 *    ingest's view (a getter, where the Expo app held the store). A gateway
 *    event is queued and handled at the next frame; a server request is
 *    handled at once, behind every event that arrived before it, because the
 *    channel needs its answer synchronously; what the controller writes after
 *    an `await` lands behind every event that arrived before the answer. The
 *    controller reads exactly what the Expo store would have handed it, and a
 *    screen subscribed to the store sees one commit per frame. `stop()` applies
 *    what is still queued and hands the store's actions back; a `start()` after
 *    it builds a fresh ingest. New options: `frames` and `visibility`, for it.
 *  - **The plugin advert is read from the `plugin` option** (the page's
 *    `pluginStore` unless told otherwise) rather than from the imported
 *    `usePluginStore` hook, so the turn-claim gate reads the advert of the
 *    connection this controller runs on.
 *  - `ChatChoice` and `UserChatSwitch` are declared here, unchanged, rather
 *    than imported from `features/user-chats`, which this client does not have
 *    (the directory is `core/user-chats/`). The page builds one when the session starts
 *    (`features/shell/user-chats.ts`) and hands it to the roster and to this controller through
 *    `connectGateway` and `connectChats`; absent, every bot opens its group chat, which is the Expo app's
 *    behaviour on a gateway that names nobody.
 *  - **New at the bottom: `connectChats`**, the React-free half of the Expo
 *    app's `ChatRuntime` provider (start, page shown and hidden, the cache
 *    write on hide, the own author), with the share outbox and the intents
 *    queue behind `ChatRuntimeHooks`, which does nothing by default.
 */
import { assertDesktopContract, type ConnectionStatus, type GatewayHttp } from '@hermie/gateway-client'
import { hasPluginCapability, PLUGIN_CAPABILITIES } from '@hermie/gateway-client/plugin'
import {
  applySubagentSnapshot,
  type ChatState,
  type MessageAuthor,
  type ResumeSnapshot,
  type RowShape,
  rowsToItems,
  snapshotForCache,
  stateFromCache,
  type SubagentSnapshotRow,
  type TranscriptEvent,
  type TranscriptItem,
  type TranscriptRow
} from '@hermie/transcript'
import type {
  CommandsCatalogResult,
  CompletionItem,
  CorrectionStatus,
  OpenRequestEntry,
  PendingApproval,
  SessionLiveInfo,
  SessionResumeResult,
  Usage
} from '@hermes/shared/gateway-contract'
import type { ServerRequest as GatewayServerRequest } from '@hermes/shared/json-rpc-channel'
import type { StoreApi as ZustandStoreApi } from 'zustand/vanilla'

import type { ChatCache } from '../platform/chat-cache'
import { monotonicNow } from '../platform/monotonic-clock'
import { type VisibilityWatcher, visibilityWatcher } from '../platform/visibility'
import type { Bot, BotCanonicalSession, BotsState } from '../state/bots'
import type { ChatsState, ChatsStore, QueuedMessage } from '../state/chats'
import { chatsStore, liveChatNames } from '../state/chats'
import { pluginStore, type PluginState } from '../state/plugin'
import type { BotsController, UserChatSource } from './bots-controller'
import type { ChatControllerOnDemand } from './chat-controller-on-demand'
import { boundConversationOf } from './chats/bound-conversation'
import { fileReferenceFor, imageReferenceFor, withFileReferences } from './chats/file-references'
import type { UploadableFile, UploadedFile } from './chats/file-upload'
import { ownAuthorOn, type OwnAuthorState, ownAuthorStore } from './chats/own-author'
import { claimTurn } from './chats/turn-claim'
import type { GatewayClient } from './gateway-client'
import { createIngest, type FrameSource, type Ingest } from './ingest'
import type { ChatGateway } from './link'
import { onDemandPart } from './on-demand'
import { CANCELLED_BY_READER, closedRequest } from './request-withdrawn'
import { isInteractiveMethod, LIMITS as INTERACTIVE_LIMITS } from './requests/interactive-types'
import { displayText } from './requests/secure-input'
import type { RpcFailure } from './rpc-failures'
import type { ConversationList } from './sessions/conversation-list'
import {
  botOfConversationKey,
  cacheKeyFor,
  conversationKey,
  type Conversation,
  type ConversationGroups
} from './sessions/session-model'

/**
 * What the controller does only when a page loaded on demand asks (`chat-controller-on-demand.ts`): a chunk of its own,
 * which the chat screen's chunk brings with it. Each public function there has a method of the same name on
 * `ChatController` that hands the call over; the members that part reads are therefore not `private`, though they are
 * the controller's own and no screen is given them (`ChatScreenController`).
 */
const onDemand = onDemandPart<ChatControllerOnDemand>(() => import('./chat-controller-on-demand'))

/** Called by `chat-controller-on-demand.ts` when it is evaluated. */
export const provideChatControllerOnDemand = (part: ChatControllerOnDemand): void => onDemand.provide(part)

/** Above this many rows, `session.history` is a download; the REST tail is not. */
export const REST_HISTORY_THRESHOLD = 400

/** Rows the REST transcript hands back for a full load. */
export const REST_HISTORY_LIMIT = 200

/**
 * The biggest window the REST transcript will serve in one request.
 *
 * `_get_session_messages` clamps every limit to 500, so this is a ceiling and
 * not a preference: asking for more answers with 500 and no indication that it
 * did. It stopped being a floor on how far back the reader can get when paging
 * arrived — `loadOlder` walks back a page at a time — and it is kept as the
 * statement of what one request can carry.
 */
export const REST_HISTORY_MAX = 500

/**
 * How far back one chat has loaded, and whether there is anything before it.
 *
 * Rows, not items: one row projects to several items, a live item has no row,
 * and the route pages in rows. Held here rather than in the transcript state
 * because it is a fact about this client's reading of the conversation, not
 * about the conversation.
 */
interface HistoryWindow {
  rows: number
  reachedStart: boolean
}

/** Rows a tail reconcile asks for. Enough to cover one foreign turn. */
export const TAIL_ROW_LIMIT = 30

/** `sessions.changed` fires roughly per tick; one sweep per burst is enough. */
export const SESSIONS_CHANGED_DEBOUNCE_MS = 500

/** Approval poll cadence while a turn is running and the app is in front. */
export const APPROVAL_POLL_MS = 30_000

/**
 * How often a chat with live children re-reads `subagent.list`.
 *
 * `subagent.*` has no replay, so a chat opened halfway through a delegation
 * never saw the children start. The roster is the only way to learn about them,
 * and once it has, the events carry the rest.
 */
export const SUBAGENT_RECONCILE_MS = 5_000

/** Rows the Activity screen's background load asks for per bot. */
export const ACTIVITY_TAIL_LIMIT = 50

/**
 * Terminal width the gateway lays its transcript out for.
 *
 * Every `session.resume` carries it. A resume that omits it silently re-lays
 * the session at the gateway's 80-column default, which rewraps everything the
 * chat has already shown.
 */
export /** The contract number a `session.info` payload carries, if any. */
function contractIn(info: SessionLiveInfo | undefined): number | null {
  const raw = info?.desktop_contract
  const contract = typeof raw === 'string' ? Number.parseInt(raw, 10) : raw

  return typeof contract === 'number' && !Number.isNaN(contract) ? contract : null
}

export const RESUME_COLS = 96

/**
 * Server requests held for a session that is not bound yet, per session.
 *
 * A bound session flushes in the same tick, so this only ever holds the handful
 * of requests one resume replays. The cap is there because a session id the
 * app never binds — another surface's chat on the same socket — would otherwise
 * accumulate for the life of the process.
 */
export const MAX_PARKED_REQUESTS = 16

/** The delivery runner a `message_agent` hand-off spawns (`tools/bot_mode_dm.py`). */
export const DM_DELIVERY_MARKER = 'bot_mode_dm.py --run-delivery'

type StoreApi<T> = {
  getState: () => T
  setState: (partial: Partial<T>) => void
}

/**
 * Which of a bot's two chats the reader picked on the two-position switch.
 * The Expo app's `features/user-chats/user-chat.ts` type, unchanged.
 */
export type ChatChoice = 'shared' | 'mine'

/**
 * The reader's own chats as the controller asks about them: the Expo app's
 * `features/user-chats/user-chat-switch.ts` interface, unchanged. The page builds one
 * (`features/shell/user-chats.ts`); where there is none, `userChats` is absent and every bot opens its
 * group chat.
 */
export interface UserChatSwitch extends UserChatSource {
  /** Whether this gateway named somebody, and therefore has a switch at all. */
  readonly available: boolean
  /** The title this reader's chats carry, or '' when nobody has been named. */
  readonly title: string
  /** Remember the reader's choice, so the roster and the next launch agree. */
  remember(botName: string, choice: ChatChoice): void
}

export interface ChatControllerOptions {
  gateway: ChatGateway
  /**
   * The chat store. The controller routes its actions through its own ingest
   * (`core/ingest.ts`) and reads and writes through that, never through the
   * store directly; screens read the store, which is committed once per frame.
   */
  chats: ChatsStore
  bots: StoreApi<BotsState>
  botsController: BotsController
  /** The REST half, for the one thing that cannot go over the socket: file uploads. */
  http?: GatewayHttp | null
  cache?: ChatCache | null
  now?: () => number
  /**
   * The clock a list of open requests is stamped with (`ReplaySignal.askedAt`): it never runs backward, so a system
   * clock set back cannot make a live request look newer than the list that really listed it. Absent: `now` when it
   * is given (a test that fakes the clock fakes both), else the page's own (`monotonicNow`).
   */
  monotonic?: () => number
  /**
   * Where the reader's own chats live (ADR-0007, amended).
   *
   * Absent means this deployment offers no private chats, which is every
   * gateway that named nobody and every build that predates them.
   */
  userChats?: UserChatSwitch | null
  /**
   * Somewhere to put a gateway refusal this controller decided to absorb.
   *
   * Injected rather than imported so the controller keeps knowing nothing about
   * the app's stores, and so a test can read the failures it recorded.
   */
  onRpcFailure?: (failure: RpcFailure) => void
  /**
   * The reader's own author, in the shape a stamped row carries it
   * (`"<provider>:<user_id>"`, HERM-83, D2), read at the moment a turn begins so
   * the optimistic bubble carries the same author its persisted row will and
   * never flips silhouette when that row lands.
   *
   * Injected, like `onRpcFailure`, so the controller knows nothing about which
   * store holds it. Absent, or answering `undefined` before `/api/auth/me` has
   * — the turn begins unattributed, which is "nobody knows", never a guess.
   */
  ownAuthor?: () => MessageAuthor | undefined
  /** The plugin advert's store, for the turn-claim gate; the page's own unless told otherwise. */
  plugin?: StoreApi<PluginState>
  /** The ingest's frames while the page is visible (`animationFrames` unless told otherwise). */
  frames?: FrameSource
  /** The page's visibility, for the ingest's hidden-tab drain; the page's own unless told otherwise. */
  visibility?: VisibilityWatcher
}

/**
 * What the controller hands over beside the transcript, in wire order (the Swift
 * store's `SessionSignal`). The engine is a parity port and reads none of these
 * (an event it does not know only moves `lastSeq`), so they are picked off the
 * ingest path here for the session's own models (`core/notices.ts`,
 * `core/connections.ts`, `core/session-status.ts`). Payloads are the wire's,
 * unread: the models read them defensively.
 *
 *  - `notice.show` / `notice.clear`: `notification.show` / `.clear`. `chat` is the
 *    key of the chat whose session carried it, when one is bound; most notices
 *    are about the account, whichever session carried them.
 *  - `connection.request` / `connection.update` / `resume.progress`: on a bound
 *    chat's session, only when newer than what the chat has applied (a replayed
 *    frame the chat already saw raises nothing again).
 *  - `resumed`: a `session.resume` answer was applied, with its
 *    `pending_connection` (`null` when the chat waits on nothing) and whether the
 *    transcript is still being loaded behind it (`hydrating`).
 */
export type SessionSignal =
  | { kind: 'notice.show'; chat: string | undefined; payload: Record<string, unknown> }
  | { kind: 'notice.clear'; payload: Record<string, unknown> }
  | { kind: 'connection.request'; chat: string; runtimeSessionId: string; payload: Record<string, unknown> }
  | { kind: 'connection.update'; chat: string; payload: Record<string, unknown> }
  | { kind: 'resume.progress'; chat: string; payload: Record<string, unknown> }
  | {
      kind: 'resumed'
      chat: string
      runtimeSessionId: string
      pendingConnection: Record<string, unknown> | null
      hydrating: boolean
    }

const recordOf = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** The event types a bound chat hands over beside the engine (see `SessionSignal`). */
const CHAT_SIGNAL_TYPES: ReadonlySet<string> = new Set([
  'connection.request',
  'connection.update',
  'session.resume_progress'
])

/**
 * The commands that start a fresh conversation, which this client runs ITSELF.
 *
 * `slash.exec` cannot do it. Upstream runs a worker command in a separate CLI
 * process (`tui_gateway/methods_tools.py::slash.exec` → `_SlashWorker`), and
 * `/new` there rotates THAT worker's session and prints "New session started!"
 * — the live session this app is bound to is never touched. Only the commands
 * in `_SLASH_MIRRORS` (`methods_slash.py`: model, approvals, personality,
 * prompt, …) are mirrored back onto it, and `new` is not one of them. So the
 * line arrived, the reader was told a new session had started, and the next
 * message went to the same session with the same system prompt. Upstream's own
 * desktop app intercepts these client-side for the same reason
 * (`apps/desktop/src/lib/desktop-slash-commands.ts`).
 *
 * `new` with its upstream alias `reset`, plus `clear` — registered upstream as
 * "Clear screen and start a new session", and a screen is not a thing this app
 * has, so the second half is all of it that means anything here.
 */
export const NEW_CONVERSATION_COMMANDS: ReadonlySet<string> = new Set(['new', 'reset', 'clear'])

/**
 * `/status`: the report on a live session. A gateway whose catalogue lists it
 * answers it through `slash.exec` like any command; one whose catalogue does not
 * is asked for the same report directly (`session.status`, which the TUI calls for
 * its own `/status`), so the command never goes out as a prompt to the bot.
 */
export const STATUS_COMMAND = 'status'

/**
 * Which road a command takes.
 *
 * `local` is this client's own, and it exists so that the same catalogue lookup
 * that tells the composer "this is a command, do not send it as prose" can also
 * answer for a command the gateway would mishandle. See
 * `NEW_CONVERSATION_COMMANDS`.
 */
export type SlashRoute = 'dispatch' | 'exec' | 'local'

/** What a slash command left behind for the surface that ran it. */
export interface SlashOutcome {
  /** A `prefill` directive's text: the composer, not the transcript. */
  prefill?: string
}

export type ChatOptionKey = 'yolo' | 'fast' | 'reasoning' | 'model'

export interface SetOptionResult {
  /** The gateway wants an explicit confirmation before switching to this model. */
  confirmRequired?: boolean
  confirmMessage?: string
  warning?: string
}

/**
 * Moving a bot's key to another conversation was refused because it would lose
 * something: a reply still running, a send not yet at the gateway, or messages
 * waiting in the queue. UI-free on purpose; a surface shows
 * `chatStrings.sessions.busy` for it (`error.code === 'conversation-busy'`).
 */
export class ConversationBusyError extends Error {
  readonly code = 'conversation-busy'
  readonly botName: string

  constructor(botName: string) {
    super(
      `${botName} is still replying or has messages queued. Wait until the reply is finished or clear the queue first.`
    )
    this.name = 'ConversationBusyError'
    this.botName = botName
  }
}

interface PendingRequest {
  botName: string
  request: GatewayServerRequest
}

/**
 * The chat store as a stopped controller sees it: the state it had, every action
 * a no-op (they all return nothing), and nothing to subscribe to. A flow that was
 * awaiting an RPC when the controller stopped goes on reading, and writes into thin
 * air; the store itself is left to whoever stopped the controller (a sign-out empties it).
 */
function detachedView(snapshot: ChatsState): StoreApi<ChatsState> {
  const state = Object.fromEntries(
    Object.entries(snapshot).map(([key, value]) => [key, typeof value === 'function' ? () => undefined : value])
  ) as unknown as ChatsState

  // The one action that answers: a runtime id's bot, from the snapshot.
  state.botForRuntime = runtimeSessionId => snapshot.runtimeToBot[runtimeSessionId]

  return { getState: () => state, setState: () => undefined }
}

/**
 * What a reconnect tells the requests answered beside the engine (`core/requests/secure-input.ts`), which hear
 * the live socket only: the `open_requests` a resume or a replay answered with, per runtime session, and the
 * `request.cancel` events a replay carried. `askedAt` is this controller's clock just before the call went out:
 * a request first seen after it may be newer than the snapshot.
 */
export type ReplaySignal =
  | { kind: 'open_requests'; sessionId: string; ids: readonly string[]; askedAt: number }
  | { kind: 'cancel'; id: string; reason: string }

export class ChatController {
  readonly gateway: ChatGateway
  private readonly replayListeners = new Set<(signal: ReplaySignal) => void>()
  /** The store itself: only the ingest touches it (routes its actions, commits to it). */
  private readonly store: ChatsStore
  readonly bots: StoreApi<BotsState>
  readonly botsController: BotsController
  readonly http: GatewayHttp | null
  readonly cache: ChatCache | null
  readonly now: () => number
  /** The monotonic clock the replay signals' `askedAt` is on. */
  private readonly monotonic: () => number
  readonly onRpcFailure: ((failure: RpcFailure) => void) | undefined
  private readonly ownAuthor: () => MessageAuthor | undefined
  private readonly plugin: StoreApi<PluginState>
  private readonly frames: FrameSource | undefined
  private readonly visibility: VisibilityWatcher | undefined
  /** The one road into the chat store (`core/ingest.ts`); rebuilt by a `start` after a `stop`. */
  private ingestRef: Ingest
  /**
   * Set by `stop()`, cleared by `start()`: what an answer that arrives after the
   * controller was stopped (a slow RPC, a cache read) is read against. While it is
   * set `chats` is a view that writes nothing, and `persist` writes nothing, so
   * the late answer cannot put a person's chat back into a store that was just
   * emptied for a sign-out, or into a cache that was just cleared.
   */
  private detached: StoreApi<ChatsState> | null = null

  private unsubscribes: (() => void)[] = []
  /** Approval request ids already acknowledged, so the ack is sent once. */
  private readonly acknowledged = new Set<string>()

  /**
   * The bytes behind a queued message, by queue id, and the counter that names
   * them. The store holds what the transcript draws; this holds what the send
   * will need if and when it runs.
   */
  private readonly queuedAttachments = new Map<string, AttachmentInput[]>()
  private queueSeq = 0

  /** The gateway's model inventory, read once per connection. */
  models: ModelChoice[] | null = null
  modelsInFlight: Promise<ModelChoice[]> | null = null

  /**
   * Whether `session.usage` is worth calling on this connection.
   *
   * Set false by the gateway's own refusal and never set back: a method a
   * gateway does not have is not going to appear while the socket is up, and
   * asking again per chat would turn one absent capability into one failed RPC
   * per conversation the reader opens. A fresh connection builds a fresh
   * controller, which is where it becomes true again.
   */
  usageSupported = true

  /** Live server→client requests, by JSON-RPC request id, so a card can answer. */
  private readonly pending = new Map<string, PendingRequest>()
  /**
   * Requests whose session is not bound yet, by runtime session id.
   *
   * The channel replays `open_requests` from a `session.resume` result BEFORE
   * resolving the call, so the approvals a reconnect inherits arrive a tick
   * before anything knows which bot owns them. Declining one is not a neutral
   * "not mine": the gateway reads the -32601 as "this client cannot answer"
   * and WITHDRAWS the approval, so the question the agent is parked on simply
   * disappears. They wait here instead and go in on `bindRuntime`.
   */
  /** How far back each chat has read, and whether the start is in sight. */
  readonly windows = new Map<string, HistoryWindow>()
  /** Chats with a page of older history in the air, so the list cannot ask twice. */
  readonly loadingOlder = new Set<string>()
  readonly parked = new Map<string, GatewayServerRequest[]>()
  readonly opening = new Map<string, Promise<void>>()
  /** Sends under each key that have not had their `prompt.submit` answered yet. */
  private readonly sending = new Map<string, number>()
  readonly slashCatalogs = new Map<string, CommandsCatalogResult>()
  /**
   * One catalogue fetch per session, shared by every keystroke that wants it.
   *
   * It resolves to the REFUSAL when there was one, so the six keystrokes that
   * arrive while a catalogue is in the air all learn the same answer — and the
   * popover a reader is looking at says the same thing whichever of them it was
   * painted by.
   */
  readonly slashCatalogLoads = new Map<string, Promise<SlashFailure | null>>()
  /**
   * Whether `complete.slash` may be told which session is asking.
   *
   * Upstream added `session_id` to `CompleteSlashParams` so the popup can offer
   * a session's project-local skills; a gateway from before that (Hermes
   * 0.21.3's own contract has `text` alone) validates params with
   * `extra="forbid"` and refuses the whole call with 4000 "Extra inputs are not
   * permitted". So the first refusal of that exact shape turns the field off for
   * the rest of this connection and the call is repeated without it — which
   * costs the older gateway only the project-local skills it never had.
   */
  slashSessionParam = true
  private sessionsChangedTimer: ReturnType<typeof setTimeout> | undefined
  private approvalPollTimer: ReturnType<typeof setInterval> | undefined
  private subagentPollTimer: ReturnType<typeof setInterval> | undefined
  private foregrounded = true
  private sawReady = false
  private started = false
  /**
   * The desktop contract this gateway last reported, from any resume or
   * `session.info`. A bot that has never spoken resumes without one (see
   * `assertDesktopContract`), and this is what stands in for it.
   */
  private knownContract: number | null = null
  readonly userChats: UserChatSwitch | null
  /** Who wants to hear that a bot's conversation list may have changed, by bot. */
  private readonly conversationListeners = new Map<string, Set<() => void>>()
  /**
   * The titles of the reader's own chats this controller has seen, by stored id:
   * from a listing, a "New chat", a rename. The auto-relabel reads it, because a
   * chat is only ever relabelled from the stamp it was born with.
   */
  readonly ownTitles = new Map<string, string>()
  /** Own chats the auto-relabel has already had its one try at. */
  readonly relabelTried = new Set<string>()
  /** `message_count` of each own chat when it was opened, by conversation key. */
  readonly openedCounts = new Map<string, number>()
  /** `message_count` of each own chat in the latest listing, by stored id. */
  readonly listedCounts = new Map<string, number>()
  /** Who hears what the gateway says beside the transcript (`onSessionSignal`). */
  private readonly sessionListeners = new Set<(signal: SessionSignal) => void>()
  /** Whether the connection is at `ready` now. */
  private connected = false
  /**
   * Chats a replay could not vouch for (`noteReplayGap`) while they could not be
   * read again yet: the socket was not ready, or a recovery was on its way. The
   * recovery reads them again.
   */
  private readonly gapped = new Set<string>()
  /** Chats a reconnect is recovering right now (`recoverAfterReconnect`). */
  private readonly recovering = new Set<string>()
  /** The full re-read of each chat in the air, so two reasons to read it again read it once. */
  private readonly refetching = new Map<string, Promise<void>>()
  /**
   * Chats whose last resume said the gateway was still loading the transcript
   * behind it (`hydrating: true`): what was read then may be short, so the chat is
   * read again once `session.resume_progress` says the load is `complete`.
   */
  private readonly loadingResumes = new Set<string>()

  constructor(options: ChatControllerOptions) {
    this.gateway = options.gateway
    this.store = options.chats
    this.bots = options.bots
    this.botsController = options.botsController
    this.http = options.http ?? null
    this.cache = options.cache ?? null
    this.now = options.now ?? (() => Date.now())
    this.monotonic = options.monotonic ?? options.now ?? monotonicNow
    this.userChats = options.userChats ?? null
    this.onRpcFailure = options.onRpcFailure
    this.ownAuthor = options.ownAuthor ?? (() => undefined)
    this.plugin = options.plugin ?? pluginStore
    this.frames = options.frames
    this.visibility = options.visibility
    this.ingestRef = this.createIngest()
  }

  /**
   * Hear what the gateway says beside the transcript (`SessionSignal`), at its
   * place among the chat's frames. Returns the way to stop.
   */
  onSessionSignal(listener: (signal: SessionSignal) => void): () => void {
    this.sessionListeners.add(listener)

    return () => this.sessionListeners.delete(listener)
  }

  /** Hand one signal over; whatever a listener does, it never costs the chats. */
  private signal(signal: SessionSignal): void {
    if (this.detached) {
      return
    }

    for (const listener of [...this.sessionListeners]) {
      try {
        listener(signal)
      } catch {
        // The listener is somebody else's feature.
      }
    }
  }

  /**
   * A chat-scoped event the engine does not read, handed over before the engine
   * applies it: only when it is newer than what the chat has applied, so a frame
   * replayed twice raises nothing twice.
   */
  private signalChatEvent(key: string, event: TranscriptEvent): void {
    if (!CHAT_SIGNAL_TYPES.has(event.type)) {
      return
    }

    const chat = this.chats.getState().chats[key]

    if (typeof event.seq === 'number' && chat && event.seq <= chat.lastSeq) {
      return
    }

    const payload = recordOf(event.payload)

    if (event.type === 'connection.request') {
      this.signal({ kind: 'connection.request', chat: key, runtimeSessionId: event.session_id ?? '', payload })
    } else if (event.type === 'connection.update') {
      this.signal({ kind: 'connection.update', chat: key, payload })
    } else {
      this.signal({ kind: 'resume.progress', chat: key, payload })

      if (payload.status === 'complete' && this.loadingResumes.delete(key)) {
        this.refetchWhenOpen(key, typeof payload.message_count === 'number' ? payload.message_count : undefined)
      }
    }
  }

  /**
   * Read a chat again once whatever is opening it has finished: the load a resume
   * deferred is done, and what the opening read may have been short.
   */
  private refetchWhenOpen(key: string, messageCount?: number): void {
    const opening = this.opening.get(key)

    void Promise.resolve(opening)
      .catch(() => undefined)
      .then(() => (this.detached ? undefined : this.refetch(key, messageCount)))
      .catch(() => undefined)
  }

  /** A `session.resume` answer was applied to `key`: what it says beside the transcript. */
  private signalResumed(key: string, runtimeSessionId: string, resume: SessionResumeResult): void {
    const pending = (resume as { pending_connection?: unknown }).pending_connection

    if (resume.hydrating === true) {
      this.loadingResumes.add(key)
    } else {
      this.loadingResumes.delete(key)
    }

    this.signal({
      kind: 'resumed',
      chat: key,
      runtimeSessionId,
      pendingConnection: typeof pending === 'object' && pending !== null ? recordOf(pending) : null,
      hydrating: resume.hydrating === true
    })
  }

  private createIngest(): Ingest {
    return createIngest({
      store: this.store,
      ...(this.frames ? { frames: this.frames } : {}),
      ...(this.visibility ? { visibility: this.visibility } : {})
    })
  }

  /**
   * The chat store as this controller reads and writes it: the ingest's view,
   * in wire order and ahead of the once-per-frame commit (see `core/ingest.ts`).
   */
  get chats(): StoreApi<ChatsState> {
    return this.detached ?? this.ingestRef.chats
  }

  /** The ingest, for the runtime: it flushes it when the page hides. */
  get ingest(): Ingest {
    return this.ingestRef
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Follow the gateway. Events join the ingest's queue in arrival order and are
   * applied at the next frame; a server request joins it too, and is applied at
   * once, because the channel needs its answer before the handler returns.
   */
  start(): void {
    if (this.started) {
      return
    }

    if (this.ingestRef.disposed) {
      this.ingestRef = this.createIngest()
    }

    this.detached = null
    this.started = true
    this.unsubscribes.push(
      this.gateway.onAny(event =>
        this.ingestRef.push(() => {
          // The same narrowing the replay applies, so a live frame reaches the engine as a replayed one
          // does: with its `turn_id`, and with nothing else the socket happened to carry.
          const narrowed = transcriptEventOf(event as unknown as Record<string, unknown>)

          if (narrowed) {
            this.onEvent(narrowed)
          }
        })
      ),
      this.gateway.onRequest(request => this.ingestRef.now(() => this.onServerRequest(request))),
      this.gateway.onStatus(status => this.onStatus(status))
    )
  }

  /** Hear what reconnects learn about open server requests (`ReplaySignal`). Returns the way to stop. */
  onReplaySignal(listener: (signal: ReplaySignal) => void): () => void {
    this.replayListeners.add(listener)

    return () => this.replayListeners.delete(listener)
  }

  private signalReplay(signal: ReplaySignal): void {
    for (const listener of [...this.replayListeners]) {
      try {
        listener(signal)
      } catch {
        // A listener's failure is its own; the chats carry on.
      }
    }
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe()
    }

    this.unsubscribes = []
    this.started = false
    // What arrived before the unsubscribe was applied by the Expo store the
    // moment it arrived; here it is still queued, so it is applied now and the
    // store told, before the timers that applying can arm are cleared below.
    // The store's actions go back to the store itself.
    this.ingestRef.dispose()
    // From here a flow that was in flight when the controller stopped reads what
    // the chats were at that moment and writes nothing (see `detached`).
    this.detached = detachedView(this.store.getState())
    this.clearSessionsChangedTimer()
    this.stopApprovalPoll()
    this.stopSubagentPoll()
    this.pending.clear()
    this.parked.clear()
    this.acknowledged.clear()
    this.opening.clear()
    this.slashCatalogs.clear()
    this.slashCatalogLoads.clear()
    this.slashSessionParam = true
    this.connected = false
    this.gapped.clear()
    this.recovering.clear()
    this.refetching.clear()
    this.loadingResumes.clear()
  }

  // ── opening a chat ─────────────────────────────────────────────────────────

  /**
   * Open a bot's canonical chat and leave it live.
   *
   * Calling this for a chat that is already live is cheap on purpose — the
   * roster calls it on every tap — but it is never two hydrations at once.
   */
  openChat(bot: Bot, options: { follow?: boolean } = {}): Promise<void> {
    const existing = this.opening.get(bot.name)

    if (existing) {
      return existing
    }

    const run = this.openCurrent(bot, options.follow === true).finally(() => {
      this.opening.delete(bot.name)
    })

    this.opening.set(bot.name, run)

    return run
  }

  /**
   * Open the conversation this bot's key belongs on.
   *
   * A chat already bound under the key stays on the conversation it is on: a
   * share, a Shortcut or a push tap reaching for a bot whose chat is live must
   * never pull it onto another one because another device chose differently
   * (Owner Decision 4). The reader's memory decides — lookup only, never a mint
   * (`BotsController.settleCurrent`) — on a cold open, where nothing is bound,
   * and when `follow` says the reader is opening the chat screen itself: that is
   * the "next open" a choice made elsewhere waits for. Even then a chat with a
   * reply running or a queue waiting stays put.
   *
   * A failed listing never fails the open: the bot opens its group chat and the
   * memory is left as it was for the next try.
   */
  private async openCurrent(bot: Bot, follow: boolean): Promise<void> {
    if (!this.botsController.tracksCurrent) {
      return this.hydrate(bot)
    }

    const bound = this.boundOwnId(bot.name)

    if (bound !== undefined && (!follow || !this.isIdle(bot.name))) {
      return this.hydrate(botOn(this.bots.getState().byName[bot.name] ?? bot, this.boundSession(bot.name)))
    }

    let own: BotCanonicalSession | null

    try {
      own = await this.botsController.settleCurrent(bot)
    } catch {
      own = bound ? this.boundSession(bot.name) : null
    }

    if (bound !== undefined && bound !== (own?.id ?? null)) {
      try {
        await this.switchTo(bot, own)
      } catch (error) {
        if (!(error instanceof ConversationBusyError)) {
          throw error
        }

        // A send started while the chat was being put away: it stays where it is.
        await this.hydrate(botOn(this.bots.getState().byName[bot.name] ?? bot, this.boundSession(bot.name)))
      }

      return
    }

    this.bots.getState().setCurrent(bot.name, own)
    await this.hydrate(botOn(this.bots.getState().byName[bot.name] ?? bot, own))
  }

  /** The own chat bound under this key, or `null` for the group chat (or nothing). */
  private boundSession(botName: string): BotCanonicalSession | null {
    if (!this.boundOwnId(botName)) {
      return null
    }

    const bots = this.bots.getState()

    return bots.byName[botName]?.current ?? bots.currentSessions[botName] ?? null
  }

  /** Whether moving this key would lose nothing — see `assertIdle`. */
  private isIdle(botName: string): boolean {
    try {
      this.assertIdle(botName)

      return true
    } catch {
      return false
    }
  }

  /**
   * Which conversation is bound under this bot's key right now: an own chat's
   * stored id, `null` for the group chat, `undefined` when nothing is.
   *
   * Read off the two stores together — the chat under the key, and the roster's
   * `current` — because `current` is moved only together with the chat
   * (`switchTo`), or while nothing is bound (`placeCurrentChats`).
   */
  boundOwnId(botName: string): string | null | undefined {
    // The same derivation the transcript and the chat-list preview gate their
    // sender names on (`useGroupChat`), so the three can never disagree.
    return boundConversationOf(this.chats.getState(), this.bots.getState(), botName)
  }

  /**
   * The key the read watermarks of this bot's current conversation live under:
   * the bot's name for the group chat, `bot#<storedId>` for one of the reader's
   * own. `ChatScreen`'s watermark and `closeChat` write through it, so reading
   * a sub-chat never marks the group chat read. A viewer key answers itself.
   */
  readKeyFor(botName: string): string {
    const bound = this.boundOwnId(botName)

    if (bound) {
      return conversationKey(botName, bound)
    }

    if (bound === null) {
      return botName
    }

    const current = this.bots.getState().byName[botName]?.current

    return current ? conversationKey(botName, current.id) : botName
  }

  /** The disk-cache key of whatever is held under a chat-store key. */
  private cacheKeyOf(key: string): string {
    return key.includes('#') ? key : this.readKeyFor(key)
  }

  /** The lead this reader's own chats carry, or '' on a gateway that named nobody. */
  get lead(): string {
    return this.userChats?.available ? this.userChats.title : ''
  }

  /**
   * Whether this gateway has said who the reader is, and a chat of their own can therefore sit beside the shared
   * Bot Chat. False where it named nobody (the switch is then not drawn at all, rather than disabled: a disabled
   * control promises that something could be turned on).
   */
  ownChatsAvailable(): boolean {
    return Boolean(this.userChats?.available)
  }

  private rememberContract(contract: number | null): void {
    if (typeof contract === 'number' && !Number.isNaN(contract)) {
      this.knownContract = contract
    }
  }

  /**
   * Open one of a bot's OTHER conversations — a branch, or one `/new` put away.
   *
   * The same machinery, under a different key. `store/chats.ts` is keyed by bot
   * name because until now a bot had exactly one chat; a branch is a second
   * transcript belonging to the same bot, so it is held under
   * `conversationKey(bot, storedId)` — see `features/sessions/session-model.ts`
   * for why a `#` cannot collide with a profile name. Everything downstream of
   * the key (the reducer, the event routing through `runtimeToBot`, the
   * composer, the approvals) goes on working because all of it was already
   * written against a string.
   *
   * Three things the canonical path does that this one deliberately does not:
   *
   *  - **the transcript cache**, which is keyed by BOT and therefore already
   *    holds the canonical conversation. Writing a branch into it would make the
   *    canonical chat paint the branch on its next cold open;
   *  - **`markSeen`**, which is about the bot's unread badge. Reading a branch
   *    is not reading what arrived in the Bot Chat;
   *  - **`resolveCanonical`**, obviously: the stored id is handed in, and
   *    resolving would find the one conversation this is not.
   */
  openConversation(bot: Bot, storedId: string): Promise<void> {
    const key = conversationKey(bot.name, storedId)
    const existing = this.opening.get(key)

    if (existing) {
      return existing
    }

    const run = this.hydrate(bot, {
      key,
      canonical: { id: storedId, resolvedId: storedId, preview: '', lastActive: 0, messageCount: 0 }
    }).finally(() => {
      this.opening.delete(key)
    })

    this.opening.set(key, run)

    return run
  }

  /**
   * Bring one conversation on screen, canonical or not.
   *
   * `options` is absent for the canonical chat, which is the case every existing
   * caller is in: the key is the bot's name and the session is whatever
   * `resolveCanonical` answers. A branch hands both in, and the two paths differ
   * in nothing else — which is the point, because a second hydration written
   * specially for branches is a second place for the transcript machinery to
   * drift.
   */
  private async hydrate(bot: Bot, options?: { key: string; canonical: BotCanonicalSession }): Promise<void> {
    const chats = this.chats.getState()
    // The bot's own key opens its CURRENT conversation: one of the reader's own
    // chats when `bot.current` names one, the group chat otherwise.
    const canonical = options?.canonical ?? (await this.botsController.resolveCurrent(bot))
    const key = options?.key ?? bot.name
    const isCanonical = key === bot.name
    const isOwn = isCanonical && bot.current?.id === canonical.id

    chats.ensure(key, { storedSessionId: canonical.id, resolvedSessionId: canonical.resolvedId })

    // 1. The cache paints first, so the thread is on screen before the socket
    //    has answered. Reconciliation below keeps the item ids it painted. Only
    //    under the bot's own key, whose cache entry is per CONVERSATION — the
    //    group chat under the bot's name, an own chat under `bot#<storedId>` —
    //    so a switch between them paints from disk rather than cold.
    if (isCanonical) {
      await this.paintFromCache(key, cacheKeyFor(bot.name, canonical.id, !isOwn), canonical.id, canonical.resolvedId)
    }

    this.chats.getState().setHydration(key, 'hydrating')

    let resume: SessionResumeResult
    const resumeAskedAt = this.monotonic()

    try {
      resume = await this.gateway.request('session.resume', {
        session_id: canonical.id,
        profile: bot.name,
        omit_messages: true,
        source: 'hermie',
        cols: RESUME_COLS
      })
    } catch (error) {
      this.chats.getState().setHydration(key, 'error')

      throw error
    }

    // 2. Refuse a gateway too old to send the events this transcript is made of,
    //    before anything half-renders. A never-spoken bot resumes without the
    //    number; the one this gateway reported before stands in for it.
    this.rememberContract(contractIn(resume.info as SessionLiveInfo | undefined))
    assertDesktopContract(resume.info as SessionLiveInfo | undefined, this.knownContract)

    const runtimeId = typeof resume.session_id === 'string' ? resume.session_id : ''

    if (!runtimeId) {
      // Every event and every server request is addressed by this id. Binding
      // an empty one routes the whole session to nobody, which reads as a chat
      // that opened fine and then never said anything again.
      this.chats.getState().setHydration(key, 'error')

      throw new Error(`The gateway resumed ${bot.name}'s chat without a session id.`)
    }

    const resolvedId = resume.stored_session_id || canonical.resolvedId

    this.chats.getState().ensure(key, { storedSessionId: canonical.id, resolvedSessionId: resolvedId })
    this.bindRuntime(key, runtimeId)
    this.chats.getState().markLive(key)

    // The resume's own `info` — the gateway's view of this session: its model,
    // its flags, and its working directory. It was being read once for the
    // contract check and then dropped, which left `chat.info` undefined until
    // the gateway happened to emit a `session.info` event of its own. Two things
    // already assumed otherwise: `refreshOptions` merges its patch onto "what
    // the resume reported", and a file upload needs `cwd` to know where a file
    // may legally go.
    if (resume.info) {
      this.chats.getState().dispatchEvent(key, {
        type: 'session.info',
        session_id: runtimeId,
        payload: resume.info as unknown as Record<string, unknown>
      })
    }

    // 3. History. Either transport projects onto the same items, which is what
    //    lets the reconcile below keep every id it already handed out.
    const messageCount = resume.message_count ?? canonical.messageCount
    const history = await this.loadHistory(runtimeId, resolvedId, bot.name, messageCount)

    if (history.rows.length) {
      this.chats.getState().applyHistory(key, rowsToItems(history.rows, history.shape))
    }

    /*
      Where the far end of the loaded window is, so `loadOlder` knows what to ask
      for next. It is a count of ROWS, not of items: one row can project to
      several items, a live item has no row at all, and the route pages in rows.

      The RPC transport reaches the start by definition — `session.history` is
      unpaginated, so what came back IS the conversation.
    */
    this.windows.set(key, {
      rows: history.rows.length,
      reachedStart: history.shape === 'rpc' || history.rows.length < REST_HISTORY_LIMIT
    })

    // 4. The in-flight tail the persisted rows do not contain yet.
    this.chats.getState().applySnapshot(key, resumeSnapshotOf(resume))
    this.registerOpenRequests(key, resume.open_requests ?? null, runtimeId, resumeAskedAt)
    this.signalResumed(key, runtimeId, resume)

    // 5. Anything that happened between the history read and now.
    await this.replaySince(key, runtimeId)

    this.chats.getState().setHydration(key, 'live')

    if (isOwn) {
      // One of the reader's own chats: its watermarks live under its own key, so
      // opening it clears nothing on the group chat. Opened now, on this device,
      // which is what orders the list (Owner Decision 1).
      const readKey = conversationKey(bot.name, canonical.id)
      const nowSeconds = Math.floor(this.now() / 1000)

      this.openedCounts.set(readKey, messageCount)
      this.bots.getState().markSeen(readKey, nowSeconds)
      this.bots.getState().markSeenCount(readKey, messageCount)
      this.bots.getState().markOpened(canonical.id, nowSeconds)
    } else if (isCanonical) {
      // Seen as of NOW, not as of the roster's `last_active`: the roster row can
      // be a minute old, and a chat the user is looking at is read. A branch is
      // not the Bot Chat, so reading one clears nothing.
      this.bots.getState().markSeen(bot.name, Math.floor(this.now() / 1000))
    }

    this.syncApprovalPoll()

    // A chat opened mid-delegation never saw its children start.
    await this.reconcileSubagents(key)
    this.syncSubagentPoll()
  }

  private async paintFromCache(botName: string, cacheKey: string, storedId: string, resolvedId: string): Promise<void> {
    if (!this.cache) {
      return
    }

    const chat = this.chats.getState().chats[botName]

    if (chat && chat.order.length) {
      return
    }

    try {
      const row = await this.cache.read(cacheKey)

      if (!row) {
        return
      }

      const snapshot = JSON.parse(row.itemsJson) as Parameters<typeof stateFromCache>[2]

      this.chats
        .getState()
        .hydrate(
          botName,
          stateFromCache(botName, { storedSessionId: storedId, resolvedSessionId: resolvedId }, snapshot)
        )
    } catch {
      // A cache that cannot be read is a cache that is not used. The gateway is
      // the source of truth either way.
    }
  }

  /**
   * History rows for a chat.
   *
   * `session.history` is unpaginated, so a chat with thousands of rows is a
   * multi-megabyte download on every open. Past the threshold the REST
   * transcript's newest 200 rows are enough to render, and a gateway without
   * that endpoint falls back to the RPC.
   */
  private async loadHistory(
    runtimeId: string,
    resolvedId: string,
    profile: string,
    messageCount: number
  ): Promise<{ rows: TranscriptRow[]; shape: RowShape }> {
    if (messageCount > REST_HISTORY_THRESHOLD) {
      const rows = await this.gateway.fetchMessages(resolvedId, { limit: REST_HISTORY_LIMIT, order: 'latest' })

      if (rows) {
        return { rows, shape: 'rest' }
      }
    }

    const result = await this.gateway.request('session.history', { session_id: runtimeId, profile })

    return { rows: (result?.messages ?? []) as TranscriptRow[], shape: 'rpc' }
  }

  /**
   * Fold in the events that landed since our watermark.
   *
   * A cold chat has no watermark, and asking for everything since zero would
   * replay a turn the history read already contains. So a cold hydration adopts
   * `latest_seq` without applying the events; a warm one (a cached chat, a
   * reconnect) applies them. A `truncated` reply or a changed epoch means the
   * ring no longer reaches back far enough and only a full re-hydration is
   * honest. During a hydration the caller has just done one; after a reconnect
   * the answer is `'gap'` and the caller reads the chat again (`refetch`). So is
   * a cold watermark against a session that has numbered events since: the chat
   * came back on a session it never saw an event of (a rebuild), and what ran
   * there while the socket was down is in no replay.
   */
  private async replaySince(botName: string, runtimeId: string): Promise<'applied' | 'gap' | 'none'> {
    const chat = this.chats.getState().chats[botName]

    if (!chat) {
      return 'none'
    }

    const knownEpoch = chat.epoch
    const askedAt = this.monotonic()
    let result

    try {
      result = await this.gateway.request('session.events.since', {
        session_id: runtimeId,
        last_seen: chat.lastSeq
      })
    } catch {
      // The replay is an optimisation over the history read that just ran; a
      // failure costs the events of the last few seconds, which the socket
      // delivers anyway.
      return 'none'
    }

    if (!result) {
      return 'none'
    }

    // The epoch identifies the gateway process that did the numbering. A
    // different one restarted under us and began counting at 1 again, so every
    // seq we hold describes a different sequence and the ring's contents cannot
    // be lined up against them.
    const epochChanged = knownEpoch !== undefined && knownEpoch !== result.epoch
    const cold = chat.lastSeq === 0 || epochChanged
    const gap =
      result.truncated === true || epochChanged || (chat.lastSeq === 0 && (Number(result.latest_seq) || 0) > 0)

    if (cold || result.truncated) {
      // Adopt the watermark without replaying: history already describes this.
      // A turn the cache restored mid-stream (`CachedTurn`) is continued only
      // by the frames a replay brings, so with none coming its pointers go, as
      // they did before the cache kept them — unless a resume has just said the
      // turn still runs, which is then the live turn's own state.
      this.chats.getState().update(botName, state => ({
        ...state,
        lastSeq: epochChanged ? result.latest_seq : Math.max(state.lastSeq, result.latest_seq),
        lastSeqSessionId: runtimeId,
        epoch: result.epoch,
        ...(state.turn.id !== undefined && !state.turn.active
          ? { turn: { ...state.turn, id: undefined, assistantId: undefined, reasoningId: undefined } }
          : {})
      }))
    } else {
      for (const raw of Array.isArray(result.events) ? result.events : []) {
        const event = transcriptEventOf(raw)

        if (event) {
          this.signalChatEvent(botName, event)
          this.chats.getState().dispatchEvent(botName, event)

          // The requests answered beside the engine hear the live socket only: a withdrawal they missed
          // while it was down reaches them here.
          if (event.type === 'request.cancel') {
            const payload = (event.payload ?? {}) as { id?: unknown; reason?: unknown }

            if (typeof payload.id === 'string' && payload.id) {
              this.signalReplay({
                kind: 'cancel',
                id: payload.id,
                reason: typeof payload.reason === 'string' ? payload.reason : ''
              })
            }
          }
        }
      }

      this.chats
        .getState()
        .update(botName, state => (state.epoch === result.epoch ? state : { ...state, epoch: result.epoch }))
    }

    this.registerOpenRequests(botName, result.open_requests ?? null, runtimeId, askedAt)

    return gap ? 'gap' : 'applied'
  }

  /**
   * A replay this controller did not ask for could not vouch for itself: the
   * connection's own replay after a reconnect (`@hermie/gateway-client` runs it
   * for every session it holds a watermark for, before the chats recover)
   * answered `truncated: true` for `runtimeSessionId` (`platform/socket.ts`,
   * `ReplayGapTap`). The events it carried were applied, and the ones the ring
   * had already dropped are in no frame, so the chat on that session is read
   * again in full (`refetch`): at once when the socket is up and nothing is
   * recovering the chat, otherwise by the recovery, after its resume.
   *
   * A chat that is being hydrated is left alone: its history read is that answer.
   */
  noteReplayGap(runtimeSessionId: string): void {
    if (this.detached || !runtimeSessionId) {
      return
    }

    const key = this.chats.getState().runtimeToBot[runtimeSessionId]
    const chat = key === undefined ? undefined : this.chats.getState().chats[key]

    if (key === undefined || !chat || chat.hydration === 'hydrating') {
      return
    }

    if (!this.connected || this.recovering.has(key)) {
      this.gapped.add(key)

      return
    }

    void this.refetch(key).catch(() => undefined)
  }

  /**
   * Read a chat again in full, as a hydration does, and reconcile what comes
   * back onto what is there: ids kept, the not-yet-persisted tail and open
   * requests kept, nothing doubled (`reconcile`). For a replay that could not
   * vouch for itself. The queue and the draft are not touched. One read per chat
   * at a time; a second reason to read it joins the first.
   *
   * `messageCount` is the session's own count when a resume just gave one; it
   * only decides which transport reads the history, as on the first open.
   */
  private refetch(key: string, messageCount?: number): Promise<void> {
    const existing = this.refetching.get(key)

    if (existing) {
      return existing
    }

    const run = this.readAgain(key, messageCount).finally(() => {
      this.refetching.delete(key)
    })

    this.refetching.set(key, run)

    return run
  }

  private async readAgain(key: string, messageCount?: number): Promise<void> {
    const chat = this.chats.getState().chats[key]
    const runtimeId = chat?.runtimeSessionId

    if (!chat || !runtimeId) {
      return
    }

    const window = this.windows.get(key)
    // A chat that was paged over REST holds a window of a longer conversation: read it the same way again.
    const count =
      messageCount ?? (window && !window.reachedStart ? REST_HISTORY_THRESHOLD + 1 : countPersistedRows(chat))
    const history = await this.loadHistory(runtimeId, chat.resolvedSessionId, botOfConversationKey(key), count)

    // Rebound meanwhile (a rebuild, a switch): this read describes nothing the chat holds now. And an empty
    // answer is no reason to empty a chat that holds rows (a hydration applies nothing for one either).
    if (this.chats.getState().chats[key]?.runtimeSessionId !== runtimeId || history.rows.length === 0) {
      return
    }

    this.chats.getState().applyHistory(key, rowsToItems(history.rows, history.shape))
    this.windows.set(key, {
      rows: history.rows.length,
      reachedStart: history.shape === 'rpc' || history.rows.length < REST_HISTORY_LIMIT
    })

    void this.persist(key)
  }

  /**
   * Rebuild the cards for requests the agent is still waiting on.
   *
   * These arrive without a live JSON-RPC handle, so answering one goes out as
   * `approval.respond` / `clarify.lock` rather than as a reply to the request.
   *
   * The list itself, when the gateway sent one, is also what the requests answered
   * beside the engine reconcile against (`ReplaySignal`).
   */
  private registerOpenRequests(
    botName: string,
    entries: OpenRequestEntry[] | null,
    runtimeId?: string,
    askedAt?: number
  ): void {
    if (Array.isArray(entries) && runtimeId && askedAt !== undefined) {
      this.signalReplay({
        kind: 'open_requests',
        sessionId: runtimeId,
        ids: entries.flatMap(entry => (typeof entry?.id === 'string' ? [entry.id] : [])),
        askedAt
      })
    }

    for (const entry of Array.isArray(entries) ? entries : []) {
      if (typeof entry?.id !== 'string' || typeof entry.method !== 'string') {
        continue
      }

      this.chats.getState().dispatchServerRequest(botName, {
        ...forEngine(entry),
        replayed: true
      })
    }
  }

  // ── events ─────────────────────────────────────────────────────────────────

  private onEvent(event: TranscriptEvent): void {
    if (event.type === 'sessions.changed') {
      this.scheduleSessionsChanged()

      return
    }

    if (event.type === 'cron.changed') {
      // The routines feature owns this one; nothing in a transcript changes.
      return
    }

    const sessionId = event.session_id
    const bound = sessionId ? this.chats.getState().runtimeToBot[sessionId] : undefined

    // The gateway's notices belong to no chat's order: handed over whoever carried them, and
    // still applied below when a bound chat did (the engine only moves its watermark).
    if (event.type === 'notification.show' || event.type === 'notification.clear') {
      const chat = bound === undefined ? undefined : this.chats.getState().chats[bound]
      const fresh = typeof event.seq !== 'number' || !chat || event.seq > chat.lastSeq

      if (fresh) {
        this.signal(
          event.type === 'notification.show'
            ? { kind: 'notice.show', chat: bound, payload: recordOf(event.payload) }
            : { kind: 'notice.clear', payload: recordOf(event.payload) }
        )
      }
    }

    if (!sessionId) {
      return
    }

    const botName = bound

    if (!botName) {
      return
    }

    this.signalChatEvent(botName, event)

    if (event.type === 'session.info') {
      this.rememberContract(contractIn(event.payload as SessionLiveInfo | undefined))
    }

    if (event.type === 'session.reclaimed') {
      // Another client took the session over. The transcript is still true; the
      // attachment is not. Keep the items, drop the id, re-resume on next focus.
      this.chats.getState().dispatchEvent(botName, event)
      this.chats.getState().dropRuntime(botName)
      this.chats.getState().setHydration(botName, 'stale')

      return
    }

    this.chats.getState().dispatchEvent(botName, event)

    if (event.type === 'request.cancel' || event.type === 'message.complete' || event.type === 'error') {
      // A withdrawn question and a finished turn both close cards. The handles
      // behind them answer nothing from here on, and a chat left open for days
      // would otherwise keep every one it ever saw.
      this.pruneRequests(botName)
    }

    if (event.type === 'message.start' || event.type === 'message.complete') {
      this.syncApprovalPoll()
      this.syncSubagentPoll()
    }

    if (event.type.startsWith('subagent.')) {
      this.syncSubagentPoll()
    }

    if (event.type === 'message.complete') {
      const chat = this.chats.getState().chats[botName]

      if (chat?.turn.foreignReconcilePending) {
        void this.reconcileTailFor(botName)
      }

      void this.persist(botName)
      void this.drainQueue(botName)
    }
  }

  private scheduleSessionsChanged(): void {
    this.clearSessionsChangedTimer()
    this.sessionsChangedTimer = setTimeout(() => {
      this.sessionsChangedTimer = undefined
      void this.sweep()
    }, SESSIONS_CHANGED_DEBOUNCE_MS)
  }

  private clearSessionsChangedTimer(): void {
    if (this.sessionsChangedTimer !== undefined) {
      clearTimeout(this.sessionsChangedTimer)
      this.sessionsChangedTimer = undefined
    }
  }

  /**
   * One `sessions.changed` sweep: refresh the roster, and tail-reconcile every
   * live chat that is not mid-turn. A chat that IS mid-turn is receiving the
   * truth on the socket already, and a tail fetch racing it would fight the
   * bubble being streamed.
   *
   * With one exception, and it is the whole of "a message I sent on my phone is
   * missing on my Mac". `message.start` carries no author, so a turn somebody
   * else began stands an empty `unknownAuthor` bubble in and waits to be told who
   * spoke. Nothing on the socket ever tells us: the deltas are the REPLY. The
   * only frame that filled it was `message.complete`, so until the turn ended —
   * seconds for a greeting, minutes for real work — the other device's message
   * simply was not in the transcript, and `selectors.ts` hides an empty
   * placeholder rather than drawing a blank bubble, so there was not even a gap
   * to explain it.
   *
   * A pending placeholder therefore outranks the mid-turn rule. The risk that
   * rule guards against does not apply to it: `reconcileTail` splices rows in
   * FRONT of the live tail and never drops a live item, so the worst case is the
   * prompt landing above the bubble that is still streaming — which is where it
   * belongs. And the gateway has already written that row; it is what
   * `sessions.changed` is announcing.
   */
  private async sweep(): Promise<void> {
    const names = liveChatNames(this.chats.getState())

    await Promise.all([
      this.botsController.refresh().catch(() => undefined),
      ...names.map(name => {
        const chat = this.chats.getState().chats[name]

        if (!chat) {
          return Promise.resolve()
        }

        return !chat.turn.active || chat.turn.foreignReconcilePending ? this.reconcileTailFor(name) : Promise.resolve()
      })
    ])

    // Something about the profile's sessions changed — a chat created, renamed
    // or deleted on another device among them — so every open list re-lists.
    for (const botName of [...this.conversationListeners.keys()]) {
      this.notifyConversations(botName)
    }
  }

  /**
   * One page further back.
   *
   * The transcript used to be a tail that reconciles and nothing else: there was
   * no scrollback, `onEndReached` was a no-op, and the one thing that could load
   * more re-read the SAME conversation at the route's maximum window and folded
   * it in with `applyHistory`. That is a bigger tail, not a page — it can be
   * done once, it stops at 500 rows for good, and a conversation longer than
   * that had a floor nobody could get under.
   *
   * This is paging. `offset` counts rows back from the newest end, so the next
   * page is the one before everything held, and it goes in at the FRONT through
   * `prependHistory` rather than through a re-hydration. Nothing already on
   * screen is rebuilt from the server's version of it, which is what keeps the
   * reader's place: `maintainVisibleContentPosition` holds an anchor through a
   * prepend on an inverted list, and it can only do that if the rows below the
   * anchor are the same rows.
   *
   * The answer is three-valued on purpose. A caller that cannot tell "there is
   * nothing older" from "loaded, still not what you wanted" from "this gateway
   * cannot do this" has nothing honest to say to the reader, and all three of
   * those happen.
   *
   * A gateway with no REST transcript answers `unavailable`, and that is not a
   * failure: the RPC fallback is unpaginated, so it already handed over
   * everything there is, and `reachedStart` was set at hydration.
   */
  async loadOlder(botName: string): Promise<'grew' | 'start' | 'unavailable'> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.resolvedSessionId) {
      return 'unavailable'
    }

    const window = this.windows.get(botName)

    if (window?.reachedStart) {
      return 'start'
    }

    if (this.loadingOlder.has(botName)) {
      // The list fires `onEndReached` more than once while one page is in the
      // air, and two pages fetched at the same offset are the same page twice.
      return 'grew'
    }

    this.loadingOlder.add(botName)

    try {
      const rows = await this.gateway.fetchMessages(chat.resolvedSessionId, {
        limit: REST_HISTORY_LIMIT,
        offset: window?.rows ?? chat.order.length,
        order: 'latest'
      })

      // A page of the conversation that was left: its rows, and its window, belong to nobody on screen now.
      if (!this.holdsConversation(botName, chat.storedSessionId)) {
        return 'unavailable'
      }

      if (rows === null) {
        this.windows.set(botName, { rows: window?.rows ?? 0, reachedStart: true })

        return 'unavailable'
      }

      const loaded = (window?.rows ?? 0) + rows.length

      /*
        A short page is the start. The route has no `has_more` and no total — the
        envelope carries `limit`, `offset`, `order` and `returned` and nothing
        else — so "it gave me fewer than I asked for" is the only signal there
        is, and an empty page past the end is what it answers rather than an
        error. Measured, 2026-09-21.
      */
      this.windows.set(botName, { rows: loaded, reachedStart: rows.length < REST_HISTORY_LIMIT })

      if (!rows.length) {
        return 'start'
      }

      const before = this.chats.getState().chats[botName]?.order.length ?? 0

      this.chats.getState().prependHistory(botName, rowsToItems(rows, 'rest'))

      const after = this.chats.getState().chats[botName]?.order.length ?? 0

      // A page that was entirely rows we already hold is not growth. It happens
      // when a turn lands between two pages and shifts every older row by one.
      return after > before ? 'grew' : rows.length < REST_HISTORY_LIMIT ? 'start' : 'grew'
    } finally {
      this.loadingOlder.delete(botName)
    }
  }

  /**
   * Whether this key still holds the conversation a read began on.
   *
   * A read of rows (the tail a `sessions.changed` sweep fetches, an older page, the Activity prefetch) names its
   * conversation when it starts and lands on the KEY when it ends. A switch between the two (`switchTo`,
   * `switchCanonical`) forgets the chat and opens another under the same key, so rows that came back for the
   * conversation just left would be spliced into the one now on screen, which then shows both. The sweep fires half
   * a second after a reply, so a reader who changes chat in that half second meets exactly this.
   */
  holdsConversation(botName: string, storedSessionId: string): boolean {
    return this.chats.getState().chats[botName]?.storedSessionId === storedSessionId
  }

  /** Fetch the newest rows and fold them in: fills foreign placeholders, joins DM replies. */
  async reconcileTailFor(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat) {
      return
    }

    const conversation = chat.storedSessionId

    let rows = await this.gateway.fetchMessages(chat.resolvedSessionId, {
      limit: TAIL_ROW_LIMIT,
      order: 'latest'
    })

    if (rows === null) {
      if (!chat.runtimeSessionId) {
        return
      }

      try {
        const result = await this.gateway.request('session.history', {
          session_id: chat.runtimeSessionId,
          profile: botName
        })

        rows = ((result?.messages ?? []) as TranscriptRow[]).slice(-TAIL_ROW_LIMIT)
      } catch {
        return
      }
    }

    // Read for the conversation the key held when this began, not for whichever it holds now.
    if (!rows.length || !this.holdsConversation(botName, conversation)) {
      return
    }

    this.chats.getState().applyTail(botName, rowsToItems(rows, 'rest'))
  }

  // ── connection status ──────────────────────────────────────────────────────

  private onStatus(status: ConnectionStatus): void {
    this.connected = status === 'ready'

    if (status !== 'ready') {
      if (status === 'disconnected' || status === 'reconnecting' || status === 'paused' || status === 'offline') {
        this.stopApprovalPoll()
        this.stopSubagentPoll()
      }

      return
    }

    if (!this.sawReady) {
      // The first ready of the process is not a reconnect; nothing is live yet.
      this.sawReady = true

      return
    }

    void this.recoverAfterReconnect()
  }

  /**
   * Come back from a dropped socket.
   *
   * Two things can have happened while we were away: the session was rebuilt
   * (so the runtime id changed and every subscription is addressed at a dead
   * id), and rows were written we never saw. The first is fixed by re-resuming
   * every live chat; the second by comparing the roster's message counts with
   * what each chat holds and re-reading history only where they disagree.
   *
   * Unless the replay cannot vouch for itself: when this recovery's replay
   * answers `truncated`, another epoch or a cold watermark against numbered
   * events, or the connection's own replay reported a gap for the chat
   * (`noteReplayGap`), the chat is read again in full instead (`refetch`),
   * after its resume, so the in-flight turn and the open requests are there to
   * be kept.
   */
  private async recoverAfterReconnect(): Promise<void> {
    const names = liveChatNames(this.chats.getState())

    if (!names.length) {
      return
    }

    // Before the first `await`: a gap the connection reports from here on waits for this recovery.
    for (const name of names) {
      this.recovering.add(name)
    }

    const bots = await this.botsController.refresh().catch(() => [] as Bot[])
    const byName = new Map(bots.map(bot => [bot.name, bot]))

    await Promise.all(
      names.map(async name => {
        const chat = this.chats.getState().chats[name]

        if (!chat) {
          this.recovering.delete(name)

          return
        }

        try {
          const resumeAskedAt = this.monotonic()
          const resume = await this.gateway.request('session.resume', {
            session_id: chat.storedSessionId,
            profile: name,
            omit_messages: true,
            source: 'hermie',
            cols: RESUME_COLS
          })

          if (typeof resume.session_id !== 'string' || !resume.session_id) {
            throw new Error(`The gateway resumed ${name}'s chat without a session id.`)
          }

          this.bindRuntime(name, resume.session_id)
          this.chats.getState().applySnapshot(name, resumeSnapshotOf(resume))
          this.registerOpenRequests(name, resume.open_requests ?? null, resume.session_id, resumeAskedAt)
          this.signalResumed(name, resume.session_id, resume)

          const replay = await this.replaySince(name, resume.session_id)

          const bot = byName.get(name)
          // The conversation the key is on: an own chat has its own count.
          const expected =
            (bot?.current && bot.current.id === chat.storedSessionId
              ? bot.current.messageCount
              : bot?.canonical?.messageCount) ?? 0

          if (replay === 'gap' || this.gapped.has(name)) {
            this.gapped.delete(name)
            await this.refetch(name, typeof resume.message_count === 'number' ? resume.message_count : undefined)
          } else if (expected > countPersistedRows(chat)) {
            await this.reconcileTailFor(name)
          }

          this.chats.getState().setHydration(name, 'live')
        } catch {
          this.chats.getState().setHydration(name, 'stale')
        } finally {
          this.recovering.delete(name)

          // A gap reported after the check above: read it now, the socket is up.
          if (this.gapped.delete(name) && this.connected) {
            void this.refetch(name).catch(() => undefined)
          }
        }
      })
    )

    this.syncApprovalPoll()
  }

  // ── server→client requests ─────────────────────────────────────────────────

  private onServerRequest(request: GatewayServerRequest): boolean {
    if (request.method !== 'approval' && request.method !== 'clarify') {
      // Everything else is not the engine's to hold: what a person types for a
      // secret, a sudo password or a vault prompt, and what they fill in, pick or
      // edit for a form, a file or a draft, must never reach a store the chat
      // keeps, so the models beside the engine take those from the connection
      // (`core/passkey/model.ts`, `core/requests/interactive.ts`,
      // `core/requests/secure-input.ts`, in that order). What none of them takes
      // (a method nobody here knows) is answered -32601 by the channel, which
      // withdraws the request instead of parking the agent.
      return false
    }

    const sessionId = typeof request.params.session_id === 'string' ? request.params.session_id : ''
    const botName = sessionId ? this.chats.getState().runtimeToBot[sessionId] : undefined

    if (botName) {
      this.deliverServerRequest(botName, request)

      return true
    }

    return sessionId ? this.park(sessionId, request) : false
  }

  /** Hold a request until its session is bound. False means "we cannot take it". */
  private park(sessionId: string, request: GatewayServerRequest): boolean {
    const queue = this.parked.get(sessionId) ?? []

    if (queue.length >= MAX_PARKED_REQUESTS) {
      return false
    }

    queue.push(request)
    this.parked.set(sessionId, queue)

    return true
  }

  /** Bind a runtime id to a bot and hand over whatever was waiting on it. */
  private bindRuntime(botName: string, runtimeSessionId: string): void {
    const previous = this.chats.getState().chats[botName]?.runtimeSessionId

    if (previous && previous !== runtimeSessionId) {
      // The catalogue is a per-session fact and the old session is gone.
      this.slashCatalogs.delete(previous)
      this.parked.delete(previous)
    }

    this.chats.getState().bindRuntime(botName, runtimeSessionId)

    const waiting = this.parked.get(runtimeSessionId)

    if (!waiting?.length) {
      return
    }

    this.parked.delete(runtimeSessionId)

    for (const request of waiting) {
      this.deliverServerRequest(botName, request)
    }
  }

  /**
   * Put one request on screen and remember how to answer it.
   *
   * The reducer may fold this onto a card it already holds for the same
   * approval-queue entry — a replayed snapshot and the live request are one
   * question under two transport ids. When it does, the live reply handle is
   * filed under the card's id, so answering what the user can actually see
   * still resolves the request the agent is waiting on.
   */
  private deliverServerRequest(botName: string, request: GatewayServerRequest): void {
    this.chats.getState().dispatchServerRequest(botName, {
      id: request.id,
      method: request.method,
      params: request.params,
      ...(request.replayed ? { replayed: true } : {})
    })

    const chat = this.chats.getState().chats[botName]
    const cardId = chat?.byRequestId[request.id]
      ? request.id
      : approvalCardIdFor(chat, typeof request.params.request_id === 'string' ? request.params.request_id : '')

    if (cardId) {
      this.pending.set(cardId, { botName, request })

      if (request.method === 'approval') {
        void this.acknowledgeApproval(botName, cardId)
      }
    }

    this.syncApprovalPoll()
  }

  /**
   * Forget the bookkeeping behind cards that are no longer open.
   *
   * `pending` holds a JSON-RPC reply handle and `acknowledged` a request id;
   * neither means anything once the card has been answered, cancelled or
   * withdrawn, and a chat that stays live for a working day accumulates both.
   */
  private pruneRequests(botName: string): void {
    const chat = this.chats.getState().chats[botName]

    if (!chat) {
      return
    }

    const stillOpen = (requestId: string): boolean => {
      const itemId = chat.byRequestId[requestId]
      const item = itemId ? chat.items[itemId] : undefined

      return (item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'open'
    }

    for (const [requestId, entry] of this.pending) {
      if (entry.botName === botName && !stillOpen(requestId)) {
        this.pending.delete(requestId)
      }
    }

    for (const requestId of this.acknowledged) {
      if (chat.byRequestId[requestId] && !stillOpen(requestId)) {
        this.acknowledged.delete(requestId)
      }
    }
  }

  /**
   * Tell the queue a human is looking at this approval.
   *
   * It is an acknowledgement, not an answer: the agent keeps waiting until a
   * choice comes back, but the queue stops counting the request down as
   * unseen. Sent once per request — a card that arrives on the socket is
   * acknowledged on arrival, and one rebuilt from a resume snapshot or from
   * the pending poll is acknowledged when the sheet first shows it, so the
   * screen may call this freely.
   */
  async acknowledgeApproval(botName: string, requestId: string): Promise<void> {
    if (this.acknowledged.has(requestId)) {
      return
    }

    const chat = this.chats.getState().chats[botName]
    const sessionId = chat?.runtimeSessionId

    if (!sessionId) {
      return
    }

    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    const approvalId = item?.kind === 'approval' && item.approvalId ? item.approvalId : requestId

    this.acknowledged.add(requestId)

    try {
      await this.gateway.request('approval.received', { session_id: sessionId, request_id: approvalId })
    } catch {
      // The ack is a courtesy to the queue's timeout, never a precondition for
      // answering; a failed one must not keep the sheet off the screen.
    }
  }

  /**
   * What the GATEWAY says is still open for this bot, right now.
   *
   * Read straight off `approval.pending` rather than out of the store, and that
   * is the whole point of it: its one caller is ADR-0017's notification action,
   * where nothing the device already believes counts as evidence. A tap on
   * "Allow" is a hint that something happened, so the request it names is looked
   * up again here before anything is sent.
   *
   * Answers `[]` for a chat with no live session and for a call that failed,
   * which both resolve to "open the chat and let the reader see".
   */
  async openApprovals(botName: string): Promise<PendingApproval[]> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return []
    }

    try {
      const result = await this.gateway.request('approval.pending', {
        session_id: chat.runtimeSessionId,
        profile: botName
      })

      return Array.isArray(result?.approvals) ? result.approvals : []
    } catch {
      return []
    }
  }

  /**
   * Answer an approval.
   *
   * A request is answered on its own JSON-RPC reply, which is what the queue is
   * waiting on. That includes one replayed out of `open_requests`: the channel
   * re-delivers it over the socket that owns it, so its reply frame is as live
   * as any other.
   *
   * What has no frame is a card synthesized from the `pending_approval` resume
   * field or from the `approval.pending` poll — those are queue entries, never
   * transported requests. They go out as `approval.respond` against the queue
   * entry's own id instead.
   */
  async respondApproval(botName: string, requestId: string, choice: string, all = false): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    // A press that arrives after the request was withdrawn (or already answered)
    // answers nothing: no RPC, and the card keeps the state it has.
    const closed = closedRequest(item, requestId)

    if (closed) {
      throw closed
    }

    const approvalId = item?.kind === 'approval' ? item.approvalId : requestId
    const live = this.pending.get(requestId)
    const result = { choice, ...(all ? { all: true } : {}) }

    this.chats.getState().answer(botName, requestId, choice)
    this.acknowledged.delete(requestId)

    if (live) {
      this.pending.delete(requestId)
      live.request.respond(result)
    } else if (approvalId && chat?.runtimeSessionId) {
      await this.gateway.request('approval.respond', {
        session_id: chat.runtimeSessionId,
        profile: botName,
        choice,
        ...(all ? { all: true } : {}),
        request_id: approvalId
      })
    } else {
      // No queue id to address and no reply frame to make. `request.answer` is
      // the gateway's proxy for exactly that: it settles the open request by
      // its own id, with the result the reply frame would have carried.
      await this.gateway.request('request.answer', { id: requestId, result, profile: botName })
    }

    this.syncApprovalPoll()
  }

  /**
   * Answer one clarify question.
   *
   * A live request is answered on its own reply frame. A replayed one has no
   * frame to answer, and `clarify.lock` cannot stand in for every shape: the
   * gateway only accepts a lock for a BATCH clarify and reports `expired` for a
   * single-question one, which would leave the agent waiting on a question the
   * user has already answered. `request.answer` settles an open request by its
   * id and is the path for that case.
   */
  async respondClarify(botName: string, requestId: string, answers: Record<string, string>): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const item = itemId ? chat?.items[itemId] : undefined
    const closed = closedRequest(item, requestId)

    if (closed) {
      throw closed
    }

    const clarify = item?.kind === 'clarify' ? item : undefined
    const live = this.pending.get(requestId)

    this.chats.getState().answer(botName, requestId, answers)

    const complete = clarify ? clarify.questions.every(question => answers[question.qid] !== undefined) : true
    // The wire shape follows the question shape: a batch answers `answers` by
    // qid, a single question answers the bare `answer` the gateway reads.
    const result = clarify?.batch ? { answers } : { answer: Object.values(answers)[0] ?? '' }

    if (live && complete) {
      this.pending.delete(requestId)
      this.acknowledged.delete(requestId)
      live.request.respond(result)

      return
    }

    if (!live && (complete || !clarify?.batch)) {
      await this.gateway.request('request.answer', { id: requestId, result, profile: botName })

      return
    }

    // Checked once above; the request may turn `answered` between two of these
    // locks (the last one completes it), so they do not check again.
    for (const [qid, answer] of Object.entries(answers)) {
      await this.sendClarifyLock(botName, requestId, qid, answer)
    }
  }

  /**
   * End a clarify without answering it: the gateway's cancel-all, a reply with
   * neither `answer` nor `answers` (`ClarifyResult`). For a batch the bot is told
   * the reader declined, and answers locked earlier go with it; for a single
   * question it reads as a skip.
   *
   * The card closes as `cancelled` under `CANCELLED_BY_READER` rather than as
   * `answered`: nothing was answered, and the reason tells the request layer the
   * gateway withdrew nothing. It is closed before the reply goes out, as an
   * answer is, so a second press finds it closed.
   */
  async cancelClarify(botName: string, requestId: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const closed = closedRequest(itemId ? chat?.items[itemId] : undefined, requestId)

    if (closed) {
      throw closed
    }

    const live = this.pending.get(requestId)

    this.chats.getState().dispatchEvent(botName, {
      type: 'request.cancel',
      payload: { id: requestId, reason: CANCELLED_BY_READER }
    })

    if (live) {
      this.pending.delete(requestId)
      this.acknowledged.delete(requestId)
      live.request.respond({})

      return
    }

    await this.gateway.request('request.answer', { id: requestId, result: {}, profile: botName })
  }

  /** Lock one answer of a batch clarify without resolving the whole request. */
  async lockClarify(botName: string, requestId: string, questionId: string, answer: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]
    const itemId = chat?.byRequestId[requestId]
    const closed = closedRequest(itemId ? chat?.items[itemId] : undefined, requestId)

    if (closed) {
      throw closed
    }

    await this.sendClarifyLock(botName, requestId, questionId, answer)
  }

  private async sendClarifyLock(botName: string, requestId: string, questionId: string, answer: string): Promise<void> {
    this.chats.getState().answer(botName, requestId, { [questionId]: answer })

    await this.gateway.request('clarify.lock', {
      request_id: requestId,
      question_id: questionId,
      answer,
      profile: botName
    })
  }

  // ── sending ────────────────────────────────────────────────────────────────

  /**
   * Submit a prompt.
   *
   * The user's message is painted before the round trip and settled against
   * `prompt.submit`'s status afterwards — `queued` keeps it pending behind the
   * running turn, `steered` folds it into that turn, `streaming` starts a new
   * one. Images are attached first: they are queued onto the next turn, so the
   * order matters.
   *
   * A file attachment is not attached at all — there is no RPC for it. Its bytes
   * are already on the gateway (`uploadFile`), so all that is left is to name the
   * path in the prompt, which `withFileReferences` appends as the `@file:` token
   * the gateway expands. That composed text is what is painted AND what is
   * submitted: the two have to be byte-identical, or the gateway echoes the turn
   * back as a message the reconciler does not recognise and the bubble appears
   * twice.
   *
   * Byte-identical text is not enough when there is no text. An attachment sent
   * with nothing typed leaves the two sides with only the attachment in common,
   * so what is painted has to be the REFERENCE the row will carry rather than a
   * display name — see `attachmentReferences`.
   *
   * ## What it answers with
   *
   * The id of the item the prompt was PAINTED as, or `undefined` for a prompt
   * that was parked behind a running turn and therefore has no item yet. Every
   * caller on screen ignores it; the one that does not is the Shortcuts runner,
   * which needs a fixed point in the transcript to tell the reply to its own
   * prompt apart from the reply that was already there — see
   * `features/intents/await-reply.ts`.
   *
   * ## The turn claim
   *
   * This is also the ONLY road to `prompt.submit` — a slash command goes to
   * `slash.exec` from the screen directly and never reaches this method, and a
   * steer folds into a turn already running through `steerQueued` — so it is the
   * one place a claim belongs. When the plugin advertises `context.turn_claim`,
   * `claimTurn` is awaited right before the submit it is claiming, on the exact
   * runtime id that submit is about to carry; see `turn-claim.ts` for why it can
   * never fail the send that follows it.
   */
  async send(
    botName: string,
    text: string,
    attachments: AttachmentInput[] = [],
    options: { display?: string } = {}
  ): Promise<string | undefined> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      throw new Error(`${botName}'s chat is not attached to the gateway yet.`)
    }

    // A turn is running: the message is parked HERE rather than on the gateway.
    // See `QueuedMessage` — `prompt.submit` would take it, and would then be the
    // only one holding it, with nothing to read it back or take it out again.
    if (chat.turn.active) {
      this.queue(botName, text, attachments)

      return undefined
    }

    const sessionId = chat.runtimeSessionId
    /*
      Everything about WHICH conversation this turn belongs to is read now,
      before the first await. By the time the submit answers, the key may be on
      another conversation (a switch is refused while this is in flight, but the
      rule is kept here too): the relabel, the last-opened stamp and the turn's
      settling are then this conversation's business, not the one on screen.
    */
    const ownId = this.boundOwnId(botName)
    const stillHere = (): boolean => this.chats.getState().chats[botName]?.runtimeSessionId === sessionId
    const files = attachments.filter(isFileAttachment)
    const images = attachments.filter((attachment): attachment is ImageAttachmentInput => !isFileAttachment(attachment))
    const body = withFileReferences(
      text,
      files.map(file => file.path)
    )

    // `display` exists for one caller: a `send`/`skill` directive, whose `text`
    // is the expanded skill body the model is meant to read and NOT what the
    // reader typed. The bubble shows `/docx`; the gateway is sent the expansion.
    this.chats
      .getState()
      .beginTurn(botName, options.display ?? body, attachmentReferences(attachments), this.ownAuthor())

    // Read back rather than recomputed: `beginLocalTurn` mints the id, and a
    // second spelling of that rule here would be a second place for it to drift.
    const painted = this.chats.getState().chats[botName]?.order.at(-1)

    this.sending.set(botName, (this.sending.get(botName) ?? 0) + 1)

    try {
      for (const file of images) {
        await this.gateway.request('image.attach_bytes', {
          session_id: sessionId,
          profile: botName,
          content_base64: file.base64,
          filename: file.filename
        })
      }

      if (this.http && hasPluginCapability(this.plugin.getState().advert, PLUGIN_CAPABILITIES.contextTurnClaim)) {
        await claimTurn(this.http, sessionId)
      }

      const result = await this.gateway.request('prompt.submit', {
        session_id: sessionId,
        profile: botName,
        text: body
      })

      this.doneSending(botName)

      if (!stillHere()) {
        return painted
      }

      this.chats.getState().settleTurn(botName, { status: result?.status ?? null })
      this.syncApprovalPoll()

      if (ownId) {
        // Sent to, on this device: the list is most recently used first.
        this.bots.getState().markOpened(ownId, Math.floor(this.now() / 1000))

        // A skill directive's `text` is the expansion, not what the reader
        // typed, and is no name for a chat.
        if (options.display === undefined) {
          void onDemand
            .use(part => part.relabelFromFirstMessage(this, botName, ownId, sessionId, text))
            .catch(() => undefined)
        }
      }

      return painted
    } catch (error) {
      this.doneSending(botName)

      // The optimistic bubble stays — the text is the user's, not ours to throw
      // away — but the turn is not running, so the composer comes back. Only on
      // the conversation it was sent in.
      if (stillHere()) {
        this.chats.getState().interrupt(botName)
      }

      throw error
    }
  }

  /** One send under this key has had its answer (or its refusal) from the gateway. */
  private doneSending(botName: string): void {
    const left = (this.sending.get(botName) ?? 1) - 1

    if (left > 0) {
      this.sending.set(botName, left)
    } else {
      this.sending.delete(botName)
    }
  }

  /**
   * Refuse to move this bot's key while moving it would lose something: a send
   * that has not reached the gateway yet, a reply still running, or messages
   * (and their attachments) waiting in the queue. The reader is told why, with
   * `ConversationBusyError`, rather than finding their queue gone.
   */
  assertIdle(botName: string): void {
    const state = this.chats.getState()
    const chat = state.chats[botName]

    if (this.sending.has(botName) || chat?.turn.active || (state.queues[botName]?.length ?? 0) > 0) {
      throw new ConversationBusyError(botName)
    }
  }

  // ── the queue behind a running turn ────────────────────────────────────────

  /**
   * Park a message, and give the transcript a row for it.
   *
   * The attachments stay in this map and never reach the store: they are bytes
   * and paths, the store draws names. They leave together with the entry,
   * whichever way it leaves.
   */
  private queue(botName: string, text: string, attachments: AttachmentInput[]): void {
    const id = `q:${(this.queueSeq += 1)}`

    this.queuedAttachments.set(id, attachments)
    this.chats.getState().enqueue(botName, {
      id,
      text,
      ...(attachments.length ? { attachments: attachmentReferences(attachments) } : {})
    })
  }

  /** Every queued message for one bot, oldest first. */
  private queueOf(botName: string): QueuedMessage[] {
    return this.chats.getState().queues[botName] ?? []
  }

  private takeQueued(
    botName: string,
    id: string
  ): { entry: QueuedMessage; attachments: AttachmentInput[] } | undefined {
    const entry = this.queueOf(botName).find(candidate => candidate.id === id)

    if (!entry) {
      return undefined
    }

    const attachments = this.queuedAttachments.get(id) ?? []

    this.queuedAttachments.delete(id)
    this.chats.getState().dropQueued(botName, id)

    return { attachments, entry }
  }

  /**
   * The turn ended: submit the oldest parked message, if there is one.
   *
   * ONE per completion. The message it sends starts a turn of its own, and that
   * turn's completion comes back through here — so a queue of three goes out in
   * order, each one after the reply to the one before it, which is the order the
   * reader wrote them in and the only one that makes the replies readable.
   */
  private async drainQueue(botName: string): Promise<void> {
    const next = this.queueOf(botName)[0]

    if (!next) {
      return
    }

    const taken = this.takeQueued(botName, next.id)

    if (!taken) {
      return
    }

    try {
      await this.send(botName, taken.entry.text, taken.attachments)
    } catch {
      // The send painted its own failure — and putting the message back would
      // start a loop against a gateway that is refusing it.
    }
  }

  /** Take a parked message back for editing. Returns the text to put in the field. */
  editQueued(botName: string, id: string): string | undefined {
    return this.takeQueued(botName, id)?.entry.text
  }

  deleteQueued(botName: string, id: string): void {
    this.takeQueued(botName, id)
  }

  /**
   * Inject a parked message into the turn that is running, now.
   *
   * `session.steer` is the gateway's own word for it: the text is handed to the
   * agent with its next tool result, without interrupting anything. The answer
   * can be `rejected` — a turn past its final tool batch has nothing left to
   * hand it to — and then the message goes back into the queue rather than
   * disappearing into a turn that never heard it.
   *
   * The bubble is painted HERE, before the round trip, for the same reason
   * `send` paints one: taking the entry out of the queue is the only thing the
   * reader can see, and on its own it reads as the message being deleted. That
   * was the whole of the build-176 report — the strip dropped the chip and
   * nothing arrived.
   *
   * Whether the gateway persists a row for a steer is not something this client
   * can know: the contract says only "inject text into the next tool result",
   * and `display_kind: "steer"` exists in the row projection without any
   * promise that a steer produces one. So the bubble is local and optimistic,
   * and the tail reconcile pairs it with a persisted row on its text if one
   * ever turns up (`matchKeyOf`) rather than drawing the words twice.
   *
   * Refusal unwinds all of it: the bubble comes off and the entry goes back in
   * the strip, which is where the reader will go looking for it.
   */
  async steerQueued(botName: string, id: string): Promise<CorrectionStatus> {
    const sessionId = this.requireRuntime(botName)
    const taken = this.takeQueued(botName, id)

    if (!taken) {
      return 'rejected'
    }

    this.chats.getState().beginSteer(botName, taken.entry.text, taken.entry.attachments)

    try {
      const result = await this.gateway.request('session.steer', {
        session_id: sessionId,
        profile: botName,
        text: taken.entry.text
      })

      if (result?.status === 'rejected') {
        this.unwindSteer(botName, taken)
      }

      return result?.status ?? 'queued'
    } catch (error) {
      this.unwindSteer(botName, taken)

      throw error
    }
  }

  /** A steer the gateway did not take: un-paint it, and park it again. */
  private unwindSteer(botName: string, taken: { entry: QueuedMessage; attachments: AttachmentInput[] }): void {
    this.chats.getState().dropSteer(botName, taken.entry.text)
    this.requeue(botName, taken)
  }

  private requeue(botName: string, taken: { entry: QueuedMessage; attachments: AttachmentInput[] }): void {
    this.queuedAttachments.set(taken.entry.id, taken.attachments)
    this.chats.getState().enqueue(botName, taken.entry)
  }

  /** Put a file on the gateway, ready to be named in the next prompt. In `chat-controller-on-demand.ts`. */
  uploadFile(
    botName: string,
    file: UploadableFile,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
  ): Promise<UploadedFile> {
    return onDemand.use(part => part.uploadFile(this, botName, file, options))
  }

  /** Put a file on the gateway at a path the caller chose (an `input.file` request names its directory). In `chat-controller-on-demand.ts`. */
  uploadFileTo(
    path: string,
    file: UploadableFile,
    options: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {}
  ): Promise<UploadedFile> {
    return onDemand.use(part => part.uploadFileTo(this, path, file, options))
  }

  /** Stop the running turn. The partial reply is kept; it was really said. */
  async stopTurn(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return
    }

    try {
      await this.gateway.request('session.interrupt', { session_id: chat.runtimeSessionId, profile: botName })
    } finally {
      this.chats.getState().interrupt(botName)
      this.syncApprovalPoll()
    }
  }

  steerSubagent(botName: string, subagentId: string, text: string): Promise<string> {
    return onDemand.use(part => part.steerSubagent(this, botName, subagentId, text))
  }

  interruptSubagent(botName: string, subagentId: string): Promise<boolean> {
    return onDemand.use(part => part.interruptSubagent(this, botName, subagentId))
  }

  tailSubagent(botName: string, subagentId: string): Promise<string> {
    return onDemand.use(part => part.tailSubagent(this, botName, subagentId))
  }

  /** The child's OWN transcript, read the same way a chat is. In `chat-controller-on-demand.ts`. */
  childTranscript(botName: string, childSessionId: string): Promise<TranscriptItem[]> {
    return onDemand.use(part => part.childTranscript(this, botName, childSessionId))
  }

  /**
   * Fold the gateway's live-children roster into a chat.
   *
   * Cheap and idempotent: an empty roster is a no-op in the reducer, and a
   * child the events already described is refreshed rather than duplicated.
   */
  async reconcileSubagents(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return
    }

    try {
      const result = await this.gateway.request('subagent.list', {
        session_id: chat.runtimeSessionId,
        profile: botName
      })

      const rows = (result?.subagents ?? []) as SubagentSnapshotRow[]

      if (rows.length) {
        this.chats.getState().update(botName, state => applySubagentSnapshot(state, rows, this.now()))
      }
    } catch {
      // A gateway without `subagent.list` still streams `subagent.*`; the
      // roster is a recovery path, never the only one.
    }
  }

  /**
   * Poll `subagent.list` while anything is delegating.
   *
   * Reference-free and idempotent: it turns itself off the moment no live chat
   * has a running child or an active turn, so an idle app polls nothing.
   */
  private syncSubagentPoll(): void {
    const busy = liveChatNames(this.chats.getState()).some(name => {
      const chat = this.chats.getState().chats[name]

      if (!chat) {
        return false
      }

      return (
        chat.turn.active ||
        Object.values(chat.subagents).some(child => child.status === 'running' || child.status === 'queued')
      )
    })

    if (busy && this.foregrounded) {
      if (this.subagentPollTimer === undefined) {
        this.subagentPollTimer = setInterval(() => {
          for (const name of liveChatNames(this.chats.getState())) {
            void this.reconcileSubagents(name)
          }
        }, SUBAGENT_RECONCILE_MS)
      }

      return
    }

    this.stopSubagentPoll()
  }

  private stopSubagentPoll(): void {
    if (this.subagentPollTimer !== undefined) {
      clearInterval(this.subagentPollTimer)
      this.subagentPollTimer = undefined
    }
  }

  /** Load one bot's recent transcript WITHOUT attaching to its session. In `chat-controller-on-demand.ts`. */
  prefetchTail(bot: Bot, limit = ACTIVITY_TAIL_LIMIT): Promise<void> {
    return onDemand.use(part => part.prefetchTail(this, bot, limit))
  }

  /** The background load behind the Activity screen: every bot, in parallel. In `chat-controller-on-demand.ts`. */
  loadActivity(limit = ACTIVITY_TAIL_LIMIT): Promise<void> {
    return onDemand.use(part => part.loadActivity(this, limit))
  }

  /** How many sub-agents each bot has running right now (`delegation.status`). In `chat-controller-on-demand.ts`. */
  activeSubagentCount(): Promise<number> {
    return onDemand.use(part => part.activeSubagentCount(this))
  }

  /** Bot-to-bot deliveries still in flight. In `chat-controller-on-demand.ts`. */
  inFlightDeliveries(): Promise<number> {
    return onDemand.use(part => part.inFlightDeliveries(this))
  }

  /** Completions for what the user is typing. In `chat-controller-on-demand.ts`. */
  querySlash(botName: string, typed: string): Promise<SlashCompletions> {
    return onDemand.use(part => part.querySlash(this, botName, typed))
  }

  /**
   * Does this session have a command by that name?
   *
   * The catalogue answers it, and the answer decides what Return does with a
   * line that starts with a slash: a name the gateway knows is a COMMAND and
   * goes to the gateway, and anything else is prose that happens to begin with
   * `/` and goes out as an ordinary prompt. Names, aliases and skills all count
   * — they are all things the gateway will run, though not all down the same
   * road; see `slashRouteFor`.
   *
   * The three conversation-starting commands answer yes whatever the catalogue
   * says, INCLUDING before it has arrived. Every other command degrades
   * harmlessly when the catalogue is late — the line goes out as a prompt, and
   * the gateway understands a leading slash — but `/new` does not: sent as a
   * prompt it becomes a message asking the MODEL to start a new session, which
   * is the one shape of this bug worse than the bug itself.
   */
  knowsSlashCommand(botName: string, name: string): boolean {
    return this.slashRouteFor(botName, name) !== null
  }

  /**
   * WHICH gateway method will accept this command.
   *
   * `slash.exec` runs worker commands. It refuses a SKILL outright —
   * `4018 skill command: use command.dispatch for /docx`, measured against
   * `hermes serve` 0.21.3 on 2026-09-21 — and a real gateway's catalogue lists
   * fifty-three of them next to the built-ins, every one of which
   * `knowsSlashCommand` used to wave straight into the method that will not take
   * it. The fake gateway answered `/docx` with cheerful text, which is exactly
   * how a suite stays green over a command that cannot work.
   */
  slashRouteFor(botName: string, name: string): SlashRoute | null {
    const wanted = name.toLowerCase()

    // Before the catalogue, and regardless of what it says: this client owns
    // these three, and it owns them whether or not the gateway lists them.
    if (NEW_CONVERSATION_COMMANDS.has(wanted)) {
      return 'local'
    }

    const catalog = this.slashCatalog(botName)

    if (!catalog || !name) {
      return null
    }

    const named = (raw: string) => raw.replace(/^\//u, '').toLowerCase() === wanted

    if (Object.keys(catalog.skills ?? {}).some(named)) {
      return 'dispatch'
    }

    const known =
      Object.keys(catalog.commands ?? {}).some(named) ||
      Object.keys(catalog.canon ?? {}).some(named) ||
      (catalog.pairs ?? []).some(pair => named(pair[0] ?? '')) ||
      (catalog.categories ?? []).some(category => (category.pairs ?? []).some(pair => named(pair[0] ?? '')))

    return known ? 'exec' : wanted === STATUS_COMMAND ? 'local' : null
  }

  /** The catalogue behind `querySlash`, for a picker that wants the whole list. */
  slashCatalog(botName: string): CommandsCatalogResult | undefined {
    const chat = this.chats.getState().chats[botName]

    return chat?.runtimeSessionId ? this.slashCatalogs.get(chat.runtimeSessionId) : undefined
  }

  /** Run a slash command and put its answer in the transcript. In `chat-controller-on-demand.ts`. */
  runSlash(botName: string, command: string): Promise<SlashOutcome> {
    return onDemand.use(part => part.runSlash(this, botName, command))
  }

  /** Put this conversation away and start the next one, in place. In `chat-controller-on-demand.ts`. */
  startNewConversation(botName: string, arg = '', command = '/new'): Promise<void> {
    return onDemand.use(part => part.startNewConversation(this, botName, arg, command))
  }

  /** Move this bot between the shared Bot Chat and the reader's own. In `chat-controller-on-demand.ts`. */
  chooseChat(bot: Bot, choice: ChatChoice): Promise<void> {
    return onDemand.use(part => part.chooseChat(this, bot, choice))
  }

  /** A bot's conversations as the list draws them: the group chat, then the reader's own chats. In `chat-controller-on-demand.ts`. */
  listBotConversations(bot: Bot | string): Promise<ConversationList> {
    return onDemand.use(part => part.listBotConversations(this, bot))
  }

  /**
   * Hear that a bot's conversation list may have changed — after a
   * `sessions.changed` sweep, and after every action this controller takes on
   * that list. The listener re-lists; nothing here polls.
   */
  onConversationsChanged(botName: string, listener: () => void): () => void {
    const listeners = this.conversationListeners.get(botName) ?? new Set<() => void>()

    listeners.add(listener)
    this.conversationListeners.set(botName, listeners)

    return () => {
      listeners.delete(listener)

      if (!listeners.size && this.conversationListeners.get(botName) === listeners) {
        this.conversationListeners.delete(botName)
      }
    }
  }

  notifyConversations(botName: string): void {
    for (const listener of [...(this.conversationListeners.get(botName) ?? [])]) {
      try {
        listener()
      } catch {
        // One broken surface does not stop the others hearing.
      }
    }
  }

  /** Put this bot's key on one of its conversations: an own chat, or the group chat with `null`. In `chat-controller-on-demand.ts`. */
  selectConversation(bot: Bot, target: Conversation | null): Promise<void> {
    return onDemand.use(part => part.selectConversation(this, bot, target))
  }

  /**
   * Repoint this bot's key at another conversation and open it.
   *
   * Everything keyed by the old session is dropped and the ordinary open path
   * runs, as `switchCanonical` does — with two differences that are the point
   * of sub-chats. The roster's `current` moves and its `canonical` does not, so
   * the group chat keeps its unread badge while the reader is elsewhere. And
   * nothing is forgotten on disk: the conversation being left is written to its
   * OWN cache key first, so coming back to it paints at once.
   */
  async switchTo(bot: Bot, own: BotCanonicalSession | null): Promise<void> {
    const botName = bot.name
    const chat = this.chats.getState().chats[botName]

    if (chat) {
      this.markLeft(botName)
      await this.persist(botName)
      // A send may have started while the cache was written. Nothing is unbound
      // yet, so refusing here loses nothing.
      this.assertIdle(botName)

      if (chat.runtimeSessionId) {
        this.slashCatalogs.delete(chat.runtimeSessionId)
        this.slashCatalogLoads.delete(chat.runtimeSessionId)
        this.parked.delete(chat.runtimeSessionId)
      }

      for (const entry of this.chats.getState().queues[botName] ?? []) {
        this.queuedAttachments.delete(entry.id)
      }

      for (const [requestId, entry] of this.pending) {
        if (entry.botName === botName) {
          this.pending.delete(requestId)
        }
      }

      this.windows.delete(botName)
      this.loadingOlder.delete(botName)
      this.chats.getState().forget(botName)
    }

    this.bots.getState().setCurrent(botName, own)

    await this.hydrate(botOn(this.bots.getState().byName[botName] ?? bot, own))
    this.syncApprovalPoll()
  }

  /** Start another of the reader's own chats on this bot and open it. In `chat-controller-on-demand.ts`. */
  startOwnChat(bot: Bot, options: { label?: string } = {}): Promise<Conversation> {
    return onDemand.use(part => part.startOwnChat(this, bot, options))
  }

  /** Rename one of the reader's own chats (the label only). In `chat-controller-on-demand.ts`. */
  renameOwnChat(bot: Bot, storedId: string, label: string): Promise<string> {
    return onDemand.use(part => part.renameOwnChat(this, bot, storedId, label))
  }

  /** Delete one of the reader's own chats. In `chat-controller-on-demand.ts`. */
  deleteOwnChat(bot: Bot, storedId: string): Promise<void> {
    return onDemand.use(part => part.deleteOwnChat(this, bot, storedId))
  }

  /** Where a push tap or a link naming one session of this bot should land. In `chat-controller-on-demand.ts`. */
  openSession(bot: Bot, storedId: string): Promise<{ kind: 'current' } | { kind: 'viewer' }> {
    return onDemand.use(part => part.openSession(this, bot, storedId))
  }

  /** Fork this chat into a branch, from one row of its transcript. In `chat-controller-on-demand.ts`. */
  branchFrom(botName: string, options: { messageCount: number; title: string }): Promise<Conversation> {
    return onDemand.use(part => part.branchFrom(this, botName, options))
  }

  /** Every conversation this profile has, grouped. In `chat-controller-on-demand.ts`. */
  listConversations(botName: string): Promise<ConversationGroups> {
    return onDemand.use(part => part.listConversations(this, botName))
  }

  /** Rename one conversation that is not the canonical chat. In `chat-controller-on-demand.ts`. */
  renameConversation(botName: string, storedId: string, title: string): Promise<string> {
    return onDemand.use(part => part.renameConversation(this, botName, storedId, title))
  }

  /** Delete one conversation. In `chat-controller-on-demand.ts`. */
  deleteConversation(botName: string, storedId: string): Promise<void> {
    return onDemand.use(part => part.deleteConversation(this, botName, storedId))
  }

  /** Make one of the past conversations this bot's Bot Chat again. In `chat-controller-on-demand.ts`. */
  adoptAsCanonical(botName: string, storedId: string): Promise<void> {
    return onDemand.use(part => part.adoptAsCanonical(this, botName, storedId))
  }

  /** `session.status`: the gateway's report on this chat's live session, as plain text. In `chat-controller-on-demand.ts`. */
  sessionStatus(botName: string): Promise<string> {
    return onDemand.use(part => part.sessionStatus(this, botName))
  }

  /** Set one of the chat's runtime options. In `chat-controller-on-demand.ts`. */
  setOption(
    botName: string,
    key: ChatOptionKey,
    value: string,
    options: { confirmExpensiveModel?: boolean } = {}
  ): Promise<SetOptionResult> {
    return onDemand.use(part => part.setOption(this, botName, key, value, options))
  }

  /** The gateway's model catalogue, flattened to `provider/model` ids. In `chat-controller-on-demand.ts`. */
  modelOptions(): Promise<ModelChoice[]> {
    return onDemand.use(part => part.modelOptions(this))
  }

  /** Re-read the four chat options so the sheet reflects what the gateway holds. In `chat-controller-on-demand.ts`. */
  refreshOptions(botName: string): Promise<SessionLiveInfo | null> {
    return onDemand.use(part => part.refreshOptions(this, botName))
  }

  /** Ask the gateway how full this session's context window is. In `chat-controller-on-demand.ts`. */
  refreshUsage(botName: string): Promise<Usage | null> {
    return onDemand.use(part => part.refreshUsage(this, botName))
  }

  // ── approvals while a turn runs ────────────────────────────────────────────

  /** The app came to the front: re-read anything the agent is still waiting on. */
  async onForeground(): Promise<void> {
    this.foregrounded = true
    this.syncApprovalPoll()
    this.syncSubagentPoll()

    await Promise.all(liveChatNames(this.chats.getState()).map(name => this.refreshPendingApprovals(name)))
  }

  onBackground(): void {
    this.foregrounded = false
    this.stopApprovalPoll()
    this.stopSubagentPoll()
  }

  /**
   * Poll for approvals only while a turn is running and the app is in front.
   *
   * The socket delivers approvals as server requests, so this is a safety net
   * for the one case that has no frame: a request written while the app was
   * detached. Polling an idle chat would be pure battery.
   */
  private syncApprovalPoll(): void {
    const busy = Object.values(this.chats.getState().chats).some(chat => chat.turn.active)

    if (busy && this.foregrounded) {
      if (this.approvalPollTimer === undefined) {
        this.approvalPollTimer = setInterval(() => {
          for (const name of liveChatNames(this.chats.getState())) {
            void this.refreshPendingApprovals(name)
          }
        }, APPROVAL_POLL_MS)
      }

      return
    }

    this.stopApprovalPoll()
  }

  private stopApprovalPoll(): void {
    if (this.approvalPollTimer !== undefined) {
      clearInterval(this.approvalPollTimer)
      this.approvalPollTimer = undefined
    }
  }

  private async refreshPendingApprovals(botName: string): Promise<void> {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      return
    }

    try {
      const result = await this.gateway.request('approval.pending', {
        session_id: chat.runtimeSessionId,
        profile: botName
      })

      for (const approval of Array.isArray(result?.approvals) ? result.approvals : []) {
        const approvalId = typeof approval.request_id === 'string' ? approval.request_id : ''

        // `pending:` marks a card with no live JSON-RPC reply behind it, the
        // same shape `applyResumeSnapshot` synthesizes. The reducer folds it
        // onto the card already showing this queue entry, if there is one —
        // the poll is a safety net for questions with no card, not a second
        // copy of the ones that have.
        this.chats.getState().dispatchServerRequest(botName, {
          id: `pending:${approvalId || 'approval'}`,
          method: 'approval',
          params: approval,
          replayed: true
        })
      }
    } catch {
      // The poll is best-effort by construction.
    }
  }

  // ── cache ──────────────────────────────────────────────────────────────────

  /** Write one chat's snapshot. Called on `message.complete`, on close and on background. */
  async persist(botName: string): Promise<void> {
    // A stopped controller writes no cache: a sign-out stops it and then clears
    // the cache, and a flow that was in flight must not write behind that.
    if (this.detached) {
      return
    }

    const chat = this.chats.getState().chats[botName]

    if (!this.cache || !chat || chat.hydration === 'cold') {
      return
    }

    const snapshot = snapshotForCache(chat, this.now())

    try {
      await this.cache.write({
        // Per conversation: an own chat under the bot's key is written under
        // `bot#<storedId>`, never over the group chat's entry.
        bot: this.cacheKeyOf(botName),
        itemsJson: JSON.stringify(snapshot),
        lastRowId: snapshot.lastRowId ?? null,
        lastSeq: snapshot.lastSeq,
        epoch: snapshot.epoch ?? null,
        updatedAt: snapshot.updatedAt
      })
    } catch {
      // A cache write that fails costs the next cold start a spinner.
    }
  }

  /** Write every live chat: the app is going to the background. */
  async persistAll(): Promise<void> {
    await Promise.all(liveChatNames(this.chats.getState()).map(name => this.persist(name)))
  }

  /**
   * The user left the chat screen. This writes the cache and marks the chat
   * read; it deliberately does NOT detach, so bot-to-bot traffic keeps arriving.
   */
  async closeChat(botName: string): Promise<void> {
    this.markLeft(botName)
    await this.persist(botName)
  }

  /**
   * The reader is leaving whatever is under this key: its watermark moves, under
   * the key of the conversation it IS — `bot#<storedId>` while parked in one of
   * their own chats, so the group chat's badge is left alone.
   */
  markLeft(botName: string): void {
    const key = this.readKeyFor(botName)
    const bots = this.bots.getState()

    bots.markSeen(key, Math.floor(this.now() / 1000))

    const chat = this.chats.getState().chats[botName]

    if (key !== botName && !botName.includes('#') && chat) {
      // A listing row carries a count and no activity time, so an own chat that
      // is not open is called unread by counting (`isOwnUnread`). The best count
      // there is: what the gateway last reported (on open, or in a listing), or
      // what this transcript holds — messages streamed in live included, which
      // carry no row yet. Never lowered: a chat just read is never unread.
      const storedId = key.slice(botName.length + 1)

      bots.markSeenCount(
        key,
        Math.max(
          bots.seenCounts[key] ?? 0,
          this.openedCounts.get(key) ?? 0,
          this.listedCounts.get(storedId) ?? 0,
          countMessages(chat)
        )
      )
    }
  }

  requireRuntime(botName: string): string {
    const chat = this.chats.getState().chats[botName]

    if (!chat?.runtimeSessionId) {
      throw new Error(`${botName}'s chat is not attached to the gateway yet.`)
    }

    return chat.runtimeSessionId
  }
}

export const collapse = (value: unknown): string =>
  (typeof value === 'string' ? value : '').replace(/\s+/gu, ' ').trim()

/** `bot` bound to one of the reader's own chats, or to its group chat with `null`. */
export function botOn(bot: Bot, own: BotCanonicalSession | null): Bot {
  if (own) {
    return { ...bot, current: own }
  }

  if (!bot.current) {
    return bot
  }

  const rest = { ...bot }

  delete rest.current

  return rest
}

/**
 * An image, which goes over the socket as bytes. `kind` is optional so every
 * existing call site keeps compiling and keeps meaning what it meant.
 */
/**
 * A completion call that did not answer, in the words a popover can print.
 *
 * Two fields and no error object: the surface that draws this is a row in a
 * list, and the one thing it has to be able to do is say WHICH call failed and
 * what the gateway said about it. `describeRpcFailure` has already pulled the
 * gateway's `{code, message}` out of the transport's envelope and capped it, so
 * nothing here re-parses anything.
 */
export interface SlashFailure {
  /** The JSON-RPC method that refused, e.g. `commands.catalog`. */
  method: string
  /** The gateway's own words, with its code in front when it sent one. */
  reason: string
}

/**
 * A ring entry, as a row.
 *
 * A transport failure carries no message at all — the socket went away, there
 * was nobody to say anything — and an empty reason would draw as a dangling
 * dash. `noAnswer` is the honest word for it and is the only text this layer
 * invents.
 */
export function slashFailureOf(failure: RpcFailure): SlashFailure {
  const said = failure.message.trim()
  const reason = failure.code === undefined ? said : `${failure.code} ${said}`.trim()

  return { method: failure.method, reason: reason || SLASH_NO_ANSWER }
}

/** What a failure with no words from the gateway says instead. */
export const SLASH_NO_ANSWER = 'no answer'

/** What `complete.slash` answered, and how much of the line it stands for. */
export interface SlashCompletions {
  items: CompletionItem[]
  replaceFrom?: number
  /**
   * The call that would not answer, when one of them did not.
   *
   * Present ALONGSIDE `items` rather than instead of them: a failed catalogue
   * and a working `complete.slash` is a real state, and it is the one where the
   * list looks fine and Return does the wrong thing.
   */
  failure?: SlashFailure
}

export interface ImageAttachmentInput {
  kind?: 'image'
  filename: string
  base64: string
}

/**
 * A file already uploaded to the gateway. Only the path travels with the prompt
 * — the bytes went over HTTP, because upstream has no file-attach RPC. See
 * `file-upload.ts`.
 */
export interface FileAttachmentInput {
  kind: 'file'
  filename: string
  /** The absolute path on the gateway, from the upload's own answer. */
  path: string
}

export type AttachmentInput = ImageAttachmentInput | FileAttachmentInput

const isFileAttachment = (attachment: AttachmentInput): attachment is FileAttachmentInput => attachment.kind === 'file'

/**
 * What the painted bubble records as its attachments: references, not names.
 *
 * `UserItem.attachments` is the same contract on both sides of the wire — the
 * `@file:` / `@image:` directive strings the persisted row carries — and
 * reconciliation pairs a sent turn with its row on them whenever the prompt had
 * no words to pair on. A display name here instead is a string the gateway has
 * never seen, and a file sent with no text then came back as a second bubble.
 *
 * A file's reference is the exact token the prompt names it by, so the two are
 * built the same way. An image's is not knowable: `image.attach_bytes` sends the
 * bytes out of band and the gateway decides where they land, writing its own
 * `@image:<path>` into the row. The name goes in the path position, which is
 * what both sides can still agree on, and the row's own reference replaces it
 * once it lands.
 */
function attachmentReferences(attachments: readonly AttachmentInput[]): string[] | undefined {
  if (!attachments.length) {
    return undefined
  }

  return attachments.map(attachment =>
    isFileAttachment(attachment) ? fileReferenceFor(attachment.path) : imageReferenceFor(attachment.filename)
  )
}

/** One entry of the gateway's model inventory, as the options picker shows it. */
export interface ModelChoice {
  /** The value `config.set {key:'model'}` takes. */
  id: string
  label: string
  provider: string
}

/**
 * `session.resume`'s reply is a superset of what `applyResumeSnapshot` reads.
 * Naming the fields here rather than casting the whole result keeps the two
 * contracts visibly connected: a field the gateway renames fails to compile.
 */
function resumeSnapshotOf(result: SessionResumeResult): ResumeSnapshot {
  return {
    // Whole, on purpose: the engine reads `assistant_unsealed` (the text no note above already shows) and
    // `display_metadata.turn_id` (which prompt the running turn answers) from it, and a field this client
    // picked by name would be one more the gateway can add without anyone noticing it was dropped.
    inflight: asRecord(result.inflight),
    running: result.running ?? null,
    // The gateway states this twice — once at the top level and once inside
    // `info` — and an older one states it only in `info`. The reducer needs it
    // to tell a reply the running turn wrote from the reply that ended the
    // previous turn, so read whichever half answered.
    turn_started_at: result.turn_started_at ?? result.info?.turn_started_at ?? null,
    queued: asRecord(result.queued),
    pending_approval: asRecord(result.pending_approval),
    todo_state: asRecord(result.todo_state),
    open_requests: Array.isArray(result.open_requests) ? result.open_requests.map(forEngine) : null
  }
}

/**
 * An open request as the engine is handed it. An interactive one (`input.form`, `input.file`, `review.draft`) carries
 * its three envelope keys and nothing else, cleaned as the interactive model hands them (`InteractiveEngine.asked`):
 * its fields, its files' directory and a draft's text stay beside the engine, and its heading cannot carry a
 * control or bidi character into the transcript. Every other request is passed on as it came.
 */
function forEngine(entry: OpenRequestEntry): OpenRequestEntry {
  const params: Record<string, unknown> = entry?.params && typeof entry.params === 'object' ? entry.params : {}

  if (typeof entry?.method !== 'string' || !isInteractiveMethod(entry.method)) {
    return { ...entry, params }
  }

  return {
    id: entry.id,
    method: entry.method,
    params: {
      title: displayText(params.title, INTERACTIVE_LIMITS.title),
      summary: displayText(params.summary, INTERACTIVE_LIMITS.summary),
      optional: params.optional === true
    }
  }
}

/**
 * The generated contract models these as closed interfaces; the reducer reads
 * them as open bags because the gateway keeps adding fields to them. One narrow
 * widening here beats a cast at every call site.
 */
function asRecord(value: object | null | undefined): Record<string, unknown> | null {
  return value ? ({ ...value } as Record<string, unknown>) : null
}

/**
 * The open approval card already showing this queue entry, if any.
 *
 * The same question reaches a client under several transport ids; the reducer
 * keeps one card for it, and this is how the caller finds which one so the live
 * reply handle can be filed against it.
 */
function approvalCardIdFor(chat: ChatState | undefined, approvalId: string): string | undefined {
  if (!chat || !approvalId) {
    return undefined
  }

  const itemId = chat.byApprovalId[approvalId]
  const item = itemId ? chat.items[itemId] : undefined

  return item?.kind === 'approval' && item.state === 'open' ? item.requestId : undefined
}

/**
 * One event frame, replayed or live, narrowed to what the reducer needs.
 *
 * `turn_id` rides the envelope beside `seq`, not the payload, so it has to be named here to survive:
 * a frame without it (an older gateway) simply has none, and the engine then takes its old path.
 */
function transcriptEventOf(raw: Record<string, unknown>): TranscriptEvent | null {
  if (typeof raw.type !== 'string') {
    return null
  }

  return {
    type: raw.type,
    ...(typeof raw.session_id === 'string' ? { session_id: raw.session_id } : {}),
    ...(typeof raw.seq === 'number' ? { seq: raw.seq } : {}),
    ...(typeof raw.turn_id === 'string' && raw.turn_id ? { turn_id: raw.turn_id } : {}),
    payload: raw.payload
  }
}

/**
 * How many messages a chat holds as the gateway would count them: its persisted
 * rows, plus the user and assistant items streamed in live that have no row yet.
 */
function countMessages(chat: ChatState): number {
  let live = 0

  for (const id of chat.order) {
    const item = chat.items[id]

    if (item && item.rowId === undefined && (item.kind === 'user' || item.kind === 'assistant')) {
      live += 1
    }
  }

  return countPersistedRows(chat) + live
}

/** How many persisted rows a chat holds, for the reconnect count comparison. */
function countPersistedRows(chat: ChatState): number {
  let count = 0

  for (const id of chat.order) {
    if (chat.items[id]?.rowId !== undefined) {
      count += 1
    }
  }

  return count
}

// ── the runtime ──────────────────────────────────────────────────────────────

/**
 * What the Expo app's `ChatRuntime` ran beside the controller and this client
 * does not have: the share outbox (`ShareDelivery.pump`) and the Shortcuts
 * queue (`IntentRunner.run`). There, both were pumped on every connection
 * status and on every return to the foreground; here the same two call sites
 * call this interface, and the default (`NO_RUNTIME_HOOKS`) does nothing. A
 * feature that brings either back plugs in here and inherits the timing.
 */
export interface ChatRuntimeHooks {
  /** Drain the share outbox into its chats. */
  pumpShare(): void | Promise<void>
  /** Run what the intents queue holds. */
  runIntents(): void | Promise<void>
}

/** The hooks of a client with no share outbox and no intents queue. */
export const NO_RUNTIME_HOOKS: ChatRuntimeHooks = {
  pumpShare() {},
  runIntents() {}
}

export interface ConnectChatsOptions {
  /** The page's connection (`connectGateway`): its gateway, REST half, roster and stores. */
  client: GatewayClient
  /** The page's chat store unless told otherwise. */
  chats?: ChatsStore
  /** This gateway's transcript cache: a chat paints from it before the socket answers. */
  cache?: ChatCache | null
  /** The reader's own author from the boot (`signed_in.author`), for the optimistic bubble. */
  author?: MessageAuthor | undefined
  /** The page's own-author store unless told otherwise. */
  ownAuthor?: ZustandStoreApi<OwnAuthorState>
  /** The share outbox and the intents queue; nothing unless told otherwise. */
  hooks?: ChatRuntimeHooks
  /** The page's own unless told otherwise. */
  visibility?: VisibilityWatcher
  /** The ingest's frames; `animationFrames` unless told otherwise. */
  frames?: FrameSource
  now?: () => number
}

/** What the chat screen (W-10b) and the composer (W-11) program against. */
export interface ChatRuntime {
  readonly controller: ChatController
  /** The store a screen subscribes to: committed once per frame. */
  readonly chats: ChatsStore
  /**
   * Stop following the gateway, apply what is queued, and empty the chat
   * store. For sign-out: call it before `GatewayClient.stop`. Idempotent.
   */
  stop(): void
}

/**
 * The React-free half of the Expo app's `ChatRuntime`, for one page: the
 * controller on the page's connection, started, and told when the page is
 * shown and hidden.
 *
 *  - **Shown**: `onForeground` (the approval and subagent polls resume, and
 *    every live chat re-reads its pending approvals), then the two hooks.
 *  - **Hidden**: `onBackground` (the polls stop: a hidden tab may be throttled
 *    to a stop, and the socket closes after a minute anyway), the ingest is
 *    flushed so the store holds what arrived, and every live chat is written to
 *    the cache, which is the one moment worth writing at.
 *  - **Every connection status**: the two hooks, as the Expo app pumped them.
 *
 * New in the web client: the Expo app did this inside a React provider.
 */
export function connectChats(options: ConnectChatsOptions): ChatRuntime {
  const { client } = options
  const chats = options.chats ?? chatsStore
  const ownAuthor = options.ownAuthor ?? ownAuthorStore
  const hooks = options.hooks ?? NO_RUNTIME_HOOKS
  const visibility = options.visibility ?? visibilityWatcher

  // What a previous runtime left behind belongs to another session.
  chats.getState().reset()
  ownAuthor.getState().set(options.author)

  const controller = new ChatController({
    gateway: client.gateway,
    chats,
    bots: client.stores.bots,
    botsController: client.bots,
    http: client.http,
    cache: options.cache ?? null,
    // The switch the roster was built with: one directory, so the two cannot disagree about which chat is whose.
    userChats: client.userChats,
    ownAuthor: () => ownAuthorOn(ownAuthor),
    onRpcFailure: failure => client.stores.connection.getState().noteRpcFailure(failure),
    plugin: client.stores.plugin,
    visibility,
    ...(options.frames ? { frames: options.frames } : {}),
    ...(options.now ? { now: options.now } : {})
  })

  const pumpHooks = (): void => {
    for (const run of [() => hooks.pumpShare(), () => hooks.runIntents()]) {
      try {
        void Promise.resolve(run()).catch(() => undefined)
      } catch {
        // A hook is somebody else's feature; it never costs the chats.
      }
    }
  }

  controller.start()

  const stopStatus = client.gateway.onStatus(() => pumpHooks())
  const stopVisibility = visibility.subscribe(next => {
    if (next === 'visible') {
      void controller.onForeground().catch(() => undefined)
      pumpHooks()

      return
    }

    controller.onBackground()
    controller.ingest.flush()
    void controller.persistAll().catch(() => undefined)
  })

  let stopped = false

  return {
    controller,
    chats,
    stop() {
      if (stopped) {
        return
      }

      stopped = true
      stopVisibility()
      stopStatus()
      controller.stop()
      chats.getState().reset()
      ownAuthor.getState().reset()
    }
  }
}
