/**
 * The live reducer: gateway events → `ChatState`.
 *
 * Every update is immutable; the touched maps are copied structurally so a UI
 * can compare by reference. Nothing here filters — see `selectors.ts`.
 */
import {
  type IncomingBotMessage,
  normalizeAgentTarget,
  parseMessageAgentResult,
  parseProcessCompleteText,
  replyFromDeliveryOutput
} from './bot-dm'
import type { ParsedCronDelivery } from './cron-delivery'
import { type InjectedRow, isInjectedNotice } from './injected'
import {
  attachmentsMatchKey,
  classifyUserRow,
  normalizedItemText,
  normalizeMatchText,
  stripUserText,
  type UserRowClass
} from './rows-to-items'
import { subagentIdOf, TERMINAL_SUBAGENT_STATUS, toSubagent } from './subagent-progress'
import type { ErrorSurface, SessionLiveInfo, Usage } from '@hermes/shared/gateway-events'
import {
  type ApprovalItem,
  type AssistantItem,
  type BotDmOutItem,
  type ChatState,
  type ClarifyItem,
  type ClarifyQuestionItem,
  freeItemId,
  type ItemOrigin,
  type ItemReaction,
  type MessageAuthor,
  type NoticeItem,
  type NoticeKind,
  SEQ_STEP,
  type StatusItem,
  type SubagentGroupItem,
  type ToolItem,
  type TranscriptItem,
  type UserItem
} from './types'

/** One `event` notification's params, as thin as the reducer needs it. */
export interface TranscriptEvent {
  type: string
  session_id?: string
  seq?: number
  payload?: unknown
}

/** `prompt.submit`'s reply, narrowed to what the optimistic turn needs. */
export interface SubmitResult {
  status?: string | null
  [key: string]: unknown
}

export interface ServerRequest {
  id: string
  method: string
  params?: Record<string, unknown>
  /** Re-delivered from a resume snapshot; must not re-notify. */
  replayed?: boolean
}

const DEFAULT_APPROVAL_CHOICES = ['once', 'session', 'always', 'deny']

const rec = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/** The gateway's own shapes; they stay open, so a narrowing cast is the honest read. */
const asUsage = (value: unknown): Usage => rec(value) as Usage
const asErrorSurface = (value: unknown): ErrorSurface => rec(value) as ErrorSurface
const asSessionInfo = (value: unknown): SessionLiveInfo => rec(value) as SessionLiveInfo

const asReactions = (value: unknown): ItemReaction[] =>
  Array.isArray(value)
    ? value
        .filter((entry): entry is ItemReaction => typeof rec(entry).emoji === 'string')
        .map(entry => rec(entry) as ItemReaction)
    : []

/** Copy every container the reducer may touch; item bodies stay shared until patched. */
function editable(state: ChatState): ChatState {
  return {
    ...state,
    items: { ...state.items },
    order: [...state.order],
    byToolId: { ...state.byToolId },
    byCallKey: { ...state.byCallKey },
    byRowId: { ...state.byRowId },
    byRequestId: { ...state.byRequestId },
    byApprovalId: { ...state.byApprovalId },
    byProcessId: { ...state.byProcessId },
    byDelegationId: { ...state.byDelegationId },
    subagents: { ...state.subagents },
    turn: { ...state.turn }
  }
}

function indexItem(next: ChatState, item: TranscriptItem): void {
  if (item.rowId !== undefined) {
    next.byRowId[String(item.rowId)] = item.id
  }

  if ((item.kind === 'tool' || item.kind === 'bot_dm_out' || item.kind === 'subagent_group') && item.callKey) {
    next.byCallKey[item.callKey] = item.id
  }

  if (item.kind === 'tool' || item.kind === 'bot_dm_out') {
    next.byToolId[item.toolId] = item.id
  }

  if (item.kind === 'bot_dm_out' && item.dispatch.processId) {
    next.byProcessId[item.dispatch.processId] = item.id
  }

  if (item.kind === 'subagent_group') {
    if (item.toolId) {
      next.byToolId[item.toolId] = item.id
    }

    if (item.delegationId) {
      next.byDelegationId[item.delegationId] = item.id
    }
  }

  if (item.kind === 'approval' || item.kind === 'clarify') {
    next.byRequestId[item.requestId] = item.id
  }

  if (item.kind === 'approval' && item.approvalId) {
    // Last one in wins: a card that replaces an earlier duplicate is the one a
    // cancel has to reach.
    next.byApprovalId[item.approvalId] = item.id
  }
}

type NewItem<T extends TranscriptItem> = Omit<T, 'seq' | 'version' | 'origin'> & { origin?: ItemOrigin }

/**
 * A draft of ANY item kind.
 *
 * `NewItem<TranscriptItem>` is not that: `Omit` over a union keeps only the keys
 * every member shares, so a cron card's `body` would not be assignable to it.
 * Mapping over the discriminant distributes the `Omit` per kind instead, which is
 * what a caller that picks a kind at runtime needs.
 */
type AnyNewItem = {
  [K in TranscriptItem['kind']]: NewItem<Extract<TranscriptItem, { kind: K }>>
}[TranscriptItem['kind']]

function addItem<T extends TranscriptItem>(next: ChatState, draft: NewItem<T>, origin: ItemOrigin = 'live'): T {
  const seq = next.turn.nextSeq
  const item = { ...draft, id: freeItemId(next.items, draft.id), seq, version: 0, origin: draft.origin ?? origin } as T

  next.turn.nextSeq = seq + SEQ_STEP
  next.items[item.id] = item
  next.order.push(item.id)
  indexItem(next, item)

  return item
}

function patchItem<T extends TranscriptItem>(next: ChatState, id: string, apply: (item: T) => T | void): T | undefined {
  const current = next.items[id] as T | undefined

  if (!current) {
    return undefined
  }

  const clone = { ...current }
  const applied = (apply(clone) ?? clone) as T
  const updated = { ...applied, version: current.version + 1 } as T

  next.items[id] = updated
  indexItem(next, updated)

  return updated
}

/**
 * Turn the item already standing at `id` into a different item, in place.
 *
 * Used for exactly one thing: a resume that can identify the prompt a foreign
 * `message.start` left a blank placeholder for. Appending the identified prompt
 * instead would put it AFTER the reply it started, because the placeholder is
 * already above the streaming bubble — so the item is replaced where it stands,
 * keeping its id (a UI keyed on it does not remount) and its `seq` (the order
 * does not move).
 */
function recastItem(next: ChatState, id: string, draft: AnyNewItem, origin: ItemOrigin): void {
  const current = next.items[id]

  if (!current) {
    return
  }

  const item = {
    ...draft,
    id,
    seq: current.seq,
    version: current.version + 1,
    origin: draft.origin ?? origin
  } as TranscriptItem

  next.items[id] = item
  indexItem(next, item)
}

/** `addItem` for a draft whose kind was decided at runtime. */
function addAnyItem(next: ChatState, draft: AnyNewItem, origin: ItemOrigin): void {
  const seq = next.turn.nextSeq
  const item = {
    ...draft,
    id: freeItemId(next.items, draft.id),
    seq,
    version: 0,
    origin: draft.origin ?? origin
  } as TranscriptItem

  next.turn.nextSeq = seq + SEQ_STEP
  next.items[item.id] = item
  next.order.push(item.id)
  indexItem(next, item)
}

function dropItem(next: ChatState, id: string): void {
  delete next.items[id]
  const at = next.order.indexOf(id)

  if (at >= 0) {
    next.order.splice(at, 1)
  }
}

/**
 * The oldest prompt of ours the gateway has parked, if any.
 *
 * Oldest first, because the gateway drains its queue in order. `pending` is set
 * by `beginLocalTurn` and cleared by `confirmSubmit` for anything the gateway
 * took straight away, so what is left marked is exactly the parked queue.
 */
function firstParkedPromptId(next: ChatState): string | undefined {
  for (const id of next.order) {
    const item = next.items[id]

    if (item?.kind === 'user' && item.origin === 'optimistic' && item.pending === true) {
      return item.id
    }
  }

  return undefined
}

function lastAssistantId(next: ChatState): string | undefined {
  for (let index = next.order.length - 1; index >= 0; index -= 1) {
    const id = next.order[index]

    if (id && next.items[id]?.kind === 'assistant') {
      return id
    }
  }

  return undefined
}

function lastItem(next: ChatState): TranscriptItem | undefined {
  const id = next.order.at(-1)

  return id ? next.items[id] : undefined
}

/** The assistant bubble currently receiving deltas, created on first need. */
function currentAssistantId(next: ChatState, now: number): string {
  const existing = next.turn.assistantId ? next.items[next.turn.assistantId] : undefined

  if (existing?.kind === 'assistant' && !existing.interim) {
    return existing.id
  }

  const item = addItem<AssistantItem>(next, {
    id: `a:${next.turn.nextSeq}`,
    kind: 'assistant',
    text: '',
    streaming: true,
    interim: false,
    ts: now / 1000
  })

  next.turn.assistantId = item.id

  return item.id
}

