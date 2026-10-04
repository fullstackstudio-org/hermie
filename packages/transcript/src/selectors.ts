/**
 * Read-time views over `ChatState`.
 *
 * Verbosity and the bot-to-bot toggle live here and nowhere else: the reducer
 * always keeps the full truth, so flipping a toggle never loses history and
 * never needs a re-hydration.
 *
 * A demoted item is never removed. Hiding a DM would make the bot's own reply
 * unexplainable, so `showBotToBot: false` collapses DM traffic to a one-line
 * chip instead.
 */
import {
  type ChatState,
  isRequestLikeItem,
  type RequestLikeItem,
  type Subagent,
  type StatusItem,
  type TranscriptItem,
  type Verbosity
} from './types'

export type Presentation = 'full' | 'collapsed' | 'chip' | 'hidden-placeholder'

export interface VisibleItem {
  item: TranscriptItem
  presentation: Presentation
}

export interface VisibilityOptions {
  level: Verbosity
  showBotToBot: boolean
  showThinking: boolean
}

/**
 * Cheap change key for memoization: every mutation bumps an item's `version`,
 * so a changed sum means a changed transcript. Callers are expected to memoize
 * `visibleItems` on `(itemsVersion(state), options)` — this module does not
 * cache, so it stays free of hidden state.
 */
export function itemsVersion(state: ChatState): number {
  let sum = state.order.length

  for (const id of state.order) {
    sum += state.items[id]?.version ?? 0
  }

  return sum
}

const isRunningTool = (item: TranscriptItem): boolean =>
  item.kind === 'tool' && (item.status === 'running' || item.status === 'generating')

