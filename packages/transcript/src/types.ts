/**
 * The transcript item model.
 *
 * One chat with one bot is a normalised `ChatState`: an id-keyed `items` map, an
 * `order` array and a handful of indices. History rows and live gateway events
 * are projected into the SAME item kinds (see `rows-to-items.ts` and
 * `reducer.ts`), so a loaded transcript and a streamed one render identically.
 *
 * Nothing here filters. Verbosity and the bot-to-bot toggle are selectors
 * (`selectors.ts`); the reducer always keeps the full truth.
 */
import type { CronDeliveryShape } from './cron-delivery'
import type { ErrorSurface, SessionLiveInfo, Usage } from '@hermes/shared/gateway-events'

/** Client-side verbosity filter. Purely a read-time concern. */
export type Verbosity = 'quiet' | 'normal' | 'verbose'

/**
 * Where an item came from, which decides what reconciliation may drop.
 * `history` is persisted, `live` arrived on the socket, `optimistic` is a local
 * submit not yet echoed, `inflight` was rebuilt from a resume snapshot and
 * `foreign` is a placeholder for a turn somebody else (a teammate bot, another
 * surface) started in this session.
 */
export type ItemOrigin = 'history' | 'live' | 'optimistic' | 'inflight' | 'foreign'

/** One emoji reaction on a persisted row. */
export interface ItemReaction {
  emoji: string
  [key: string]: unknown
}

export interface ItemBase {
  /** Stable across re-hydration — see `reconcile.ts`. */
  id: string
  /** Sort key within `order`; history rows get `index * 1000` so live items fit between. */
  seq: number
  /** Unix seconds, when the wire carried one. */
  ts?: number
  /** Durable `messages.id` once the row is persisted. */
  rowId?: number
  origin: ItemOrigin
  /** Bumped on every mutation; lets a UI memoize per item and per state cheaply. */
  version: number
  reactions?: ItemReaction[]
  /**
   * The gateway's id for the turn a `role:user` row started
   * (`display_metadata.turn_id` on the persisted row). The same id rides every
   * live frame of that turn, so it is how a turn's prompt is recognised without
   * reading its words. It sits on the item whatever that row became: the
   * owner's bubble, but also the notice, cron report or bot message a turn the
   * gateway started on its own (an auto-continue, a notification) projects to,
   * because a placeholder that turn stood up is only ever settled by a row that
   * names it. Absent from a gateway that does not mint one, and from every item
   * a row did not start a turn with.
   */
  turnId?: string
}

/**
 * Who the GATEWAY said wrote a row — never a guess.
 *
 * Absent means nobody knows: the turn was unattributed (a crash continuation,
 * a wake, a cron, a bot delivery), the session's identity was ambiguous, or the
 * row predates the gateway writing this at all. An absent author must stay
 * absent; it is never inferred from `origin`, `pending`, or anything else the
 * client already believes about the item.
 */
export interface MessageAuthor {
  /** `<provider>:<user_id>` exactly as the gateway spelled it. The identity. */
  id: string
  /** The gateway's own display name for them, when it sent one. Untrusted text. */
  name?: string
  /**
   * Present when an AGENT sent the row on this person's behalf (`display_metadata.author.via`):
   * `id` and `name` are still the person's, and this says it was not the person typing. Absent for
   * a person's own turn and from a gateway that does not stamp it. Clients draw `authorLabel`.
   */
  via?: AuthorVia
}

/** What sent a row on somebody's behalf. `kind` is `"mcp"` today; a reader treats any kind alike. */
export interface AuthorVia {
  kind: string
  /** The agent's own name (`Claude Code`), cleaned to one line of at most 80 characters. Untrusted text. */
  client: string
}