/**
 * Where this turn's thinking goes. One turn, one thought.
 *
 * The three events that carry reasoning do not all arrive while the same bubble
 * is live. `reasoning.delta` streams before the first token, so it lands on the
 * bubble the turn is building. `reasoning.available` is sent by
 * `tool_progress._progress_reasoning` — which is to say AFTER a tool call has
 * already sealed that bubble as an interim note — so resolving it through
 * `turn.assistantId` alone opened a SECOND bubble carrying the same block. That
 * is the owner's "every thought appears twice": one `Thought for 1s` above the
 * sealed note, an identical one above the reply.
 *
 * So the turn remembers which item holds its thought, and every later frame of
 * the same thinking goes back to it — including onto an item that has since been
 * sealed, which is exactly right: the thought belongs to the moment it happened,
 * not to whichever bubble happens to be open when the gateway gets round to
 * summarising it.
 */
function reasoningTargetId(next: ChatState, now: number): string {
  const live = next.turn.assistantId ? next.items[next.turn.assistantId] : undefined

  if (live?.kind === 'assistant' && !live.interim) {
    next.turn.reasoningId = live.id

    return live.id
  }

  const held = next.turn.reasoningId ? next.items[next.turn.reasoningId] : undefined

  if (held?.kind === 'assistant') {
    return held.id
  }

  const id = currentAssistantId(next, now)

  next.turn.reasoningId = id

  return id
}

/**
 * The sealed interim the next preview should overwrite, if there is one.
 *
 * `message.interim` is the reply SO FAR, not a message of its own: the gateway
 * sends one per mid-turn assistant message and each carries the whole text it
 * has, so appending them stacked three muted bubbles of the same growing
 * sentence above the answer. The next interim replaces the last one.
 *
 * "The last one" is deliberately narrow — the last assistant item, and only
 * while nothing but a `status` line has been appended after it. A tool card
 * between two interims means the second one is genuinely a second piece of
 * commentary, with the call it follows standing between them, and merging those
 * would drop text the reader watched arrive.
 */
function openInterimId(next: ChatState): string | undefined {
  for (let index = next.order.length - 1; index >= 0; index -= 1) {
    const id = next.order[index]
    const item = id ? next.items[id] : undefined

    if (!item || item.kind === 'status') {
      continue
    }

    return item.kind === 'assistant' && item.interim && !item.error ? item.id : undefined
  }

  return undefined
}

/**
 * The bubble a mid-turn seal left behind, when this completion is plainly that
 * same reply finishing rather than a new one.
 *
 * A tool call seals the streaming bubble as interim (`sealAssistantForTool`),
 * so `message.complete` arrives with no live bubble to settle onto. Painting
 * the final text as a NEW bubble then shows the reply twice — once partially
 * streamed, once clean — while the gateway stored a single row. Upstream hit
 * exactly this (`hermes-agent` #63679, and #74560 for the chained-turn variant)
 * and settles the final onto the interim instead.
 *
 * The test is continuity, not equality: streaming can drop characters and the
 * final can add a trailing delta, so either text being a prefix of the other
 * means the same message. Two different replies cannot satisfy that, which is
 * why this needs no boundary flag to be safe.
 */
function interimContinuedBy(next: ChatState, finalText: string): string | undefined {
  const id = lastAssistantId(next)
  const item = id ? next.items[id] : undefined

  if (item?.kind !== 'assistant' || !item.interim || item.error) {
    return undefined
  }

  const sealed = item.text.trim()
  const final = finalText.trim()

  if (!sealed || !final) {
    return undefined
  }

  return final === sealed || final.startsWith(sealed) || sealed.startsWith(final) ? id : undefined
}

/**
 * A tool call interrupts the reply: seal what the bubble already said as
 * mid-turn commentary so the tool card lands after it, and drop an empty one
 * rather than strand a blank bubble.
 */
function sealAssistantForTool(next: ChatState): void {
  const id = next.turn.assistantId

  if (!id) {
    return
  }

  const item = next.items[id]

  next.turn.assistantId = undefined

  if (item?.kind !== 'assistant') {
    return
  }

  if (!item.text.trim() && !item.reasoning?.trim()) {
    dropItem(next, id)

    return
  }

  patchItem<AssistantItem>(next, id, draft => {
    draft.streaming = false
    draft.interim = true
  })
}

function cancelOpenRequests(next: ChatState, reason: string): void {
  for (const id of next.order) {
    const item = next.items[id]

    if ((item?.kind === 'approval' || item?.kind === 'clarify') && item.state === 'open') {
      patchItem(next, id, draft => {
        ;(draft as ApprovalItem | ClarifyItem).state = 'cancelled'
        ;(draft as ApprovalItem | ClarifyItem).cancelReason = reason
      })
    }
  }
}

function clearTurn(next: ChatState): void {
  next.turn.active = false
  // A prompt WE queued starts the next turn, and that turn is still ours. Going
  // non-local here is what used to make our own message arrive as a foreign
  // placeholder the moment the turn ahead of it finished.
  next.turn.local = next.queued?.local === true
  next.turn.assistantId = undefined
  next.turn.reasoningId = undefined
  next.turn.startedAt = undefined
  next.turn.draftingTool = undefined
  next.turn.interrupted = false
  next.queued = undefined
  next.compacting = false
}

/** The one `noticeKind` a `notice` event may name; see the `case 'notice'` comment. */
function commandKind(value: unknown): NoticeKind {
  return value === 'command' ? 'command' : 'notice'
}

function pushNotice(next: ChatState, noticeKind: NoticeKind, title: string, body: string, now: number): NoticeItem {
  return addItem<NoticeItem>(next, {
    id: `n:${next.turn.nextSeq}`,
    kind: 'notice',
    noticeKind,
    title,
    ...(body ? { body } : {}),
    ts: now / 1000
  })
}

// ── subagent grouping ────────────────────────────────────────────────────────

function groupForSubagent(next: ChatState, delegationId: string | undefined, goal: string, now: number): string {
  if (delegationId && next.byDelegationId[delegationId]) {
    return next.byDelegationId[delegationId]!
  }

  for (let index = next.order.length - 1; index >= 0; index -= 1) {
    const id = next.order[index]
    const item = id ? next.items[id] : undefined

    if (item?.kind !== 'subagent_group') {
      continue
    }

    if (item.status === 'done' || item.status === 'failed') {
      break
    }

    if (item.delegationId && delegationId && item.delegationId !== delegationId) {
      continue
    }

    return item.id
  }

  const created = addItem<SubagentGroupItem>(next, {
    id: `g:${next.turn.nextSeq}`,
    kind: 'subagent_group',
    ...(delegationId ? { delegationId } : {}),
    goals: goal ? [goal] : [],
    rootIds: [],
    status: 'dispatched',
    ts: now / 1000
  })

  return created.id
}

function refreshGroup(next: ChatState, groupId: string): void {
  patchItem<SubagentGroupItem>(next, groupId, draft => {
    const members = draft.rootIds.map(id => next.subagents[id]).filter(Boolean)

    if (!members.length) {
      return
    }

    const active = members.some(child => child!.status === 'running' || child!.status === 'queued')
    const broken = members.some(child => child!.status === 'failed' || child!.status === 'interrupted')

    draft.status = active ? 'running' : broken ? 'failed' : 'done'
  })
}

// ── the reducer ──────────────────────────────────────────────────────────────

/**
 * Apply one gateway event. Events at or below `lastSeq` are replays and are
 * ignored; `now` is injectable so tests are deterministic.
 */