export function visibleItems(state: ChatState, options: VisibilityOptions): VisibleItem[] {
  const { level, showBotToBot, showThinking } = options
  const out: VisibleItem[] = []

  let latestStatusId: string | undefined
  let lastRunningToolId: string | undefined

  for (const id of state.order) {
    const item = state.items[id]

    if (!item) {
      continue
    }

    if (item.kind === 'status') {
      latestStatusId = id
    }

    if (isRunningTool(item)) {
      lastRunningToolId = id
    }
  }

  for (const id of state.order) {
    const item = state.items[id]

    if (!item) {
      continue
    }

    switch (item.kind) {
      case 'approval':
      case 'clarify':
      case 'request':
        // A question for the user is never filtered away.
        out.push({ item, presentation: 'full' })
        break

      case 'user':
        if (item.unknownAuthor && !item.text.trim()) {
          out.push({ item, presentation: 'hidden-placeholder' })
          break
        }

        out.push({ item, presentation: 'full' })
        break

      case 'bot_dm_in':
      case 'bot_dm_out':
        /*
          ONE rule for both directions, `collapsed` and never `full`, at every
          level.

          A bot-to-bot row is drawn as an ASIDE — the silhouette a reply's
          thoughts have — and an aside starts closed whatever the verbosity. The
          reader opens one by tapping it, and the tap is remembered per row.
          `verbose` used to open the inbound ones, which put a teammate's whole
          message on screen for a reader who had turned verbosity up to see tool
          calls.

          The two used to have a case each, and they disagreed. `quiet` — the
          DEFAULT level — demoted a dispatch to a chip reading `Message to
          @writer` while the answer to it stayed an aside beside it, so the
          owner's report was about the one shape the shared design had not
          reached. A direction is not a verbosity: the same traffic gets the same
          row whichever way it went.

          The toggle still demotes rather than hides (ADR-0009): a DM the reader
          cannot see at all makes the bot's own reply unexplainable.
        */
        out.push({ item, presentation: showBotToBot ? 'collapsed' : 'chip' })
        break

      case 'cron_delivery':
        /**
         * A cron delivery survives `quiet`, and the bot-to-bot toggle does not
         * touch it.
         *
         * It is the RESULT of something the owner scheduled — the reason they
         * opened the chat — so dropping it at `quiet` would hide the one row they
         * came for, which is the same rule that keeps `user` and `assistant`
         * visible at every level. `quiet` folds the report instead of losing it.
         *
         * And it is not bot-to-bot traffic: the scheduler is not a peer bot, so
         * `showBotToBot: false` — which exists to quieten agents talking amongst
         * themselves — has no business demoting it to a chip.
         */
        out.push({ item, presentation: level === 'quiet' ? 'collapsed' : 'full' })
        break

      case 'subagent_group':
        out.push({
          item,
          presentation: !showBotToBot || level === 'quiet' ? 'chip' : level === 'verbose' ? 'full' : 'collapsed'
        })
        break

      case 'assistant': {
        /*
          The copy is made only when there is a thought to take away. Stripping
          unconditionally rebuilt every assistant row in the transcript on every
          call — and this runs on every version bump, so on a four-hundred-row
          conversation that is four hundred allocations per streamed frame for
          rows that never had a `reasoning` to lose.
        */
        const hasThought = item.reasoning !== undefined || item.reasoningVerbose !== undefined
        const shown =
          showThinking || !hasThought ? item : { ...item, reasoning: undefined, reasoningVerbose: undefined }
        // A reply that shares a file has something to show, whatever it says (`contract/outbox/`).
        const empty = !item.text.trim() && !item.error && !item.outbox?.length

        if (empty && (!showThinking || !item.reasoning?.trim() || level === 'quiet')) {
          break
        }

        if (item.error) {
          // An error card is always visible, at every level.
          out.push({ item: shown, presentation: 'full' })
          break
        }

        out.push({ item: shown, presentation: empty ? 'collapsed' : 'full' })
        break
      }

      case 'tool':
        if (level === 'quiet') {
          if (id === lastRunningToolId) {
            // One "working" row stands in for the whole tool stream.
            out.push({ item, presentation: 'hidden-placeholder' })
          }

          break
        }

        out.push({ item, presentation: level === 'verbose' ? 'full' : 'collapsed' })
        break

      case 'status':
        if (level === 'verbose') {
          out.push({ item, presentation: 'full' })
          break
        }

        if (id !== latestStatusId) {
          break
        }

        if (level === 'quiet' && !state.turn.active) {
          break
        }

        out.push({ item, presentation: 'chip' })
        break

      case 'notice':
        /*
          An error and a command answer are the two kinds no level may fold or
          drop.

          An error because a reader must not skim past it. A command answer
          because the owner TYPED the thing it answers: it is the payload of a
          request, in the same sense as the cron card below and the fan-out
          report further down (ADR-0013, amended), and a request whose answer is
          invisible at the level people leave the app on reads as a command that
          did nothing. `full` at every level, including `quiet`.
        */
        if (item.noticeKind === 'error' || item.noticeKind === 'command') {
          out.push({ item, presentation: 'full' })
          break
        }

        if (level === 'quiet') {
          if (item.noticeKind === 'reclaimed') {
            out.push({ item, presentation: 'chip' })
            break
          }

          /*
            Work the owner dispatched, reporting back.

            Same rule as the cron card above, for the same reason (ADR-0013,
            amended 2026-09-21): a fan-out's results and a background process's
            output are not the machine narrating itself — they are the PAYLOAD of
            something the owner started and then walked away from, which is
            usually the row they reopened the chat for. `quiet` folds the report
            rather than losing it.

            The rest of the family stays hidden, because the rest of the family is
            narration: a model switch, a compaction handoff, a kanban event, the
            roster refreshing. Nobody asked for those.
          */
          if (item.noticeKind === 'async_delegation_complete' || item.noticeKind === 'process_complete') {
            out.push({ item, presentation: 'collapsed' })
          }

          break
        }

        out.push({ item, presentation: level === 'verbose' ? 'full' : 'collapsed' })
        break
    }
  }

  return out
}

/**
 * Is a question waiting on a person in this chat?
 *
 * The predicate on its own, because THREE surfaces answer with it and they have
 * to agree: the chat list's bead, the widget file's `needsInput`, and the chat
 * header. It used to be written out three times — the same `.some(...)` over
 * `order`, byte for byte, in `BotsScreen`, `widgets/snapshot.ts` and, as a
 * length check, in `ChatScreen`. Three copies of a predicate is three places a
 * new request kind has to be remembered, and the one that is forgotten is a
 * chat that quietly stops asking for attention.
 *
 * It stops at the first open request rather than building the list, which is
 * what makes it cheap enough for a roster of forty on every store notification.
 */
export function hasOpenRequest(state: ChatState): boolean {
  return state.order.some(id => {
    const item = state.items[id]

    return isRequestLikeItem(item) && item.state === 'open'
  })
}

/** Every unanswered question, oldest first — the bottom sheets read this. */
export function openRequests(state: ChatState): TranscriptItem[] {
  return state.order
    .map(id => state.items[id])
    .filter((item): item is RequestLikeItem => isRequestLikeItem(item) && item.state === 'open')
}

export function runningSubagents(state: ChatState): Subagent[] {
  return Object.values(state.subagents).filter(child => child.status === 'running' || child.status === 'queued')
}

export interface SubagentNode extends Subagent {
  children: SubagentNode[]
}