/** A human turn (or the bot's own steer / skill invocation projection). */
export interface UserItem extends ItemBase {
  kind: 'user'
  text: string
  /**
   * The `@file:` / `@image:` REFERENCE strings this turn carries — never display
   * names. One contract, whichever transport built the item:
   *
   * - a persisted row: the directives `stripUserText` lifted out of its text;
   * - a local submit: the same directives, as `beginLocalTurn` projects them out
   *   of the body it was handed — plus, for an image, a reference whose path
   *   position holds only the file name, because `image.attach_bytes` takes the
   *   bytes out of band and the gateway alone decides where they land.
   *
   * Everything else derives from this, and nothing stores a second copy: the chip
   * name (`attachmentName` in the chat kit) and the reconciliation key
   * (`attachmentsMatchKey`) both read the name off the reference. A display name
   * stored here instead is a name the other side of the wire has never seen —
   * which is fine while there is text to pair a turn on, and is how a file sent
   * with no text came back as a second bubble.
   */
  attachments?: string[]
  /** Submitted locally, not yet acknowledged by the gateway. */
  pending?: boolean
  displayKind?: 'skill_invocation' | 'steer'
  /** A foreign turn started before we know who spoke; filled by `reconcileTail`. */
  unknownAuthor?: boolean
  /** Who the gateway says wrote this row. See `MessageAuthor` — absent, never guessed. */
  author?: MessageAuthor
  /**
   * Who pressed retry, when it was somebody other than the author (`display_metadata.replayed_by`),
   * with `via` when that was an agent. The row stays its author's.
   */
  replayedBy?: MessageAuthor
}

/** An inbound bot-to-bot message: a `role:user` row that is NOT the human speaking. */
export interface BotDmInItem extends ItemBase {
  kind: 'bot_dm_in'
  senderName: string
  senderHandle?: string
  text: string
  /** True when this chat dispatched a `message_agent` to that sender in the current exchange. */
  answersOurDispatch?: boolean
}

export interface AssistantFailure {
  message: string
  /** `text` is streamed partial output worth keeping, not the error string. */
  partial: boolean
  /** The backend retained the failed turn; a resume will replay it. */
  recoverable?: boolean
  surface?: ErrorSurface
}

export interface AssistantItem extends ItemBase {
  kind: 'assistant'
  text: string
  reasoning?: string
  reasoningVerbose?: boolean
  streaming: boolean
  /** Sealed mid-turn commentary: rendered without the turn's action footer. */
  interim: boolean
  status?: 'complete' | 'error' | 'interrupted'
  error?: AssistantFailure
  usage?: Usage
  durationS?: number
  /** Set when this reply answers an inbound DM rather than the human. */
  replyToBotHandle?: string
}

export type ToolStatus = 'generating' | 'running' | 'complete' | 'error' | 'unknown'

export interface ToolItem extends ItemBase {
  kind: 'tool'
  toolId: string
  name: string
  /** The gateway's ~80 char call preview. */
  context?: string
  args?: Record<string, unknown>
  /** Only sent when the gateway runs at `display.tool_progress verbose`. */
  argsText?: string
  /**
   * `"<call_row_id>/<call_index>"`: the persisted assistant row holding this call
   * and its position in that row's `tool_calls`. Unique per session whatever the
   * provider's `toolId` looks like. Absent when the wire carried no call identity.
   */
  callKey?: string
  status: ToolStatus
  /** False for a history row: the gateway does not persist tool results. */
  resultKnown: boolean
  result?: unknown
  resultText?: string
  summary?: string
  inlineDiff?: string
  durationS?: number
  isError?: boolean
  outputRisk?: ToolOutputRisk
}

export interface ToolOutputRisk {
  risk: string
  findings: string[]
  redacted: boolean
}

export type DispatchStatus = 'sending' | 'queued' | 'failed' | 'ambiguous' | 'unknown'

export interface BotDmDispatch {
  status: DispatchStatus
  deliveryId?: string
  /** Background delivery process; the reply lands as a `process_complete` row with this id. */
  processId?: string
  to?: string
  error?: string
  reason?: string
}

export interface BotDmReply {
  text: string
  ts?: number
  rowId?: number
  /**
   * The turn the delivery row started (`display_metadata.turn_id`), when the
   * row joined this card and so left no item of its own to carry it: the one
   * thing that says a placeholder standing for that turn has had its row.
   */
  turnId?: string
  error?: string
  reason?: string
}

/** An outbound `message_agent` call plus, later, the teammate's answer. */
export interface BotDmOutItem extends ItemBase {
  kind: 'bot_dm_out'
  toolId: string
  /** The target exactly as the model wrote it. */
  target: string
  /** The routing alias: `@`-stripped, connection-stripped, last path segment, lowercased. */
  targetHandle: string
  message: string
  /** The call identity, as on `ToolItem.callKey`. */
  callKey?: string
  dispatch: BotDmDispatch
  reply?: BotDmReply
}

export type SubagentGroupStatus = 'dispatched' | 'running' | 'done' | 'failed'