export function applyEvent(state: ChatState, event: TranscriptEvent, now: number = Date.now()): ChatState {
  if (typeof event.seq === 'number' && event.seq <= state.lastSeq) {
    return state
  }

  const payload = rec(event.payload)
  const next = editable(state)

  if (typeof event.seq === 'number') {
    next.lastSeq = event.seq
  }

  switch (event.type) {
    case 'message.start': {
      next.compacting = false

      if (!next.turn.local) {
        // A prompt of ours the gateway parked starts its turn right here, and
        // nothing in the frame says so: `prompt.submit` answered `queued`
        // minutes ago and `message.start` carries no author. `ChatState.queued`
        // only ever remembered the most recent one, so the SECOND prompt of a
        // parked burst used to start as a foreign turn and put an empty
        // placeholder in front of the user's own message. A bubble still marked
        // `pending` is a prompt of ours waiting for exactly this frame.
        const parked = firstParkedPromptId(next)

        if (parked) {
          patchItem<UserItem>(next, parked, draft => {
            draft.pending = false
          })
          next.turn.local = true
        } else {
          // Nobody local submitted, so this turn belongs to a teammate bot or
          // another surface. Stand a placeholder in for the author until a tail
          // reconcile tells us who spoke.
          addItem<UserItem>(
            next,
            {
              id: `f:${next.turn.nextSeq}`,
              kind: 'user',
              text: '',
              unknownAuthor: true,
              ts: now / 1000
            },
            'foreign'
          )
          next.turn.foreignReconcilePending = true
        }
      }

      next.turn.active = true
      next.turn.startedAt = now
      next.turn.assistantId = undefined
      next.turn.interrupted = false
      next.turn.draftingTool = undefined

      return next
    }

    case 'message.delta': {
      const text = str(payload.text)

      if (!text) {
        return next
      }

      const id = currentAssistantId(next, now)

      patchItem<AssistantItem>(next, id, draft => {
        draft.text += text
        draft.streaming = true
      })

      return next
    }

    case 'reasoning.delta':
    case 'thinking.delta':
    case 'reasoning.available': {
      const text = str(payload.text)

      if (!text) {
        return next
      }

      const id = reasoningTargetId(next, now)
      const replace = event.type === 'reasoning.available'

      patchItem<AssistantItem>(next, id, draft => {
        draft.reasoning = replace ? text : (draft.reasoning ?? '') + text

        if (payload.verbose === true) {
          draft.reasoningVerbose = true
        }
      })

      return next
    }

    case 'message.interim': {
      const text = str(payload.text)
      const id = next.turn.assistantId

      if (id && next.items[id]?.kind === 'assistant') {
        patchItem<AssistantItem>(next, id, draft => {
          if (text) {
            draft.text = text
          }

          draft.streaming = false
          draft.interim = true
        })
        next.turn.assistantId = undefined

        return next
      }

      if (!text) {
        return next
      }

      // No live bubble: this preview either REPLACES the one standing at the end
      // of the transcript, or starts the first note of a new stretch.
      const open = openInterimId(next)

      if (open) {
        patchItem<AssistantItem>(next, open, draft => {
          draft.text = text
        })

        return next
      }

      addItem<AssistantItem>(next, {
        id: `a:${next.turn.nextSeq}`,
        kind: 'assistant',
        text,
        streaming: false,
        interim: true,
        ts: now / 1000
      })

      return next
    }

    case 'tool.generating': {
      next.turn.draftingTool = str(payload.name)

      return next
    }

    case 'tool.start': {
      sealAssistantForTool(next)
      next.turn.draftingTool = undefined

      const toolId = str(payload.tool_id) || `gen-${next.turn.nextSeq}`
      const name = str(payload.name) || 'tool'
      const args = rec(payload.args)
      const ts = now / 1000

      if (name === 'message_agent') {
        const target = str(args.target)

        addItem<BotDmOutItem>(next, {
          id: `t:${toolId}`,
          kind: 'bot_dm_out',
          toolId,
          target,
          targetHandle: normalizeAgentTarget(target),
          message: str(args.message),
          dispatch: { status: 'sending' },
          ts
        })

        return next
      }

      if (name === 'delegate_task') {
        addItem<SubagentGroupItem>(next, {
          id: `t:${toolId}`,
          kind: 'subagent_group',
          toolId,
          goals: goalsFromArgs(args),
          rootIds: [],
          status: 'dispatched',
          ts
        })

        return next
      }

      const context = str(payload.context)
      const argsText = str(payload.args_text)

      addItem<ToolItem>(next, {
        id: `t:${toolId}`,
        kind: 'tool',
        toolId,
        name,
        ...(context ? { context, summary: context } : {}),
        ...(Object.keys(args).length ? { args } : {}),
        ...(argsText ? { argsText } : {}),
        status: 'running',
        resultKnown: false,
        ts
      })

      return next
    }

    case 'tool.complete': {
      const toolId = str(payload.tool_id)
      const name = str(payload.name) || 'tool'
      let id = toolId ? next.byToolId[toolId] : undefined

      if (!id) {
        // A tool whose start we missed (late attach, replay gap): materialise it
        // now so the result is never dropped.
        id = addItem<ToolItem>(next, {
          id: `t:${toolId || `late-${next.turn.nextSeq}`}`,
          kind: 'tool',
          toolId: toolId || `late-${next.turn.nextSeq}`,
          name,
          status: 'running',
          resultKnown: false,
          ts: now / 1000
        }).id
      }

      const item = next.items[id]
      const durationS = num(payload.duration_s)
      const summary = str(payload.summary)
      const resultText = str(payload.result_text)
      const inlineDiff = str(payload.inline_diff)
      const failed = Boolean(payload.error)

      if (item?.kind === 'bot_dm_out') {
        const dispatch = parseMessageAgentResult(payload.result ?? resultText)

        patchItem<BotDmOutItem>(next, id, draft => {
          draft.dispatch = dispatch
        })

        if (dispatch.processId) {
          next.byProcessId[dispatch.processId] = id
        }
      } else if (item?.kind === 'subagent_group') {
        patchItem<SubagentGroupItem>(next, id, draft => {
          const active = draft.rootIds.some(child => {
            const status = next.subagents[child]?.status

            return status === 'running' || status === 'queued'
          })

          draft.status = failed ? 'failed' : active ? 'running' : 'done'

          if (summary || resultText) {
            draft.completion = summary || resultText
          }
        })
      } else {
        patchItem<ToolItem>(next, id, draft => {
          draft.status = failed ? 'error' : 'complete'
          draft.resultKnown = true
          draft.result = payload.result
          draft.isError = failed

          if (resultText) {
            draft.resultText = resultText
          }

          if (summary) {
            draft.summary = summary
          }

          if (inlineDiff.trim()) {
            draft.inlineDiff = inlineDiff
          }

          if (durationS !== undefined) {
            draft.durationS = durationS
          }
        })
      }

      if (Array.isArray(payload.todos)) {
        next.todo = { todos: payload.todos, revision: num(payload.revision) ?? 0 }
      }

      return next
    }

    case 'todo.updated': {
      if (Array.isArray(payload.todos)) {
        next.todo = { todos: payload.todos, revision: num(payload.revision) ?? 0 }
      }

      return next
    }

    case 'tool.output_risk': {
      const id = next.byToolId[str(payload.tool_id)]

      if (id) {
        patchItem<ToolItem>(next, id, draft => {
          draft.outputRisk = {
            risk: str(payload.risk),
            findings: Array.isArray(payload.findings) ? payload.findings.filter(f => typeof f === 'string') : [],
            redacted: payload.redacted === true
          }
        })
      }

      return next
    }

    case 'subagent.spawn_requested':
    case 'subagent.start':
    case 'subagent.progress':
    case 'subagent.thinking':
    case 'subagent.tool':
    case 'subagent.complete': {
      const childId = subagentIdOf(payload)
      const prev = next.subagents[childId]
      const createIfMissing = event.type === 'subagent.spawn_requested' || event.type === 'subagent.start'

      if ((!prev && !createIfMissing) || (prev && TERMINAL_SUBAGENT_STATUS.has(prev.status))) {
        return next
      }

      const child = toSubagent(payload, prev, event.type, now)

      next.subagents[childId] = child

      const groupId = groupForSubagent(next, child.delegationId, child.goal, now)

      patchItem<SubagentGroupItem>(next, groupId, draft => {
        if (!draft.rootIds.includes(childId)) {
          draft.rootIds = [...draft.rootIds, childId]
        }

        if (child.goal && !draft.goals.includes(child.goal)) {
          draft.goals = [...draft.goals, child.goal]
        }

        if (child.delegationId && !draft.delegationId) {
          draft.delegationId = child.delegationId
        }
      })
      refreshGroup(next, groupId)

      return next
    }

    case 'status.update': {
      const kind = str(payload.kind)
      const text = str(payload.text)

      if (kind === 'compacting') {
        next.compacting = true
      } else if (kind === 'compacted') {
        next.compacting = false
      }

      if (!text) {
        return next
      }

      const tail = lastItem(next)

      if (tail?.kind === 'status') {
        patchItem<StatusItem>(next, tail.id, draft => {
          draft.statusKind = kind
          draft.text = text
          draft.ts = now / 1000
        })

        return next
      }

      addItem<StatusItem>(next, {
        id: `s:${next.turn.nextSeq}`,
        kind: 'status',
        statusKind: kind,
        text,
        ts: now / 1000
      })

      return next
    }

    case 'message.complete': {
      const finalText = str(payload.text) || str(payload.rendered)
      const wasInterrupted = next.turn.interrupted === true
      const rawStatus = str(payload.status)
      const status: AssistantItem['status'] =
        rawStatus === 'error' ? 'error' : rawStatus === 'interrupted' || wasInterrupted ? 'interrupted' : 'complete'
      const durationS = next.turn.startedAt ? (now - next.turn.startedAt) / 1000 : undefined
      const failure =
        rawStatus === 'error'
          ? {
              message: str(payload.error).trim() || finalText || 'The gateway reported an error',
              partial: payload.partial === true,
              ...(payload.recoverable === true ? { recoverable: true } : {}),
              ...(payload.error_surface ? { surface: asErrorSurface(payload.error_surface) } : {})
            }
          : undefined

      // `response_previewed` means the reply already landed as a sealed interim
      // bubble; promote that one instead of painting the same text twice.
      const previewed = payload.response_previewed === true ? lastAssistantId(next) : undefined
      // Without that flag, a tool call in the middle of the turn has the same
      // effect: it sealed the bubble, so this completion has nowhere to land.
      const continued = next.turn.assistantId ? undefined : interimContinuedBy(next, finalText)
      const id =
        next.turn.assistantId ??
        previewed ??
        continued ??
        (finalText || failure ? currentAssistantId(next, now) : undefined)

      if (id) {
        patchItem<AssistantItem>(next, id, draft => {
          if (finalText && payload.response_previewed !== true) {
            draft.text = finalText
          }

          draft.streaming = false
          draft.interim = false
          draft.status = status

          if (failure) {
            draft.error = failure
          }

          if (payload.usage) {
            draft.usage = asUsage(payload.usage)
          }

          if (durationS !== undefined) {
            draft.durationS = durationS
          }
        })
      }

      if (payload.usage) {
        next.usage = asUsage(payload.usage)
      }

      cancelOpenRequests(next, 'turn_ended')
      clearTurn(next)

      return next
    }

    case 'session.info': {
      next.info = asSessionInfo(payload)

      const stored = str(payload.stored_session_id)

      if (stored) {
        next.storedSessionId = stored
      }

      if (payload.running === false) {
        next.turn.active = false
      }

      return next
    }

    case 'session.usage': {
      if (payload.usage) {
        next.usage = asUsage(payload.usage)
      }

      return next
    }

    case 'session.title': {
      const title = str(payload.title)

      // A canonical Bot Chat is titled exactly `Bot Chat`; anything else means
      // this session drifted out of the canonical set and must be re-resolved.
      if (title && title !== 'Bot Chat') {
        next.hydration = 'stale'
      }

      return next
    }

    case 'error': {
      const message = str(payload.message) || 'The gateway reported an error'
      const id = next.turn.assistantId ?? currentAssistantId(next, now)

      patchItem<AssistantItem>(next, id, draft => {
        draft.streaming = false
        draft.interim = false
        draft.status = 'error'
        draft.error = { message, partial: Boolean(draft.text) }
      })
      cancelOpenRequests(next, 'turn_failed')
      clearTurn(next)

      return next
    }

    case 'notice': {
      const message = str(payload.message)

      if (message) {
        /*
          `detail` is ours, not the gateway's: upstream's notice event carries a
          single `message` and nothing else. It exists because a slash command's
          answer arrives here, and `/status` is nine lines and `/help` is five
          kilobytes of ASCII table — all of which used to be flattened into the
          TITLE with an empty body, which `NoticePill` then drew as one run of
          text with no way to fold it away. An event without it behaves exactly
          as it did.

          `noticeKind` is ours too, and exactly ONE value is accepted from it:
          `command`, the answer to a slash command the owner typed. Everything
          else — including a kind this client has never heard of — lands as a
          plain `notice`, so a gateway that starts sending the field cannot
          promote its own narration into the family that survives `quiet` and
          opens itself.
        */
        pushNotice(next, commandKind(payload.noticeKind), message, str(payload.detail), now)
      }

      return next
    }

    case 'request.cancel': {
      // The gateway withdraws a question under whichever id it knows it by: the
      // transport's request id for a live one, the approval queue's own id for
      // one the client only ever saw as a snapshot entry.
      const cancelId = str(payload.id)
      const id = next.byRequestId[cancelId] ?? next.byApprovalId[cancelId]

      if (id) {
        patchItem(next, id, draft => {
          ;(draft as ApprovalItem | ClarifyItem).state = 'cancelled'
          ;(draft as ApprovalItem | ClarifyItem).cancelReason = str(payload.reason)
        })
      }

      return next
    }

    case 'message.reaction': {
      const rowId = num(payload.row_id)
      const id = rowId === undefined ? undefined : next.byRowId[String(rowId)]

      if (id && Array.isArray(payload.reactions)) {
        const reactions = asReactions(payload.reactions)

        patchItem(next, id, draft => {
          draft.reactions = reactions
        })
      }

      return next
    }

    case 'session.reclaimed': {
      next.runtimeSessionId = undefined
      next.turn.active = false
      pushNotice(next, 'reclaimed', 'Session reclaimed by the gateway', str(payload.reason), now)

      return next
    }

    case 'btw.complete':
    case 'background.complete': {
      const text = str(payload.text).trim()

      if (text) {
        const question = str(payload.question).trim()

        pushNotice(next, 'notice', question ? `Side question: ${question}` : 'Background task finished', text, now)
      }

      return next
    }

    default:
      return next
  }
}