/** Parent/child tree of this chat's subagents, ported from `buildSubagentTree`. */
export function subagentTree(state: ChatState): SubagentNode[] {
  const nodes = new Map<string, SubagentNode>()

  for (const child of Object.values(state.subagents)) {
    nodes.set(child.id, { ...child, children: [] })
  }

  const roots: SubagentNode[] = []

  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined

    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sort = (a: SubagentNode, b: SubagentNode) =>
    a.startedAt - b.startedAt || a.taskIndex - b.taskIndex || a.goal.localeCompare(b.goal)

  const walk = (node: SubagentNode) => {
    node.children.sort(sort)
    node.children.forEach(walk)
  }

  roots.sort(sort)
  roots.forEach(walk)

  return roots
}

export function latestStatus(state: ChatState): StatusItem | undefined {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const id = state.order[index]
    const item = id ? state.items[id] : undefined

    if (item?.kind === 'status') {
      return item
    }
  }

  return undefined
}

/** Is anything still running for this chat — the turn, a tool, or a child? */
export function isBusy(state: ChatState): boolean {
  if (state.turn.active || state.compacting) {
    return true
  }

  if (runningSubagents(state).length) {
    return true
  }

  return state.order.some(id => {
    const item = state.items[id]

    return Boolean(item && isRunningTool(item))
  })
}

/** The badge caps here; a number wider than the dot it replaces reads as noise. */
export const UNREAD_BADGE_CAP = 99

/**
 * How many messages arrived in this chat since the user last looked at it.
 *
 * Only what a reader would call "a message" counts: the bot's own replies to
 * them. Tool rows, notices, the user's own turns and bot-to-bot traffic are not
 * unread mail, and counting them would make a badge that never settles.
 *
 * `since` is the watermark the roster keeps (unix seconds). A chat the app has
 * not loaded has nothing to count, which is why the list still falls back to a
 * dot rather than showing a confident zero.
 */
export function unreadCountSince(state: ChatState, since: number): number {
  let count = 0

  for (const id of state.order) {
    const item = state.items[id]

    if (item && countsAsMessage(item) && (item.ts ?? 0) > since) {
      count += 1
    }
  }

  return count
}

/**
 * Is this row a message, for the purposes of a badge?
 *
 * One predicate rather than two copies of the same list: `unreadCountSince`
 * counts what is past the watermark and `lastMessageAt` says where the watermark
 * has to go to leave nothing behind it. If the two ever disagreed about what a
 * message is, a chat the reader is looking at would count one for ever.
 */
function countsAsMessage(item: TranscriptItem): boolean {
  /*
    Bot-to-bot traffic is NOT mail, so it never moves a badge.

    The owner's rule, in his words: *bot-to-bot must also not bump the
    notification badge.* `bot_dm_in` used to count — it is a message, and it is
    even addressed to this bot — but a badge answers one question, "is there
    something here for ME", and two agents working out a delivery between
    themselves is not. A bot that dispatches to a teammate every few seconds
    produced a chat list that was permanently shouting about work nobody had to
    look at, and a reader who opened it found nothing they had to do.

    `bot_dm_out` and `subagent_group` never counted, and this is where that
    stays written down: the three kinds are one rule, not one rule and two
    accidents of an `if` that happened to exclude them.

    It is only the COUNT. The rows are still in the transcript, still drawn, and
    `hasOpenRequest` is untouched: a question a teammate's work raised still asks
    for the reader, because somebody asked THEM.
  */
  if (item.kind !== 'assistant') {
    return false
  }

  // An empty or interim bubble is the turn in progress, not a message.
  return !item.interim && (item.text.trim() !== '' || Boolean(item.outbox?.length))
}

/**
 * When the newest message in this chat arrived, in unix seconds, or 0.
 *
 * Read backwards, because the answer is almost always the last row and walking
 * a whole transcript for it on every delta is a cost a long chat would feel.
 *
 * What it is FOR: a chat that is open and scrolled to the bottom is read, and
 * "read" has to be written as a watermark the unread count will then find
 * nothing past. Writing `now` alone is not enough — a gateway whose clock runs
 * ahead stamps a message in the reader's future, and the badge comes back.
 */
export function lastMessageAt(state: ChatState): number {
  for (let index = state.order.length - 1; index >= 0; index -= 1) {
    const item = state.items[state.order[index] ?? '']

    if (item && countsAsMessage(item)) {
      return item.ts ?? 0
    }
  }

  return 0
}

/** `3`, `99+` — the badge label, or an empty string when nothing is unread. */
export function unreadBadgeLabel(count: number): string {
  if (count <= 0) {
    return ''
  }

  return count > UNREAD_BADGE_CAP ? `${UNREAD_BADGE_CAP}+` : String(count)
}