/** One `delegate_task` fan-out. The children live in `ChatState.subagents`. */
export interface SubagentGroupItem extends ItemBase {
  kind: 'subagent_group'
  delegationId?: string
  toolId?: string
  /** The call identity of the `delegate_task` call, as on `ToolItem.callKey`. */
  callKey?: string
  goals: string[]
  /** Subagent ids belonging to this fan-out. */
  rootIds: string[]
  status: SubagentGroupStatus
  completion?: string
}

export type SubagentStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted'
export type SubagentStreamKind = 'progress' | 'tool' | 'thinking' | 'summary'

export interface SubagentStreamEntry {
  at: number
  kind: SubagentStreamKind
  text: string
  isError?: boolean
}

export interface Subagent {
  id: string
  parentId: string | null
  delegationId?: string
  /** The child's own stored session id, so a UI can open its transcript. */
  childSessionId?: string
  goal: string
  model?: string
  depth?: number
  taskIndex: number
  taskCount: number
  status: SubagentStatus
  startedAt: number
  updatedAt: number
  durationSeconds?: number
  toolCount?: number
  inputTokens?: number
  outputTokens?: number
  filesRead: string[]
  filesWritten: string[]
  /** Capped at `SUBAGENT_STREAM_CAP` entries. */
  stream: SubagentStreamEntry[]
  summary?: string
  currentTool?: string
  acceptingSteer?: boolean
}

/** Transient one-liner (`status.update`): compaction, goals, lifecycle, process. */
export interface StatusItem extends ItemBase {
  kind: 'status'
  statusKind: string
  text: string
}

export type NoticeKind =
  /**
   * The answer to a slash command the owner typed.
   *
   * Not the machine narrating itself: it is the PAYLOAD of something somebody
   * asked for, which is why `selectors.ts` keeps it at every verbosity level and
   * `NoticePill` opens it without being asked. Live-only — command output is
   * never persisted, so no history row ever projects onto this kind.
   */
  | 'command'
  | 'model_switch'
  | 'personality_switch'
  | 'auto_continue'
  | 'process_complete'
  | 'async_delegation_complete'
  | 'internal_notification'
  /** A `[System: …]` note nothing labelled, its wrapper already taken off. */
  | 'system_note'
  | 'error'
  | 'notice'
  | 'reclaimed'
  | 'unknown_display_kind'

/** One `[IMPORTANT: Background process <sid> …]` block, kept so a later tail
 *  reconcile can still join a DM reply onto the dispatch that spawned it. */
export interface ProcessCompletionBlock {
  sid: string
  command: string
  output: string
}

export interface NoticeItem extends ItemBase {
  kind: 'notice'
  noticeKind: NoticeKind
  title: string
  body?: string
  /** Only on `noticeKind: 'process_complete'`: the blocks not yet attributed. */
  completions?: ProcessCompletionBlock[]
}

/**
 * A scheduled job's report, delivered into this chat.
 *
 * Notice-class, not speech: it arrives on the `user` role because the turn it
 * starts runs on that role, but nobody said it — the scheduler did. Detected
 * from the header alone (`cron-delivery.ts`), because the wire carries no marker.
 */
export interface CronDeliveryItem extends ItemBase {
  kind: 'cron_delivery'
  /** The job name the header carried. */
  jobName: string
  /** `jobName` is the redactor's placeholder, not a name; do not title a card with it. */
  nameRedacted?: boolean
  /** The report itself, header removed. Empty when the header arrived without one. */
  body: string
  /** Which header matched, so a card can say how it got here. */
  shape: CronDeliveryShape
}

export type RequestState = 'open' | 'answered' | 'cancelled'

export interface ApprovalItem extends ItemBase {
  kind: 'approval'
  /** JSON-RPC server-request id (`srq-N`). */
  requestId: string
  /** The approval queue's own id, which `approval.respond` addresses. */
  approvalId: string
  command: string
  description?: string
  toolName?: string
  choices: string[]
  allowPermanent?: boolean
  allowSession?: boolean
  smartDenied?: boolean
  state: RequestState
  answer?: string
  cancelReason?: string
}

export interface ClarifyQuestionItem {
  qid: string
  question: string
  choices?: string[]
  multiSelect: boolean
}