function goalsFromArgs(args: Record<string, unknown>): string[] {
  if (typeof args.goal === 'string' && args.goal.trim()) {
    return [args.goal.trim()]
  }

  if (!Array.isArray(args.tasks)) {
    return []
  }

  return args.tasks
    .map(task => rec(task).goal)
    .filter((goal): goal is string => typeof goal === 'string' && Boolean(goal.trim()))
    .map(goal => goal.trim())
}

// ── server→client requests ───────────────────────────────────────────────────

/**
 * The id of the still-open approval card carrying this queue entry, if there is
 * one. An answered or cancelled card does not block a fresh question that the
 * queue happened to give the same id.
 */
function openApprovalIdOf(state: ChatState, approvalId: string): string | undefined {
  if (!approvalId) {
    return undefined
  }

  const id = state.byApprovalId[approvalId]
  const item = id ? state.items[id] : undefined

  return item?.kind === 'approval' && item.state === 'open' ? id : undefined
}

/**
 * The id of the still-open card standing at this transport id, if there is one.
 *
 * The same rule `openApprovalIdOf` states, applied to the other id a question
 * carries — and it was missing here, which is the bug. A resume re-delivers an
 * OPEN request under the id it already has, and that replay must not draw a
 * second card; an ANSWERED card must not swallow a new question that happens to
 * arrive under the same id.
 *
 * Which is not hypothetical. `srq-N` is a per-process counter, and the gateway
 * restarts it at 1 for every process — the same fact `cache.ts` already carries
 * `lastSeqSessionId` for. So a cached "Allowed once" from before a restart sat
 * on `srq-1`, the first question of the new session arrived as `srq-1`, and the
 * guard dropped it: no sheet, no card, and a turn parked on an answer the
 * reader was never asked for.
 *
 * `addItem` gives the new card a free item id of its own, so the two coexist
 * and `byRequestId` points at the live one.
 */
function openRequestIdOf(state: ChatState, requestId: string): string | undefined {
  const id = state.byRequestId[requestId]
  const item = id ? state.items[id] : undefined

  if (item?.kind !== 'approval' && item?.kind !== 'clarify') {
    return undefined
  }

  return item.state === 'open' ? id : undefined
}

/** Turn an `approval` / `clarify` server request into a transcript item. */
export function applyServerRequest(state: ChatState, request: ServerRequest, now: number = Date.now()): ChatState {
  if (openRequestIdOf(state, request.id)) {
    return state
  }

  const params = rec(request.params)

  if (request.method === 'approval' && openApprovalIdOf(state, str(params.request_id) || request.id)) {
    // The same queue entry under a second transport id. One question, one card.
    return state
  }

  const next = editable(state)

  if (request.method === 'approval') {
    const choices = Array.isArray(params.choices)
      ? params.choices.filter((choice): choice is string => typeof choice === 'string')
      : DEFAULT_APPROVAL_CHOICES

    addItem<ApprovalItem>(next, {
      id: `req:${request.id}`,
      kind: 'approval',
      requestId: request.id,
      approvalId: str(params.request_id) || request.id,
      command: str(params.command),
      ...(str(params.description) ? { description: str(params.description) } : {}),
      ...(str(params.tool_name) ? { toolName: str(params.tool_name) } : {}),
      choices: choices.length ? choices : DEFAULT_APPROVAL_CHOICES,
      ...(params.allow_permanent === false ? { allowPermanent: false } : { allowPermanent: true }),
      ...(params.allow_session === false ? { allowSession: false } : { allowSession: true }),
      ...(params.smart_denied === true ? { smartDenied: true } : {}),
      state: 'open',
      ts: now / 1000
    })

    return next
  }

  if (request.method === 'clarify') {
    const answers: Record<string, string> = {}

    for (const [qid, value] of Object.entries(rec(params.answers))) {
      if (typeof value === 'string') {
        answers[qid] = value
      }
    }

    const questions: ClarifyQuestionItem[] = Array.isArray(params.questions)
      ? params.questions.map((raw, index) => {
          const question = rec(raw)

          return {
            qid: str(question.qid) || `q${index + 1}`,
            question: str(question.question),
            ...(Array.isArray(question.choices)
              ? { choices: question.choices.filter((c): c is string => typeof c === 'string') }
              : {}),
            multiSelect: question.multi_select === true
          }
        })
      : [
          {
            qid: str(params.request_id) || 'q1',
            question: str(params.question),
            ...(Array.isArray(params.choices)
              ? { choices: params.choices.filter((c): c is string => typeof c === 'string') }
              : {}),
            multiSelect: params.multi_select === true
          }
        ]

    addItem<ClarifyItem>(next, {
      id: `req:${request.id}`,
      kind: 'clarify',
      requestId: request.id,
      questions,
      ...(Array.isArray(params.questions) ? { batch: true } : {}),
      answers,
      locked: Object.keys(answers),
      state: questions.every(question => answers[question.qid] !== undefined) && questions.length ? 'answered' : 'open',
      ts: now / 1000
    })

    return next
  }

  return state
}