export interface ClarifyItem extends ItemBase {
  kind: 'clarify'
  requestId: string
  questions: ClarifyQuestionItem[]
  /**
   * The request carried a `questions` array rather than one bare `question`.
   *
   * It decides the shape of the answer: a batch resolves with `answers` keyed
   * by qid, a single question with a bare `answer`. It is also the difference
   * between a request `clarify.lock` can settle and one it reports `expired`
   * for.
   */
  batch?: boolean
  /** qid → answer. */
  answers: Record<string, string>
  /** qid set the server already accepted (locked); those may not be edited. */
  locked: string[]
  state: RequestState
  cancelReason?: string
}

/**
 * How an interactive request (`input.form`, `input.file`, `review.draft`, ...) ended,
 * as KEYS and numbers only.
 *
 * What the person answered (form values, file names, the edited draft, a location)
 * is never here: it goes to the model in the tool result and nowhere else, so it
 * cannot reach the cache, a draft, an export or a diagnostics bundle. A client
 * localises these keys ("Form answered", "Draft approved, edited"); the engine
 * carries no display text of its own.
 */
export interface RequestAnswerSummary {
  /** `input.*`: how the request ended. */
  status?: 'answered' | 'skipped'
  /** `review.*`: how the request ended. */
  decision?: 'approved' | 'rejected'
  /** How many things were sent (files, ...). */
  count?: number
  /** A reviewed draft was changed before it was approved. */
  edited?: boolean
  /** A coarse key such as `approximate`; never a value. */
  precision?: string
}

/**
 * One interactive request: that a question was asked and how it ended.
 *
 * One kind for every method in `INTERACTIVE_METHODS` (`interactive-methods.ts`),
 * because they share one visual. The sheet's own params live in a per-family model
 * beside the engine; this item has no field that could hold an answer VALUE.
 */
export interface RequestItem extends ItemBase {
  kind: 'request'
  /** JSON-RPC server-request id (`srq-N`). */
  requestId: string
  /** The wire method, e.g. `input.form`. */
  method: string
  /** The agent's heading (plain text, at most 80). */
  title: string
  /** The agent's words: what it asks and why (plain text, at most 500). */
  summary: string
  /** Skip is offered. */
  optional: boolean
  state: RequestState
  /** Only once `state` is `answered`, and only when the model passed a usable summary. */
  answerSummary?: RequestAnswerSummary
  /** Why the gateway withdrew it (`timeout`, `too_many_attempts`, ...). */
  cancelReason?: string
}

/** The kinds that ask the person something and wait: `state` says whether they still do. */
export type RequestLikeItem = ApprovalItem | ClarifyItem | RequestItem

export const isRequestLikeItem = (item: TranscriptItem | undefined): item is RequestLikeItem =>
  item?.kind === 'approval' || item?.kind === 'clarify' || item?.kind === 'request'

export type TranscriptItem =
  | ApprovalItem
  | AssistantItem
  | BotDmInItem
  | BotDmOutItem
  | ClarifyItem
  | CronDeliveryItem
  | NoticeItem
  | RequestItem
  | StatusItem
  | SubagentGroupItem
  | ToolItem
  | UserItem

export type TranscriptItemKind = TranscriptItem['kind']

/** A prompt parked behind the running turn. */
export interface QueuedPrompt {
  text: string
  /**
   * This client submitted it. The turn it eventually starts is ours, so the
   * reducer must not stand a foreign-author placeholder in front of it.
   */
  local?: boolean
}

/** Authoritative todo snapshot (`tool_progress._normalize_todo_state`). */
export interface TodoSnapshot {
  todos: unknown[]
  revision: number
}

export interface TurnState {
  active: boolean
  /** The gateway's id for the running turn (`turn_id` on its frames), when it sent one. */
  id?: string
  startedAt?: number
  /** The assistant item currently receiving deltas. */
  assistantId?: string
  /**
   * The item holding THIS turn's thought.
   *
   * One turn is one thought, and the events that carry it do not all arrive
   * while the same bubble is live: `reasoning.delta` streams before the first
   * token, and `reasoning.available` comes out of `tool_progress`, which means
   * it lands AFTER a tool call has already sealed that bubble. Resolving the
   * target through `turn.assistantId` alone therefore started a second bubble
   * for the same thinking, and the reader saw `Thought for 1s` twice with the
   * same block under each — see `reasoningTargetId`.
   *
   * Cleared with the rest of the turn, so the next one thinks afresh.
   */
  reasoningId?: string
  /** True when WE submitted this turn; false means a foreign turn. */
  local: boolean
  /** Next `seq` to hand out. */
  nextSeq: number
  /** A foreign turn started; the tail needs a REST reconcile to learn who spoke. */
  foreignReconcilePending?: boolean
  interrupted?: boolean
  /** `tool.generating` announced a name before the call's id existed. */
  draftingTool?: string
}