/** Record the user's answer locally; the transport still owns the RPC reply. */
export function answerRequest(state: ChatState, requestId: string, answer: string | Record<string, string>): ChatState {
  const id = state.byRequestId[requestId]
  const item = id ? state.items[id] : undefined

  if (!id || !item || (item.kind !== 'approval' && item.kind !== 'clarify')) {
    return state
  }

  const next = editable(state)

  if (item.kind === 'approval') {
    patchItem<ApprovalItem>(next, id, draft => {
      draft.answer = typeof answer === 'string' ? answer : (Object.values(answer)[0] ?? '')
      draft.state = 'answered'
    })

    return next
  }

  patchItem<ClarifyItem>(next, id, draft => {
    const merged = { ...draft.answers }

    if (typeof answer === 'string') {
      const open = draft.questions.find(question => merged[question.qid] === undefined)

      if (open) {
        merged[open.qid] = answer
      }
    } else {
      Object.assign(merged, answer)
    }

    draft.answers = merged
    draft.locked = Object.keys(merged)
    draft.state = draft.questions.every(question => merged[question.qid] !== undefined) ? 'answered' : 'open'
  })

  return next
}

// ── resume + local turns ─────────────────────────────────────────────────────

export interface ResumeSnapshot {
  inflight?: Record<string, unknown> | null
  running?: boolean | null
  /**
   * Unix seconds, and only meaningful while `running` is true: when the turn
   * the snapshot describes began. It is what separates a reply this turn wrote
   * from the reply that ended the previous one — see `resumeOverlap`.
   */
  turn_started_at?: number | null
  queued?: Record<string, unknown> | null
  pending_approval?: Record<string, unknown> | null
  todo_state?: Record<string, unknown> | null
  open_requests?: ServerRequest[] | null
  [key: string]: unknown
}

/**
 * The empty bubble a foreign `message.start` stands up while we wait to be told
 * who spoke.
 *
 * It is a PROMISE of a prompt, not a prompt. `message.start` carries no author,
 * so the reducer adds a blank `unknownAuthor` user item and schedules a tail
 * fetch to fill it. Until that lands the item holds no text at all, which makes
 * it indistinguishable from a real prompt only if you ask "is there a user item
 * here" and not "does it say anything".
 */
function isForeignPlaceholder(item: TranscriptItem | undefined): boolean {
  return item?.kind === 'user' && item.unknownAuthor === true && !item.text.trim()
}

/**
 * The tail of the transcript as a resume has to read it: the newest turn's
 * prompt, and the persisted reply to it if there already is one.
 *
 * `authored` is the last user or inbound-DM item, whatever origin it has;
 * `settledReply` is the durable assistant row after it. Nothing else is needed,
 * because `session.resume`'s `inflight` describes exactly one turn — the newest.
 *
 * A foreign-author placeholder is walked PAST rather than returned. It used to
 * be returned, and that was the one hole `duplicate-cron-turns.test.ts` pinned
 * and could not close: a cron delivery already in history, then a
 * `message.start` for the turn the scheduler triggered, puts a blank bubble
 * between the card and its reply — so `authored` came back as the empty string,
 * the comparison against `inflight.user` missed, and the resume stood a SECOND
 * card beside the first. A placeholder must neither count as the shown prompt
 * nor hide the item that really is it; skipping it is both halves of that.
 *
 * A STEER is walked past for the same reason and a second one of its own.
 * `session.steer` hands words to the turn already running; it starts no turn,
 * and the gateway's `inflight.user` for that turn goes on being the ORIGINAL
 * prompt. So a steer is never a turn's prompt — and while it was the newest
 * authored item, every resume compared the original prompt against the steer's
 * words, missed, and projected the prompt a second time. On the device: the
 * prompt at 21:21, the steer at 21:24, and the same prompt again at 21:24, with
 * exactly one row for it in the gateway's database.
 *
 * A gateway-injected notice IS returned. A fan-out's report or a background
 * process's completion arrives on the `user` role and the gateway runs a turn on
 * it, so it opens a turn exactly as a cron delivery does — and, like a cron
 * delivery, it is drawn as a card rather than as speech, which is why this
 * comparison has to know about it here and not only in `rows-to-items`.
 */
function shownTurn(state: ChatState): {
  authored?: string
  carried?: string
  settledReply?: string
  settledReplyTs?: number
} {
  let settledReply: string | undefined
  let settledReplyTs: number | undefined

  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.items[state.order[index] ?? '']

    if (item?.kind === 'assistant' && item.rowId !== undefined && settledReply === undefined) {
      settledReply = normalizedItemText(item)
      settledReplyTs = item.ts

      continue
    }

    if (isForeignPlaceholder(item) || (item?.kind === 'user' && item.displayKind === 'steer')) {
      continue
    }

    // One spread for both returns and the empty tail, so the reply and its
    // stamp can never come back one without the other.
    const reply =
      settledReply !== undefined ? { settledReply, ...(settledReplyTs !== undefined ? { settledReplyTs } : {}) } : {}

    if (item && isInjectedNotice(item)) {
      return { authored: normalizedItemText(item), carried: '', ...reply }
    }

    if (item?.kind !== 'user' && item?.kind !== 'bot_dm_in' && item?.kind !== 'cron_delivery') {
      continue
    }

    return {
      authored: normalizedItemText(item),
      carried: item.kind === 'user' ? attachmentsMatchKey(item.attachments) : '',
      ...reply
    }
  }

  return settledReply !== undefined ? { settledReply, ...(settledReplyTs !== undefined ? { settledReplyTs } : {}) } : {}
}

/** The newest placeholder still waiting for an author, if the turn left one. */
function foreignPlaceholderId(state: ChatState): string | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index]

    if (id && isForeignPlaceholder(state.items[id])) {
      return id
    }
  }

  return undefined
}

/**
 * `inflight.user`, read the way the transcript shows it.
 *
 * The raw text of a turn's opening row is NOT what the transcript draws. A
 * scheduled job's report is a card keyed on the job's name and body
 * (ADR-0013), and a teammate's message is a tinted bubble holding only the body
 * under its `Message from 🤖 <name> (@<handle>):` signature (ADR-0009). So both
 * the comparison key and the item a resume projects are derived here, by the
 * same parsers `rows-to-items` uses on the persisted row — otherwise the two
 * describe one turn in two different shapes, the comparison misses, and the
 * turn is painted twice.
 *
 * `raw` is kept because "was there a prompt at all" is a question about the
 * payload, not about the parse.
 */
type InflightPrompt = {
  raw: string
  /** `normalizedItemText` of the item this prompt would become. */
  key: string
  /**
   * `attachmentsMatchKey` of the references the prompt itself names, and empty
   * when it names none — which is not the same as carrying none. An image is
   * attached out of band, so a turn can carry one the prompt says nothing about;
   * see `resumeOverlap` for why that makes this a one-sided check.
   */
  carried: string
  /** Those references themselves, for the item this prompt projects to. */
  refs?: string[]
  /** The words a bubble would show: the prompt with every wrapper taken off. */
  speech?: string
  kind: UserRowClass['kind']
  cron?: ParsedCronDelivery
  incoming?: IncomingBotMessage
  injected?: InjectedRow
}

/**
 * Read `inflight.user` through the SAME classifier the persisted row goes
 * through.
 *
 * Anything that is not a real message must not be drawn as one, and LIVE is where
 * that used to fail. The persisted row carries a `display_kind` and
 * `rows-to-items` has always read it; `inflight.user` carries the text and
 * nothing else, so this side had a second copy of the chain — and the copies
 * disagreed. A fan-out's report reached the screen as a blue bubble opening
 * `[ASYNC DELEGATION BATCH COMPLETE — …]`, signed by the owner; a teammate's
 * answer, which arrives as a background-process report, did the same for longer.
 * `classifyUserRow` is now the only chain, so a shape recognised on one path
 * cannot be missed on the other.
 *
 * What is left here is what only this side knows: the comparison key, which is
 * `normalizedItemText` of the item the prompt would become.
 */
function readInflightPrompt(userText: string): InflightPrompt {
  const classified = classifyUserRow(userText)

  switch (classified.kind) {
    case 'cron_delivery':
      return {
        raw: userText,
        key: normalizeMatchText(`${classified.cron.jobName}\n${classified.cron.body}`),
        carried: '',
        kind: 'cron_delivery',
        cron: classified.cron
      }

    case 'bot_dm_in':
      return {
        raw: userText,
        key: normalizeMatchText(classified.incoming.body),
        carried: '',
        kind: 'bot_dm_in',
        incoming: classified.incoming
      }

    case 'bot_dm_reply':
      // The key is the raw report, which nothing on screen can match: a delivery
      // report projects no item at all, so there is nothing for it to pair with.
      return { raw: userText, key: normalizeMatchText(userText), carried: '', kind: 'bot_dm_reply' }

    case 'notice':
      return {
        raw: userText,
        key: normalizeMatchText(classified.injected.body),
        carried: '',
        kind: 'notice',
        injected: classified.injected
      }

    default:
      return {
        raw: userText,
        key: normalizeMatchText(classified.text),
        carried: attachmentsMatchKey(classified.attachments),
        ...(classified.attachments ? { refs: classified.attachments } : {}),
        speech: classified.text,
        kind: 'user'
      }
  }
}

/**
 * How much of a resume's `inflight` the transcript is already showing.
 *
 * A resume answers with two overlapping truths: the gateway's live view of a
 * turn, and the rows it has already written. The user's prompt is normally in
 * BOTH, because the gateway persists that row at submit time
 * (`_persist_submit_user_row`) rather than when the turn ends — so projecting it
 * on top of the bubble standing for it is how one sent message came back as two,
 * one stamped when it was typed and one when the chat was resumed.
 *
 * Matching the newest prompt is not enough on its own: the user may deliberately
 * send the same words again, and another client may have sent them while we were
 * away. What tells those apart is the reply between them — a durable reply after
 * the matching prompt means that turn is finished, so the `inflight` is a NEW
 * turn and gets its own bubble — unless the reply is the `inflight`'s own
 * assistant text, which is the gateway holding a finished turn replayable (a
 * retained failure) and describing what the transcript already shows.
 *
 * ## Unless the turn WROTE that reply
 *
 * "A reply after the prompt ends the turn" is true of a turn that answers once.
 * A session with interim assistant messages on does not: `_interim_assistant_cb`
 * seals a mid-turn note, the gateway persists it as its own assistant row, and
 * the turn goes on working. Refresh at that moment and the tail reads prompt,
 * reply — which the rule above called a finished turn, so the still-running
 * turn's `inflight.user` was projected a SECOND time, below the note. That is
 * the report: a pasted terminal command in the chat twice, minutes apart, with
 * one row for it in the gateway's database.
 *
 * `turnStartedAt` is what tells the two shapes apart, and it is a fact rather
 * than a guess: a reply stamped at or after the running turn began was written
 * BY that turn, so it says nothing about the turn being over. A reply stamped
 * before it belongs to the turn that ended, and the `inflight` really is new.
 * Both numbers are Unix seconds off the same gateway clock — the row's
 * `timestamp` and `SessionLiveInfo.turn_started_at` — so the comparison needs no
 * tolerance and no local clock.
 *
 * When the gateway names no start (an older one, or a turn it does not call
 * running) the old rule stands unchanged. That is deliberate: without a start
 * there is nothing to place the reply against, and guessing "still the same
 * turn" would swallow the case the cron suite pins down — an hourly job whose
 * body has not changed, delivered again after the previous run was answered.
 *
 * `replyPersisted` stays the narrow claim it was. A note sealed mid-turn is not
 * the retained failure that flag means, so the turn's live text gets its own
 * bubble under the note rather than settling onto it.
 *
 * The attachments are compared only when BOTH sides name one, which is the one
 * place in reconciliation where that tolerance is needed. `inflight.user` is the
 * submitted BODY rather than the persisted row: a file is in it, so a file-only
 * prompt — which has no words to be told apart by — is compared properly, while
 * an image never is, and insisting on a set the body cannot carry would paint
 * every image send twice on resume.
 */
function resumeOverlap(
  state: ChatState,
  prompt: InflightPrompt,
  assistantText: string,
  turnStartedAt: number | undefined
): { promptShown: boolean; replyPersisted: boolean } {
  const shown = shownTurn(state)
  const { raw, key: promptKey, carried } = prompt
  const sameAttachments = !carried || !shown.carried || carried === shown.carried
  const promptShown = Boolean(raw) && shown.authored !== undefined && shown.authored === promptKey && sameAttachments

  if (!promptShown) {
    return { promptShown: false, replyPersisted: false }
  }

  if (shown.settledReply === undefined) {
    return { promptShown: true, replyPersisted: false }
  }

  if (shown.settledReply === normalizeMatchText(assistantText)) {
    return { promptShown: true, replyPersisted: true }
  }

  const wroteItself =
    turnStartedAt !== undefined && shown.settledReplyTs !== undefined && shown.settledReplyTs >= turnStartedAt

  return { promptShown: wroteItself, replyPersisted: false }
}

/** The un-persisted assistant bubble this turn is filling, if it has one. */
function liveAssistantOfCurrentTurn(state: ChatState): AssistantItem | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.items[state.order[index] ?? '']

    if (item?.kind !== 'assistant') {
      continue
    }

    return item.rowId === undefined ? item : undefined
  }

  return undefined
}

/**
 * Rebuild the in-flight tail from `session.resume`. Everything it adds carries
 * `origin: 'inflight'` so a later reconcile can replace it with the persisted
 * rows without leaving a duplicate behind.
 *
 * What it adds is only what the transcript does not already show. A resume lands
 * on a chat that has been streaming the very turn it describes — and on a cold
 * open whose history already carries that turn's prompt — so both halves of the
 * projection settle onto the items standing for them rather than beside them.
 */