export type HydrationState = 'cold' | 'cached' | 'hydrating' | 'live' | 'stale' | 'error'

export interface ChatState {
  botName: string
  /** The durable id we persist and resume on. Never the runtime id. */
  storedSessionId: string
  /** The lineage tip; REST rows are read under this id. */
  resolvedSessionId: string
  /** The gateway's runtime session id for the current attachment. */
  runtimeSessionId?: string
  items: Record<string, TranscriptItem>
  order: string[]
  /** tool_id → item id. */
  byToolId: Record<string, string>
  /**
   * `callKey` → item id. Derived like every index here, never cached, and empty
   * against a gateway that sends no call identity.
   */
  byCallKey: Record<string, string>
  /** String(rowId) → item id; string-keyed so the cache round-trips as JSON. */
  byRowId: Record<string, string>
  /** Server-request id → item id. */
  byRequestId: Record<string, string>
  /**
   * Approval-queue id → item id, for the open approvals only.
   *
   * The same queue entry reaches a client under more than one server-request
   * id — live as `srq-N`, rebuilt from `pending_approval` as `pending:<id>`,
   * polled out of `approval.pending` as `pending:<id>` again. They are one
   * question, so the card is deduplicated on the queue's own id rather than on
   * the transport's.
   */
  byApprovalId: Record<string, string>
  /** Background delivery process id → `bot_dm_out` item id. */
  byProcessId: Record<string, string>
  /** delegation_id → `subagent_group` item id. */
  byDelegationId: Record<string, string>
  subagents: Record<string, Subagent>
  turn: TurnState
  /** A prompt the backend parked behind the running turn. */
  queued?: QueuedPrompt
  todo?: TodoSnapshot
  usage?: Usage
  info?: SessionLiveInfo
  /** Highest event `seq` applied; anything at or below it is a replay. */
  lastSeq: number
  /**
   * The runtime session id `lastSeq` was counted under.
   *
   * The gateway numbers events per runtime session and restarts at 1 every time
   * it rebuilds one, so a watermark carried across a rebuild would swallow the
   * whole new session. `bindRuntime` compares this with the id it is binding
   * and drops the watermark when they differ.
   */
  lastSeqSessionId?: string
  /** `replay_epoch` from `gateway.ready`; a change forces full re-hydration. */
  epoch?: string
  hydration: HydrationState
  unreadCount: number
  lastSeenRowId?: number
  draft: string
  compacting?: boolean
}

/** Upstream's `MAX_STREAM` (`apps/desktop/src/store/subagents.ts`). */
export const SUBAGENT_STREAM_CAP = 24

/** The gap between history seqs; live items are handed the next multiple. */
export const SEQ_STEP = 1000

/**
 * `id`, or the nearest spelling of it no item in `taken` is already using.
 *
 * `order` is a LIST, so an id it already holds becomes a SECOND entry pointing
 * at one item: React reports "Encountered two children with the same key" and
 * the reader sees the same bubble twice. No id in this package is unique on its
 * own — a live one is minted from a counter, a persisted one from the gateway's
 * row number, a tool one from `tool_id` — and a gateway that restarts under a
 * live session hands all three out again from the beginning. So every id is put
 * through here on its way into a transcript rather than trusted.
 *
 * The suffix is deliberately one an id never carries otherwise, and it only
 * ever lands on the LATER of the two: an item already on screen keeps the id a
 * list is keyed on, so nothing remounts.
 */
export function freeItemId(taken: Readonly<Record<string, unknown>>, id: string): string {
  if (!taken[id]) {
    return id
  }

  let attempt = 2

  while (taken[`${id}#${attempt}`]) {
    attempt += 1
  }

  return `${id}#${attempt}`
}

export function createChatState(botName: string, storedSessionId: string, resolvedSessionId: string): ChatState {
  return {
    botName,
    storedSessionId,
    resolvedSessionId,
    items: {},
    order: [],
    byToolId: {},
    byCallKey: {},
    byRowId: {},
    byRequestId: {},
    byApprovalId: {},
    byProcessId: {},
    byDelegationId: {},
    subagents: {},
    turn: { active: false, local: false, nextSeq: SEQ_STEP },
    lastSeq: 0,
    hydration: 'cold',
    unreadCount: 0,
    draft: ''
  }
}