export function applyResumeSnapshot(state: ChatState, snapshot: ResumeSnapshot, now: number = Date.now()): ChatState {
  let next = editable(state)
  const inflight = rec(snapshot.inflight)
  const userText = str(inflight.user).trim()
  const assistantText = str(inflight.assistant)
  const prompt = readInflightPrompt(userText)
  // `running` is the one field the contract models as "is this turn still
  // going", and the same one `turn.active` is set from at the bottom of this
  // function. `inflight` carries no status a running turn ever reports —
  // `inflight.status` only speaks up to say `interrupted` — and
  // `inflight.streaming` is false between two segments of a turn that has not
  // stopped.
  const running = snapshot.running === true
  // Only a RUNNING turn has a start worth comparing against; on a stopped one
  // the gateway's number is the last turn's and would date rows into a turn
  // that is over. `state.info` is the same `SessionLiveInfo` the resume carried,
  // dispatched as `session.info` a step before this one, which is why a caller
  // that forwards only the top-level field still gets the comparison.
  const turnStartedAt = running ? (num(snapshot.turn_started_at) ?? num(next.info?.turn_started_at)) : undefined
  const overlap = resumeOverlap(next, prompt, assistantText, turnStartedAt)

  // Either way, the resume has named the author of the newest turn, and the
  // placeholder exists only because `message.start` could not. It is filled
  // below when the prompt is new to us; when the prompt is already on screen
  // there is nothing left for it to become, and a blank bubble between a cron
  // card and its reply is a row the reader has to explain to themselves.
  const placeholder = userText ? foreignPlaceholderId(next) : undefined
  /*
    A delivery report opens a turn, and projects nothing.

    The teammate's answer inside it belongs on the dispatch that asked for it, and
    a resume cannot make that join: the dispatch is a tool row this snapshot says
    nothing about, and it may not even be on screen. So this side stays quiet and
    leaves the row to the tail fetch, which has the whole transcript to join
    against. What must NOT happen is the fall-through that used to: the report
    painted as the owner's own bubble, headers, command line, teammate's reply and
    all.
  */
  const projectable = prompt.kind !== 'bot_dm_reply'

  if (userText && projectable && !overlap.promptShown) {
    // The turn a resume finds running may be a scheduled job's or a teammate's,
    // not the owner's. Projecting all three here rather than only in
    // `rows-to-items` is what keeps the invariant: a delivery renders as the
    // same card, and a teammate's message as the same tinted bubble, whether the
    // chat was open when it landed or loaded from history afterwards.
    const draft: AnyNewItem =
      prompt.kind === 'cron_delivery' && prompt.cron
        ? {
            id: `i:${next.turn.nextSeq}`,
            kind: 'cron_delivery',
            jobName: prompt.cron.jobName,
            ...(prompt.cron.nameRedacted ? { nameRedacted: true } : {}),
            body: prompt.cron.body,
            shape: prompt.cron.shape,
            ts: now / 1000
          }
        : prompt.kind === 'bot_dm_in' && prompt.incoming
          ? {
              id: `i:${next.turn.nextSeq}`,
              kind: 'bot_dm_in',
              senderName: prompt.incoming.senderName,
              ...(prompt.incoming.senderHandle ? { senderHandle: prompt.incoming.senderHandle } : {}),
              text: prompt.incoming.body,
              ts: now / 1000
            }
          : prompt.kind === 'notice' && prompt.injected
            ? {
                id: `i:${next.turn.nextSeq}`,
                kind: 'notice',
                noticeKind: prompt.injected.noticeKind,
                title: prompt.injected.title,
                body: prompt.injected.body,
                ts: now / 1000
              }
            : {
                id: `i:${next.turn.nextSeq}`,
                kind: 'user',
                text: prompt.speech ?? '',
                // The references too, for the same reason the projection lifts them
                // out of the text: without them a prompt that was nothing but a
                // file resumes as an empty bubble, and the row that lands for it has
                // nothing to pair with and becomes a second one.
                ...(prompt.refs ? { attachments: prompt.refs } : {}),
                ts: now / 1000
              }

    // Filling the placeholder rather than appending is the whole point:
    // appended, the prompt would sit BELOW the reply it started, because the
    // placeholder is already above the streaming bubble.
    if (placeholder) {
      recastItem(next, placeholder, draft, 'inflight')
    } else {
      addAnyItem(next, draft, 'inflight')
    }
  } else if (placeholder) {
    dropItem(next, placeholder)
  }

  if (placeholder) {
    // Nothing is waiting for an author any more. The flag is diagnostics only —
    // the tail fetch is scheduled by the caller — but a report that says "tail
    // pending" with no placeholder to fill is a report that misleads.
    next.turn.foreignReconcilePending = undefined
  }

  const inflightStatus = str(inflight.status)
  const inflightError = str(inflight.error).trim()
  const failure = inflightError
    ? {
        message: inflightError,
        partial: Boolean(assistantText),
        ...(inflight.recoverable === true ? { recoverable: true } : {})
      }
    : undefined

  // A durable row already carrying this reply needs nothing added to it; the
  // `live` branch below covers the bubble a stream is still filling.
  if ((assistantText || failure) && !overlap.replyPersisted) {
    const live = liveAssistantOfCurrentTurn(next)

    if (!live) {
      const item = addItem<AssistantItem>(
        next,
        {
          id: `i:${next.turn.nextSeq}`,
          kind: 'assistant',
          text: assistantText,
          streaming: inflight.streaming === true,
          interim: false,
          ...(failure
            ? { status: 'error' as const, error: failure }
            : inflightStatus === 'interrupted'
              ? { status: 'interrupted' as const }
              : {}),
          ts: now / 1000
        },
        'inflight'
      )

      if (inflight.streaming === true) {
        next.turn.assistantId = item.id
      }
    } else {
      // `inflight.assistant` is this turn's reply flattened to one string, and
      // the bubble on screen is that same reply — so it settles onto it. A
      // bubble a tool call already SEALED holds one segment of that flat
      // string, never the whole of it, so its text is left alone and only the
      // verdict lands: repainting it would show the segment twice.
      const sealed = live.interim

      patchItem<AssistantItem>(next, live.id, draft => {
        if (!sealed) {
          if (assistantText.length > draft.text.length) {
            draft.text = assistantText
          }

          draft.streaming = inflight.streaming === true
        }

        if (failure) {
          draft.status = 'error'
          draft.error = failure
        } else if (inflightStatus === 'interrupted' && !sealed) {
          draft.status = 'interrupted'
        }
      })

      if (inflight.streaming === true && !sealed) {
        next.turn.assistantId = live.id
      }
    }
  }

  if (running) {
    next.turn.active = true
    next.turn.startedAt = next.turn.startedAt ?? now
  }

  const queued = str(rec(snapshot.queued).user).trim()

  if (queued) {
    next.queued = { text: queued }
  }

  const todoState = rec(snapshot.todo_state)

  if (Array.isArray(todoState.todos)) {
    next.todo = { todos: todoState.todos, revision: num(todoState.revision) ?? 0 }
  }

  const pending = rec(snapshot.pending_approval)

  if (str(pending.request_id) || str(pending.command)) {
    // `pending_approval` is a queue entry, not a live server request: synthesize
    // a request id from it so the sheet can be rebuilt and later cancelled.
    const requestId = `pending:${str(pending.request_id) || 'approval'}`

    next = applyServerRequest(next, { id: requestId, method: 'approval', params: pending, replayed: true }, now)
    next = editable(next)
  }

  for (const request of snapshot.open_requests ?? []) {
    next = applyServerRequest(next, { ...request, replayed: true }, now)
    next = editable(next)
  }

  next.hydration = 'live'

  return next
}

/**
 * Paint the user's own message before the gateway has echoed it.
 *
 * `text` is the body as submitted, and the body is not what the row will look
 * like: the gateway stores the prompt verbatim — `@file:` and `@image:`
 * directives included — and `stripUserText` lifts those directives out of the
 * text into `attachments` on the way back. Painting the raw body left the bubble
 * holding a different string from its own row, and since the two are paired on
 * what they say, every send carrying a file came back as a second bubble. So the
 * optimistic item goes through the SAME projection a persisted row does.
 *
 * `attachments` are REFERENCE strings, the same contract `UserItem.attachments`
 * holds everywhere (`@file:…` / `@image:…`), not display names — and a turn that
 * carries one is paired on it as well as on its text, which is the only thing
 * left when the send had no words at all. A caller that passed a friendlier name
 * here instead left the bubble and its row with nothing in common, which is how a
 * file sent with no text came back as a second bubble.
 *
 * `author` is the reader's own identity, when the caller has one to give — the
 * same shape the persisted row will eventually carry (`MessageAuthor`). Passing
 * it here means the bubble does not change silhouette the moment its row lands:
 * `mergeWithLive` prefers the fresh row's author, but until that arrives the
 * optimistic item should already say what the row will say. No caller wires
 * this through yet; it is here so the one that does needs no reducer change.
 */
export function beginLocalTurn(
  state: ChatState,
  text: string,
  attachments?: string[],
  now: number = Date.now(),
  author?: MessageAuthor
): ChatState {
  const next = editable(state)
  const projected = stripUserText(text)
  const refs = mergeAttachmentRefs(projected.attachments, attachments)

  addItem<UserItem>(
    next,
    {
      id: `o:${next.turn.nextSeq}`,
      kind: 'user',
      text: projected.text,
      ...(refs?.length ? { attachments: refs } : {}),
      ...(author ? { author } : {}),
      pending: true,
      ts: now / 1000
    },
    'optimistic'
  )

  next.turn.local = true
  next.turn.active = true
  next.turn.startedAt = now
  next.turn.interrupted = false
  next.draft = ''

  return next
}

/**
 * Paint a steer as the user turn it is, into the turn already running.
 *
 * `session.steer` is not `prompt.submit` and the difference is the whole reason
 * this is its own function. A steer hands text to the agent with its next tool
 * result; it starts no turn, so nothing here may touch `turn.active`,
 * `turn.local` or `turn.startedAt` — the running turn owns all three, and
 * claiming them made the steer look like the turn it was folded into.
 *
 * What it does owe the reader is the bubble. The message was taken out of the
 * queue strip to send it, so with no bubble painted the words leave the screen
 * and nothing arrives: on build 176 that read as "the message vanished".
 *
 * `pending` is deliberately NOT set. A pending bubble means "parked behind the
 * running turn", which is what the queue strip already said and what this
 * message stopped being. `displayKind: 'steer'` is the same value the gateway
 * projects on a persisted steer row, so if this gateway does write one, the
 * reconcile pairs the two on text (`matchKeyOf`) and the row simply adopts this
 * item's id — and if it does not, the bubble stands on its own.
 */
export function beginSteer(
  state: ChatState,
  text: string,
  attachments?: string[],
  now: number = Date.now()
): ChatState {
  const next = editable(state)
  const projected = stripUserText(text)
  const refs = mergeAttachmentRefs(projected.attachments, attachments)

  addItem<UserItem>(
    next,
    {
      id: `o:${next.turn.nextSeq}`,
      kind: 'user',
      text: projected.text,
      ...(refs?.length ? { attachments: refs } : {}),
      displayKind: 'steer',
      ts: now / 1000
    },
    'optimistic'
  )

  return next
}

/**
 * Take a steer's bubble back off the screen.
 *
 * The gateway refused it — `rejected`, or the RPC threw — and the message is
 * going back into the queue strip, which is where the reader will look for it.
 * Leaving the bubble would show the same words in two places and claim a
 * correction the agent never heard.
 *
 * It removes the NEWEST optimistic steer whose text matches, and nothing else:
 * a steer that the tail reconcile has already paired with a persisted row is no
 * longer `optimistic`, and a row the gateway wrote is not ours to delete.
 */
export function dropSteer(state: ChatState, text: string): ChatState {
  const wanted = stripUserText(text).text

  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index]
    const item = id ? state.items[id] : undefined

    if (item?.kind === 'user' && item.origin === 'optimistic' && item.displayKind === 'steer' && item.text === wanted) {
      const next = editable(state)

      dropItem(next, item.id)

      return next
    }
  }

  return state
}

/**
 * Every attachment a locally submitted turn carries, once.
 *
 * Two sources, because a prompt can only name one of the two kinds. A file
 * reaches the agent BY being named in the text (`@file:<path>`), so the
 * projection has it, byte for byte what the persisted row will repeat. An image
 * goes over `image.attach_bytes` and is never in the prompt at all, so only the
 * caller can say it is there. Projected first: those are the ones the row agrees
 * with exactly, and neither source may swallow the other — a send with a file and
 * an image carries both.
 */
function mergeAttachmentRefs(projected?: string[], supplied?: string[]): string[] | undefined {
  const byKey = new Map<string, string>()

  for (const ref of [...(projected ?? []), ...(supplied ?? [])]) {
    const key = attachmentsMatchKey([ref])

    if (!byKey.has(key)) {
      byKey.set(key, ref)
    }
  }

  return byKey.size ? [...byKey.values()] : undefined
}

function lastOptimisticUserId(state: ChatState): string | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index]
    const item = id ? state.items[id] : undefined

    if (item?.kind === 'user' && item.origin === 'optimistic') {
      return item.id
    }
  }

  return undefined
}

/** Settle the optimistic turn against `prompt.submit`'s answer. */
export function confirmSubmit(state: ChatState, result: SubmitResult, now: number = Date.now()): ChatState {
  const id = lastOptimisticUserId(state)

  if (!id) {
    return state
  }

  const next = editable(state)
  const status = str(result.status)

  patchItem<UserItem>(next, id, draft => {
    draft.pending = status === 'queued'

    if (status === 'steered') {
      draft.displayKind = 'steer'
    }
  })

  if (status === 'queued') {
    const item = next.items[id]

    next.queued = { text: item?.kind === 'user' ? item.text : '', local: true }
    // A queued prompt does not start a turn of its own; the running one owns it.
    next.turn.active = state.turn.active
  } else if (status === 'steered' || status === 'redirected') {
    // Steer / redirect fold into the turn already running.
    next.turn.startedAt = next.turn.startedAt ?? now
  }

  return next
}

/** The user pressed Stop: keep the partial reply, stop claiming the turn runs. */
export function markInterrupted(state: ChatState, now: number = Date.now()): ChatState {
  const next = editable(state)
  const id = next.turn.assistantId

  if (id && next.items[id]?.kind === 'assistant') {
    patchItem<AssistantItem>(next, id, draft => {
      draft.streaming = false
      draft.status = 'interrupted'

      if (next.turn.startedAt) {
        draft.durationS = (now - next.turn.startedAt) / 1000
      }
    })
  }

  // Stop bumps the gateway's queue generation, and a submit that threw never
  // reached the queue at all — so nothing of ours is parked any more. A bubble
  // left marked `pending` would make the next turn a teammate starts read as
  // that prompt's, and the reader would never be told who really spoke.
  for (const id of next.order) {
    const item = next.items[id]

    if (item?.kind === 'user' && item.pending === true) {
      patchItem<UserItem>(next, id, draft => {
        draft.pending = false
      })
    }
  }

  next.queued = undefined
  next.turn.local = false
  next.turn.active = false
  next.turn.interrupted = true
  next.turn.assistantId = undefined
  next.turn.draftingTool = undefined

  return next
}

/** Join a `process_complete` payload onto the dispatch that spawned it. */
export function applyProcessCompletion(state: ChatState, text: string, now: number = Date.now()): ChatState {
  const blocks = parseProcessCompleteText(text)

  if (!blocks.length) {
    return state
  }

  const next = editable(state)

  for (const block of blocks) {
    const id = next.byProcessId[block.sid]

    if (!id) {
      continue
    }

    const outcome = replyFromDeliveryOutput(block.output)

    patchItem<BotDmOutItem>(next, id, draft => {
      draft.reply = {
        text: outcome.text ?? '',
        ts: now / 1000,
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.reason ? { reason: outcome.reason } : {})
      }

      if (outcome.error) {
        draft.dispatch = { ...draft.dispatch, status: 'failed', error: outcome.error }
      }
    })
  }

  return next
}

/** One `subagent.list` row, as thin as the reconcile needs it. */
export interface SubagentSnapshotRow {
  subagent_id: string
  parent_id?: string | null
  depth?: number | null
  goal?: string | null
  delegation_id?: string | null
  model?: string | null
  started_at?: number | null
  status?: string | null
  tool_count?: number | null
  last_tool?: string | null
  accepting_steer?: boolean | null
  child_session_id?: string | null
}

/**
 * Fold a `subagent.list` snapshot into the chat.
 *
 * The `subagent.*` events are a stream, and a chat opened halfway through a
 * delegation missed the beginning of it — there is no replay for children. The
 * snapshot is the roster the gateway can still describe, so it CREATES children
 * the events never announced and refreshes the ones they did.
 *
 * It deliberately does not remove anything: a child the gateway has forgotten
 * (it only lists live ones) has usually just finished, and dropping the row
 * would erase the summary the reader is looking at.
 */
export function applySubagentSnapshot(
  state: ChatState,
  rows: readonly SubagentSnapshotRow[],
  now: number = Date.now()
): ChatState {
  if (!rows.length) {
    return state
  }

  const next = editable(state)
  let changed = false

  for (const row of rows) {
    const payload: Record<string, unknown> = {
      subagent_id: row.subagent_id,
      parent_id: row.parent_id ?? null,
      goal: row.goal ?? '',
      delegation_id: row.delegation_id ?? '',
      model: row.model ?? '',
      status: row.status ?? 'running',
      ...(row.depth !== null && row.depth !== undefined ? { depth: row.depth } : {}),
      ...(row.tool_count !== null && row.tool_count !== undefined ? { tool_count: row.tool_count } : {}),
      ...(row.last_tool ? { tool_name: row.last_tool } : {}),
      ...(row.child_session_id ? { child_session_id: row.child_session_id } : {})
    }

    const childId = subagentIdOf(payload)
    const prev = next.subagents[childId]

    if (prev && TERMINAL_SUBAGENT_STATUS.has(prev.status)) {
      // The stream already saw this child finish; the roster is behind.
      continue
    }

    // `subagent.list` is a roster, not a progress frame: it carries no stream
    // line to append, so it is applied as a plain `start`-shaped update.
    const child = toSubagent(payload, prev, 'subagent.start', prev?.startedAt ? prev.updatedAt : now)
    const startedAt = prev?.startedAt ?? millisecondsOf(row.started_at) ?? child.startedAt

    next.subagents[childId] = {
      ...child,
      startedAt,
      ...(row.accepting_steer !== null && row.accepting_steer !== undefined
        ? { acceptingSteer: row.accepting_steer }
        : {})
    }

    changed = true

    const groupId = groupForSubagent(next, child.delegationId, child.goal, now)

    patchItem<SubagentGroupItem>(next, groupId, draft => {
      if (!draft.rootIds.includes(childId)) {
        draft.rootIds = [...draft.rootIds, childId]
      }

      if (child.goal && !draft.goals.includes(child.goal)) {
        draft.goals = [...draft.goals, child.goal]
      }

      if (child.delegationId && !draft.delegationId) {
        draft.delegationId = child.delegationId
      }
    })
    refreshGroup(next, groupId)
  }

  return changed ? next : state
}

/**
 * `started_at` on a roster row is unix SECONDS, while `Subagent.startedAt` is
 * the millisecond clock the events are stamped with. A value already past the
 * year-5138 mark in seconds is milliseconds somebody forgot to divide.
 */
function millisecondsOf(value: number | null | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined
  }

  return value > 1e11 ? value : value * 1000
}
